// Entry07 work-merge finite acceptance. REAL Worker TLS/SQLite and canonical business SQL, no mocked receipts.
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
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createSection,createFacet } from '../../src/repositories/layout-repository.js';
import { assignEntryTag } from '../../src/repositories/entry-tag-repository.js';
import { createEntryContent } from '../../src/repositories/entry-content-repository.js';
import { startSecurePairingListener, privateHttpsHost } from '../../src/http/secure-pairing.js';
import { createPendingSyncOperation } from '../../../web/src/offline/outbox-store.js';
import { mutationQueuePlan, originalMutationEnvelope } from '../../../web/src/offline/sync-mutation-plan.js';
import { syncReplayOperationSchema, syncReplayResultSchema } from '@t3/shared';
const address=Object.values(networkInterfaces()).flat().find(item=>{if(!item || item.family!=='IPv4' || item.internal)return false;try{privateHttpsHost(item.address);return true;}catch{return false;}})?.address;
if(!address)throw new Error('Actual private IPv4 required');
const directory=await mkdtemp(join(tmpdir(),'t3-e07-'));
const disposable=createTempFileDatabase(), database=disposable.database;applyAllMigrations(database);
const assetRoot=join(directory,'assets');await mkdir(assetRoot);
const keep=createEntry(database,{title:'Kept work',type:'Comic'}),absorb=createEntry(database,{title:'Absorbed work',type:'Comic'}),film=createEntry(database,{title:'Film work',type:'Film'});
const section=createSection(database,{entryType:'Comic',name:'Tags'}),facet=createFacet(database,{sectionId:section.id,name:'Theme'});
const author=createProducer(database,{name:'Merging Author'});linkEntryProducer(database,keep.id,author.id);linkEntryProducer(database,absorb.id,author.id);
assignEntryTag(database,{entryId:absorb.id,name:'Copied Tag',facetId:facet.id});
createEntryContent(database,{entryId:absorb.id,contentType:'Source URL',content:'https://example.org/absorbed-source',sortOrder:0});
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
  if(mode.loss){mode.loss=false;return new Response('{',{status:200,headers:{'content-type':'application/json'}});}
  return Response.json(receipt,{status:response.status});
 }
 return app.fetch(request);
}});
const output=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');output(runtime.issue());
try{for await(const line of createInterface({input:process.stdin})){
 const cmd=JSON.parse(line) as Record<string,unknown>;
 if(cmd.action==='packets'){
  const keepRow=database.prepare('SELECT sync_uid AS uid,sync_version AS version FROM entries WHERE id=?').get(keep.id) as {uid:string;version:number};
  const absorbRow=database.prepare('SELECT sync_uid AS uid,sync_version AS version FROM entries WHERE id=?').get(absorb.id) as {uid:string;version:number};
  const filmRow=database.prepare('SELECT sync_uid AS uid,sync_version AS version FROM entries WHERE id=?').get(film.id) as {uid:string;version:number};
  const sourceRow=database.prepare("SELECT content FROM entry_contents WHERE entry_id=? AND content_type='Source URL'").pluck().get(absorb.id) as string;
  const merge=createPendingSyncOperation({clientId,libraryId:identity.libraryId,syncEpoch:identity.syncEpoch,entityKind:'entry',operationKind:'entry.merge',entityUid:keepRow.uid,baseVersion:keepRow.version,
   baseValues:{absorbVersion:absorbRow.version},payload:{absorbUid:absorbRow.uid,copyTags:true,title:'Merged title',sources:[{url:sourceRow,contentUid:randomUUID()}]}});
  const independent=createPendingSyncOperation({clientId,libraryId:identity.libraryId,syncEpoch:identity.syncEpoch,entityKind:'entry',operationKind:'entry.update',entityUid:filmRow.uid,baseVersion:filmRow.version,baseValues:{title:'Film work'},payload:{title:'Film renamed'}});
  const rows=cmd.kind==='solo'?[merge]:[merge,independent];const plans=mutationQueuePlan(rows);
  output({packets:rows.map(row=>{const op=originalMutationEnvelope(row);syncReplayOperationSchema.parse(op);return {body:JSON.stringify(op),plan:plans.get(row.opId)};}),businessReceiptsMocked:false});
 }else if(cmd.action==='facts'){
  output({absorbRows:database.prepare('SELECT count(*) AS n FROM entries WHERE id=?').get(absorb.id),keepTitle:database.prepare('SELECT title FROM entries WHERE id=?').pluck().get(keep.id)??null,
   filmTitle:database.prepare('SELECT title FROM entries WHERE id=?').pluck().get(film.id)??null,
   copiedSources:database.prepare("SELECT count(*) AS n FROM entry_contents WHERE entry_id=? AND content_type='Source URL' AND content='https://example.org/absorbed-source'").get(keep.id),
   copiedTags:database.prepare('SELECT count(*) AS n FROM entry_tags WHERE entry_id=?').get(keep.id),
   receipts:database.prepare('SELECT op_id,result_json FROM sync_operation_receipts').all()});
 }else if(cmd.action==='mode'){mode=cmd;mutations=[];output({ok:true});}
 else if(cmd.action==='counters')output({mutations,sqlReceipts:(database.prepare('SELECT COUNT(*) AS n FROM sync_operation_receipts').get() as {n:number}).n});
 else if(cmd.action==='close')break;
}}finally{await runtime.close();disposable.cleanup();await rm(directory,{recursive:true,force:true});}
