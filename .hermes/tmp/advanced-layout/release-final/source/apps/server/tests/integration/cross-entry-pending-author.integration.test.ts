import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { inspectDatabase } from '../../src/database/doctor.js';
import { runDatabaseProbe } from '../../src/database/probe.js';
import { syncReplayOperationSchema } from '@t3/shared';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';

it('checks the causal Producer registry in disposable probe and doctor',()=>{
 const db=createMigratedMemoryDatabase();try {
  expect(runDatabaseProbe().checks).toContainEqual(expect.objectContaining({name:'offline Producer causal registry',passed:true}));
  expect(inspectDatabase(db).ok).toBe(true);db.exec('DROP TABLE sync_offline_created_producers');
  expect(inspectDatabase(db)).toMatchObject({ok:false,issues:expect.arrayContaining(['missing required table: sync_offline_created_producers'])});
 }finally{db.close();}
});
it('links a pending Producer to another synced Entry only after its matching creation receipt', () => {
 const db = createMigratedMemoryDatabase();
 try {
  const a = createEntry(db,{title:'A',type:'comic'}), b = createEntry(db,{title:'B',type:'comic'});
  const identity = {clientId:'cross',...getSyncIdentity(db),entityKind:'entry',clientCreatedAt:'2026-10-03T00:00:00Z'};
  const owner = (id:number) => db.prepare('SELECT sync_uid AS uid, sync_version AS version FROM entries WHERE id=?').get(id) as {uid:string;version:number};
  const au=owner(a.id),bu=owner(b.id),producerUid=randomUUID();
  const source=syncReplayOperationSchema.parse({...identity,opId:randomUUID(),entityUid:au.uid,operationKind:'entry.author.create-and-link',baseVersion:au.version,baseValues:{producerUids:[]},payload:{producerUid,name:'Shared pending'}});
  expect(syncReplayOperationSchema.safeParse({...source,operationKind:'entry.authors.set',payload:{producerUids:[producerUid,producerUid.toUpperCase()]}}).success).toBe(false);
  const target=syncReplayOperationSchema.parse({...identity,opId:randomUUID(),entityUid:bu.uid,operationKind:'entry.authors.set',baseVersion:bu.version,baseValues:{producerUids:[]},payload:{producerUids:[producerUid],producerCreates:[{producerUid,createOpId:source.opId}]}});
  expect(replaySyncOperation(db,target).status).toBe('failed');
  expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts WHERE op_id=?').pluck().get(target.opId)).toBe(0);
  const created=replaySyncOperation(db,source);expect(created.status).toBe('applied');
  db.exec('DELETE FROM sync_offline_created_producers');
  expect(replaySyncOperation(db,source)).toEqual(created);
  expect(replaySyncOperation(db,target)).toMatchObject({status:'applied',entityId:b.id});
  expect(db.prepare('SELECT COUNT(*) FROM producers WHERE sync_uid=?').pluck().get(producerUid)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM entry_producers').pluck().get()).toBe(2);
 } finally {db.close();}
});
it.each(['pending','positive','uppercase-snapshot'] as const)('facade reconciles %s source Author creation followed by unlink across targets', async (sourceKind) => {
 const db=createMigratedMemoryDatabase();
 try {
  if(sourceKind==='uppercase-snapshot') db.prepare('INSERT INTO entries(title,type,sync_uid) VALUES (?,?,?)').run('Seed','comic',randomUUID().toUpperCase());
  else createEntry(db,{title:'Seed',type:'comic'});
  const modules=['../../../web/src/offline/offline-api.js','../../../web/src/offline/snapshot-store.js','../../../web/src/offline/outbox-store.js','../../../web/src/offline/media-outbox-store.js'];
  const [facade,snapshots,outboxes,media]=await Promise.all(modules.map(path=>import(path)));
  const outbox=outboxes.createMemoryOutboxStore(),store={...snapshots.createMemorySnapshotStore(),...outbox,...media.createMemoryMediaOutboxStore((op:Parameters<typeof replaySyncOperation>[1])=>outbox.enqueue(op))};
  const {buildSyncCapabilities,buildSyncSnapshot}=await import('../../src/sync/sync-service.js');
  await store.writeGeneration(1,JSON.stringify(buildSyncSnapshot(db)));await store.writeMeta(snapshots.ACTIVE_GENERATION_KEY,'1');
  let lost=false;const sent:Array<{opId:string;body:string}>=[];
  const online={suggestProducers:async()=>{throw new TypeError('offline');},linkEntryAuthor:async()=>{throw new TypeError('offline');},getSyncCapabilities:async()=>buildSyncCapabilities(db,'test'),fetchSyncSnapshot:async()=>buildSyncSnapshot(db),replaySyncOperation:async(op:Parameters<typeof replaySyncOperation>[1])=>{sent.push({opId:op.opId,body:JSON.stringify(op)});const result=replaySyncOperation(db,op);if(!lost&&op.operationKind==='entry.author.create-and-link'){lost=true;throw new TypeError('committed response lost');}return result;}};
  const api=facade.createOfflineAwareGalleryApi(online,store,{clientId:'cross',randomUUID});await api.getSyncCapabilities({replay:false});
  const draft={title:'A',type:'comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null};
  const a=sourceKind==='pending' ? await api.enqueueOfflineEntryCreate(draft) : null;
  const created=sourceKind!=='pending' ? await api.linkEntryAuthorByName(1,'Cross Author') : null;
  const author=a ? await api.enqueueOfflinePendingEntryAuthorCreate(a.localKey,'Cross Author') : {producerUid:(await store.list())[0].payload.producerUid,name:'Cross Author'};
  const source=(await store.list()).find((row:{operationKind:string})=>row.operationKind==='entry.author.create-and-link');
  const b=await api.enqueueOfflineEntryCreate({...draft,title:'B'});
  expect((await api.getPendingOfflineEntryAuthorOptions(b.localKey)).authors).toContainEqual(author);
  await api.enqueueOfflinePendingEntryAuthors(b.localKey,[author.producerUid]);
  expect((await store.list()).at(-1).payload.producerCreates).toEqual([{producerUid:author.producerUid,createOpId:source.opId}]);
  const suggestions=await api.suggestProducers({q:'Cross'});
  const option=suggestions.find((row:{name:string})=>row.name===author.name);
  expect(option).toBeDefined();
  await api.linkEntryAuthor(1,option.id);
  if(a) await api.enqueueOfflinePendingEntryAuthors(a.localKey,[]);
  else await api.unlinkEntryAuthor(1,created.producerId);
  await api.enqueueOfflinePendingEntryAuthors(b.localKey,[]);
  await api.enqueueOfflinePendingEntryAuthors(b.localKey,[author.producerUid]);
  const before=await store.list();await api.flushOfflineOutbox();expect((await store.list()).map((row:{opId:string})=>row.opId)).toEqual(before.map((row:{opId:string})=>row.opId));
  const restart=facade.createOfflineAwareGalleryApi(online,store,{clientId:'cross',randomUUID});
  await restart.flushOfflineOutbox();expect(await store.list()).toEqual([]);
  const retries=sent.filter(row=>row.opId===source.opId);expect(retries).toHaveLength(2);expect(retries[0]?.body).toBe(retries[1]?.body);
  expect(db.prepare('SELECT COUNT(*) FROM entry_producers').pluck().get()).toBe(sourceKind==='pending'?2:1);
 } finally {db.close();}
});

it.each(['pending','positive'].flatMap(sourceKind=>['offlineMutations','offlineAuthorCreate','offlineEntryAuthors','offlinePendingEntryAuthorCreate','offlinePendingEntryAuthors','offlineCrossEntryPendingAuthors','failed','conflict','failed-replay','conflict-replay'].map(hold=>({sourceKind,hold}))))('holds both target chains for $sourceKind source on $hold',async({sourceKind,hold})=>{
 const db=createMigratedMemoryDatabase();try {
  createEntry(db,{title:'Seed',type:'comic'});createEntry(db,{title:'Synced target',type:'comic'});
  const modulePaths=['../../../web/src/offline/offline-api.js','../../../web/src/offline/snapshot-store.js','../../../web/src/offline/outbox-store.js','../../../web/src/offline/media-outbox-store.js'];
  const [facade,snapshots,outboxes,media]=await Promise.all(modulePaths.map(path=>import(path)));
  const {buildSyncCapabilities,buildSyncSnapshot}=await import('../../src/sync/sync-service.js');
  const outbox=outboxes.createMemoryOutboxStore(),store={...snapshots.createMemorySnapshotStore(),...outbox,...media.createMemoryMediaOutboxStore((op:Parameters<typeof replaySyncOperation>[1])=>outbox.enqueue(op))};
  await store.writeGeneration(1,JSON.stringify(buildSyncSnapshot(db)));await store.writeMeta(snapshots.ACTIVE_GENERATION_KEY,'1');
  const sent:Array<Parameters<typeof replaySyncOperation>[1]>=[];let downgraded=false;
  const online={suggestProducers:async()=>{throw new TypeError('offline');},linkEntryAuthorByName:async()=>{throw new TypeError('offline');},getSyncCapabilities:async()=>{const value=buildSyncCapabilities(db,'matrix');if(downgraded&&hold!=='failed'&&hold!=='conflict') Object.assign(value.featureFlags,{[hold]:false});return value;},fetchSyncSnapshot:async()=>buildSyncSnapshot(db),replaySyncOperation:async(op:Parameters<typeof replaySyncOperation>[1])=>{sent.push(op);if(op.operationKind==='entry.author.create-and-link'&&hold==='failed-replay') db.prepare('DELETE FROM entries WHERE sync_uid=?').run(op.entityUid);if(op.operationKind==='entry.author.create-and-link'&&hold==='conflict-replay') db.prepare('INSERT INTO producers(name) VALUES (?)').run(op.payload.name);return replaySyncOperation(db,op);}};
  const api=facade.createOfflineAwareGalleryApi(online,store,{clientId:'matrix',randomUUID});await api.getSyncCapabilities({replay:false});
  const draft={title:'A',type:'comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null};
  const a=sourceKind==='pending'?await api.enqueueOfflineEntryCreate!(draft):null;
  if(a) await api.enqueueOfflinePendingEntryAuthorCreate!(a.localKey,'Matrix Author');else await api.linkEntryAuthorByName(1,'Matrix Author');
  const source=(await store.list()).find((row:{operationKind:string})=>row.operationKind==='entry.author.create-and-link')!;const uid=String(source.payload.producerUid);
  const b=await api.enqueueOfflineEntryCreate!({...draft,title:'B'});await api.enqueueOfflinePendingEntryAuthors!(b.localKey,[uid]);
  const option=(await api.suggestProducers({q:'Matrix'})).find((row:{name:string;id:number})=>row.name==='Matrix Author')!;await api.linkEntryAuthor(2,option.id);
  // Later target edits must be held too, never leapfrog a blocked cross set.
  await api.enqueueOfflinePendingEntryAuthors!(b.localKey,[]);await api.unlinkEntryAuthor(2,option.id);
  const before=await store.list(),targets=before.filter((row:{operationKind:string})=>row.operationKind==='entry.authors.set');
  if(hold==='failed'||hold==='conflict') await store.update(source.opId,{status:hold});
  downgraded=true;await api.getSyncCapabilities({replay:false});await api.flushOfflineOutbox!();
  expect(sent.filter(op=>targets.some((row:{opId:string})=>row.opId===op.opId))).toEqual([]);
  const after=await store.list();for(const target of targets) expect(after.find((row:{opId:string})=>row.opId===target.opId)).toEqual(target);
  expect(after.some((row:{opId:string})=>row.opId===source.opId)).toBe(true);
  if(hold==='failed-replay'||hold==='conflict-replay') {expect(after.find((row:{opId:string})=>row.opId===source.opId).status).toBe(hold==='failed-replay'?'failed':'conflict');return;}
  downgraded=false;if(hold==='failed'||hold==='conflict') await store.update(source.opId,{status:'pending',lastError:null});
  await api.getSyncCapabilities({replay:false});await api.flushOfflineOutbox!();expect(await store.list()).toEqual([]);
  const sourceBodies=sent.filter(row=>row.opId===source.opId).map(row=>JSON.stringify(row));expect(new Set(sourceBodies).size).toBe(1);
 }finally{db.close();}
});
