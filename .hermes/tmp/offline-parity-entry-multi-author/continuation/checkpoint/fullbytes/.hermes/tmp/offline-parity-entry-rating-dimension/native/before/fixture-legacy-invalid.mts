// Gallery04 repair finite acceptance. REAL Worker TLS/SQLite and canonical business SQL, no mocked receipts.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createTempFileDatabase } from '../../src/database/testing.js';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { createApiApp } from '../../src/http/app.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { createProducer,linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { createEntryRatingSlot,createProducerRatingSlot,setEntryRating,setProducerRating } from '../../src/repositories/rating-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { startSecurePairingListener, privateHttpsHost } from '../../src/http/secure-pairing.js';
import { createPendingSyncOperation } from '../../../web/src/offline/outbox-store.js';
import { mutationQueuePlan, originalMutationEnvelope } from '../../../web/src/offline/sync-mutation-plan.js';
import { syncReplayOperationSchema, syncReplayResultSchema } from '@t3/shared';
const address=Object.values(networkInterfaces()).flat().find(item=>{if(!item || item.family!=='IPv4' || item.internal)return false;try{privateHttpsHost(item.address);return true;}catch{return false;}})?.address;
if(!address)throw new Error('Actual private IPv4 required');
const directory=await mkdtemp(join(tmpdir(),'t3-e05-'));
const disposable=createTempFileDatabase(), database=disposable.database;applyAllMigrations(database);
const assetRoot=join(directory,'assets');await mkdir(assetRoot);
const work=createEntry(database,{title:'Work',type:'Comic'}),peer=createEntry(database,{title:'Peer',type:'Comic'}),film=createEntry(database,{title:'Film',type:'Film'});
const author=createProducer(database,{name:'Author'});linkEntryProducer(database,work.id,author.id);
const quality=createEntryRatingSlot(database,{entryId:work.id,name:'Quality'}),keep=createEntryRatingSlot(database,{entryId:work.id,name:'Keep'}),foreign=createEntryRatingSlot(database,{entryId:film.id,name:'Film'});
const summary=createProducerRatingSlot(database,{producerId:author.id,name:'Summary'}),self=createProducerRatingSlot(database,{producerId:author.id,name:'Self',kind:'author_self'});
for(const entry of [work,peer])setEntryRating(database,{entryId:entry.id,slotId:quality.id,stars:4});
setEntryRating(database,{entryId:film.id,slotId:foreign.id,stars:3});setProducerRating(database,{producerId:author.id,slotId:summary.id,stars:3.5});setProducerRating(database,{producerId:author.id,slotId:self.id,stars:5});
const initial=database.prepare("SELECT sync_uid AS uid,sync_version AS version FROM rating_slot_layouts WHERE subject_kind='entry' AND entry_type='Comic'").get() as {uid:string;version:number};
const app=createApiApp(database,{assetRoot,dataDir:directory});
const identity=getSyncIdentity(database),clientId=randomUUID();
let mode:Record<string,unknown>={},mutations:string[]=[];
const runtime=await startSecurePairingListener({configDirectory:join(directory,'auth'),libraryId:identity.libraryId,hostname:address,advertisedHost:address,port:0,fetch:async(request:Request)=>{
 const path=new URL(request.url).pathname;
 if(path==='/api/sync/capabilities'){
  const response=await app.fetch(request);const caps=await response.json() as {featureFlags:Record<string,boolean>};
  if(mode.flag){if(mode.absent)delete caps.featureFlags[String(mode.flag)];else caps.featureFlags[String(mode.flag)]=false;}
  return Response.json(caps,{status:response.status});
 }
 if(path==='/api/sync/replay'){
  const body=await request.text();mutations.push(body);syncReplayOperationSchema.parse(JSON.parse(body));
  const response=await app.fetch(new Request(request.url,{method:'POST',headers:request.headers,body}));
  const receipt=await response.json();syncReplayResultSchema.parse(receipt);
  if(mode.loss){mode.loss=false;return new Response('{', {status:200,headers:{'content-type':'application/json'}});}
  // Only invalid-response negatives alter canonical valid SQL receipts; never synthesize applied business results.
  if(mode.invalid && JSON.parse(body).entityUid===initial.uid){const bad={...receipt as Record<string,unknown>};if(mode.invalid==='missing')delete bad.opId;else if(mode.invalid==='foreign')bad.opId=randomUUID();else bad.resourceVersion=0;return Response.json(bad,{status:200});}
  return Response.json(receipt,{status:response.status});
 }
 return app.fetch(request);
}});
const output=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');output(runtime.issue());
try{for await(const line of createInterface({input:process.stdin})){
 const cmd=JSON.parse(line) as Record<string,unknown>;
 if(cmd.action==='packets'){
  const slots=(type:string)=>database.prepare("SELECT sync_uid AS syncUid,name,sort_order AS sortOrder FROM rating_slots WHERE subject_kind='entry' AND entry_type=? ORDER BY sort_order,id").all(type) as {syncUid:string;name:string;sortOrder:number}[];
  const base=slots('Comic');const filmBase=slots('Film');
  const make=(uid:string,version:number,b:typeof base,desired:typeof base,deleted?:string[])=>createPendingSyncOperation({clientId,libraryId:identity.libraryId,syncEpoch:identity.syncEpoch,entityKind:'rating_layout',operationKind:'rating-layout.slots.set',entityUid:uid,baseVersion:version,baseValues:{slots:b},payload:{slots:desired,...(deleted?{deletedSlotUids:deleted}:{})}});
  const first=make(initial.uid,initial.version,base,base.filter(x=>x.name!=='Quality'),[base.find(x=>x.name==='Quality')!.syncUid]);
  const after=first.payload.slots;const second=make(initial.uid,initial.version+1,after,[],[after[0]!.syncUid]);
  const layout=database.prepare("SELECT sync_uid AS uid,sync_version AS version FROM rating_slot_layouts WHERE subject_kind='entry' AND entry_type='Film'").get() as {uid:string;version:number};
  const independent=make(layout.uid,layout.version,filmBase,[],[filmBase[0]!.syncUid]);
  const legacy=make(initial.uid,initial.version,base,base);
  const created=[...base,{syncUid:randomUUID(),name:'Pending',sortOrder:base.length}];
  const predecessor=make(initial.uid,initial.version,base,created);
  const d1=make(initial.uid,initial.version+1,created,created.filter(x=>x.name!=='Quality'),[base[0]!.syncUid]);
  const d2=make(initial.uid,initial.version+2,d1.payload.slots,d1.payload.slots.filter(x=>x.name!=='Keep'),[base[1]!.syncUid]);
  const entry=database.prepare('SELECT sync_uid AS uid,sync_version AS version FROM entries WHERE id=?').get(film.id) as {uid:string;version:number};
  const rating=createPendingSyncOperation({clientId,libraryId:identity.libraryId,syncEpoch:identity.syncEpoch,entityKind:'entry',operationKind:'entry.rating.set',entityUid:entry.uid,baseVersion:entry.version,baseValues:{slotUid:filmBase[0]!.syncUid,stars:3},payload:{slotUid:filmBase[0]!.syncUid,stars:4}});
  const rows=cmd.kind==='chain'?[predecessor,d1,d2,independent]:cmd.kind==='legacy'?[legacy]:cmd.kind==='held'?[first,second,rating]:[first,second,independent];const plans=mutationQueuePlan(rows);
  output({packets:rows.map(row=>{const op=originalMutationEnvelope(row);syncReplayOperationSchema.parse(op);return {body:JSON.stringify(op),plan:plans.get(row.opId)};}),businessReceiptsMocked:false});
 }else if(cmd.action==='facts'){
  output({qualityValues:database.prepare('SELECT count(*) AS n FROM entry_rating_values WHERE slot_id=?').get(quality.id),qualitySlots:database.prepare('SELECT count(*) AS n FROM rating_slots WHERE id=?').get(quality.id),filmStars:database.prepare('SELECT stars FROM entry_rating_values WHERE slot_id=?').pluck().get(foreign.id)??null,summaryStars:database.prepare('SELECT stars FROM producer_rating_values WHERE slot_id=?').pluck().get(summary.id),selfStars:database.prepare('SELECT stars FROM producer_rating_values WHERE slot_id=?').pluck().get(self.id),journals:database.prepare("SELECT count(*) AS n FROM sync_changes WHERE entity_kind='rating_layout' AND entity_uid=? AND resource_version>?").get(initial.uid,initial.version),receipts:database.prepare('SELECT op_id,result_json FROM sync_operation_receipts').all()});
 }else if(cmd.action==='mode'){mode=cmd;mutations=[];output({ok:true});}
 else if(cmd.action==='counters')output({mutations,sqlReceipts:(database.prepare('SELECT COUNT(*) AS n FROM sync_operation_receipts').get() as {n:number}).n});
 else if(cmd.action==='close')break;
}}finally{await runtime.close();disposable.cleanup();await rm(directory,{recursive:true,force:true});}
