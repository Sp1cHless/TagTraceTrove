import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { syncReplayOperationSchema } from '@t3/shared';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
function fixture() {
 const db=createMigratedMemoryDatabase();
 const a=createEntry(db,{title:'A',type:'comic'}),b=createEntry(db,{title:'B',type:'comic'});
 const owner=(id:number)=>db.prepare('SELECT sync_uid AS uid,sync_version AS version FROM entries WHERE id=?').get(id) as {uid:string;version:number};
 const identity={clientId:'cross',...getSyncIdentity(db),entityKind:'entry',clientCreatedAt:'2026-10-03T00:00:00Z'};
 const producerUid='abcdefab-abcd-4abc-8abc-abcdefabcdef';
 const source=syncReplayOperationSchema.parse({...identity,opId:randomUUID(),entityUid:owner(a.id).uid,operationKind:'entry.author.create-and-link',baseVersion:owner(a.id).version,baseValues:{producerUids:[]},payload:{producerUid,name:'Cross Author'}});
 const target=syncReplayOperationSchema.parse({...identity,opId:randomUUID(),entityUid:owner(b.id).uid,operationKind:'entry.authors.set',baseVersion:owner(b.id).version,baseValues:{producerUids:[]},payload:{producerUids:[producerUid],producerCreates:[{producerUid,createOpId:source.opId}]}});
 const state=()=>({edges:db.prepare('SELECT * FROM entry_producers ORDER BY entry_id,producer_id').all(),journal:db.prepare('SELECT * FROM sync_changes ORDER BY seq').all(),receipts:db.prepare('SELECT * FROM sync_operation_receipts ORDER BY op_id').all()});
 return {db,a,b,source,target,producerUid,state};
}
it('canonical SQL dependency identity accepts legacy uppercase origins without rewriting exact retry hashes',()=>{
 const {db,source,target,state}=fixture();try {
  if(source.operationKind!=='entry.author.create-and-link'||target.operationKind!=='entry.authors.set') throw Error('fixture');
  source.entityUid=source.entityUid.toUpperCase();source.payload.producerUid=source.payload.producerUid.toUpperCase();
  const body=JSON.stringify(source),receipt=replaySyncOperation(db,source);expect(receipt.status).toBe('applied');
  // Legacy registry/Producer rows may be uppercase, even when newer dependencies are lowercase.
  db.prepare('UPDATE producers SET sync_uid=upper(sync_uid)').run();
  db.prepare('UPDATE sync_offline_created_producers SET producer_uid=upper(producer_uid),create_op_id=upper(create_op_id)').run();
  target.entityUid=target.entityUid.toUpperCase();target.payload.producerCreates![0]!.createOpId=source.opId.toUpperCase();
  expect(replaySyncOperation(db,target)).toMatchObject({status:'applied'});
  const before=state();expect(replaySyncOperation(db,source)).toEqual(receipt);expect(state()).toEqual(before);expect(JSON.stringify(source)).toBe(body);
  expect(replaySyncOperation(db,{...source,payload:{...source.payload,name:'Changed'}})).toMatchObject({status:'failed',errorCode:'operation-id-collision'});expect(state()).toEqual(before);
 }finally{db.close();}
});

it.each(['orphan','wrong-kind','producer-id','receipt-op-id','client','library','epoch'] as const)('atomically rejects forged causal identity: %s',reason=>{
 const {db,source,target,b,state}=fixture();try {
  const created=replaySyncOperation(db,source);if(created.status!=='applied') throw Error('source');
  if(target.operationKind!=='entry.authors.set') throw Error('target');
  if(reason==='orphan') db.exec('DELETE FROM sync_offline_created_producers');
  if(reason==='wrong-kind') {
   const wrong=syncReplayOperationSchema.parse({...source,opId:randomUUID(),operationKind:'entry.update',baseValues:{title:'A'},payload:{title:'A renamed'}});
   expect(replaySyncOperation(db,wrong).status).toBe('applied');target.payload.producerCreates![0]!.createOpId=wrong.opId;
  }
  if(reason==='producer-id'||reason==='receipt-op-id') db.prepare('UPDATE sync_operation_receipts SET result_json=? WHERE op_id=?').run(JSON.stringify({...created,...(reason==='producer-id'?{entityId:b.id}:{opId:randomUUID()})}),source.opId);
  if(reason==='client') target.clientId='foreign';
  if(reason==='library') target.libraryId='foreign';
  if(reason==='epoch') target.syncEpoch='foreign';
  const before=state();expect(replaySyncOperation(db,target).status).not.toBe('applied');expect(state()).toEqual(before);
 }finally{db.close();}
});

it.each(['positive','pending'].flatMap(kind=>['unseen-link','metadata','rollback','target-retry'].map(reason=>({kind,reason}))))('cross-owner complete-set SQL isolation: $kind $reason',({kind,reason})=>{
 const {db,source,target,b,state}=fixture();try {
  if(kind==='pending') {const created=syncReplayOperationSchema.parse({...source,opId:randomUUID(),entityUid:randomUUID(),operationKind:'entry.create',baseVersion:0,baseValues:{},payload:{title:'Pending B',type:'comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false}});const receipt=replaySyncOperation(db,created);if(receipt.status!=='applied'||!receipt.entityId||target.operationKind!=='entry.authors.set') throw Error('pending fixture');b.id=receipt.entityId;target.entityUid=created.entityUid;target.baseVersion=0;target.payload.parentCreateOpId=created.opId;}
  expect(replaySyncOperation(db,source).status).toBe('applied');
  if(reason==='unseen-link') {const id=Number(db.prepare('INSERT INTO producers(name) VALUES (?)').run('Unseen').lastInsertRowid);db.prepare('INSERT INTO entry_producers(entry_id,producer_id) VALUES (?,?)').run(b.id,id);}
  if(reason==='metadata') db.prepare('UPDATE entries SET title=? WHERE id=?').run('Disjoint title',b.id);
  if(reason==='rollback') db.exec(`CREATE TRIGGER abort_cross_receipt BEFORE INSERT ON sync_operation_receipts WHEN NEW.op_id='${target.opId}' BEGIN SELECT RAISE(ABORT,'forced cross rollback'); END`);
  const before=state();
  if(reason==='rollback') {expect(()=>replaySyncOperation(db,target)).toThrow('forced cross rollback');expect(state()).toEqual(before);}
  else if(reason==='unseen-link') {expect(replaySyncOperation(db,target).status).toBe('conflict');expect(state().edges).toEqual(before.edges);expect(state().journal).toEqual(before.journal);}
  else {const result=replaySyncOperation(db,target);expect(result.status).toBe('applied');const after=state();expect(replaySyncOperation(db,target)).toEqual(result);expect(state()).toEqual(after);
   if(reason==='metadata') expect(db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(b.id)).toBe('Disjoint title');
   if(reason==='target-retry'&&target.operationKind==='entry.authors.set') {expect(replaySyncOperation(db,{...target,payload:{...target.payload,producerUids:[]}})).toMatchObject({status:'failed',errorCode:'operation-id-collision'});expect(state()).toEqual(after);}
  }
 }finally{db.close();}
});
