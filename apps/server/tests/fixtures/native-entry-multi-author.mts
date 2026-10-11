// Entry06 multi-author conversion finite acceptance. REAL Worker TLS/SQLite and canonical business SQL, no mocked receipts.
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
import { createAuthorDirectory } from '../../src/repositories/author-directory-repository.js';
import { createCollection } from '../../src/repositories/collection-repository.js';
import { startSecurePairingListener, privateHttpsHost } from '../../src/http/secure-pairing.js';
import { createPendingSyncOperation } from '../../../web/src/offline/outbox-store.js';
import { mutationQueuePlan, originalMutationEnvelope } from '../../../web/src/offline/sync-mutation-plan.js';
import { syncReplayOperationSchema, syncReplayResultSchema } from '@t3/shared';
const address=Object.values(networkInterfaces()).flat().find(item=>{if(!item || item.family!=='IPv4' || item.internal)return false;try{privateHttpsHost(item.address);return true;}catch{return false;}})?.address;
if(!address)throw new Error('Actual private IPv4 required');
const directory=await mkdtemp(join(tmpdir(),'t3-e06-'));
const disposable=createTempFileDatabase(), database=disposable.database;applyAllMigrations(database);
const assetRoot=join(directory,'assets');await mkdir(assetRoot);
const work=createEntry(database,{title:'Converted work',type:'Comic'}),peer=createEntry(database,{title:'Peer work',type:'Comic'});
const author=createProducer(database,{name:'Preserved Author'}),contributor=createProducer(database,{name:'Solo Contributor'});
linkEntryProducer(database,work.id,author.id);linkEntryProducer(database,work.id,contributor.id);linkEntryProducer(database,peer.id,author.id);
createAuthorDirectory(database,{producerId:contributor.id,title:'Contributor directory',entryIds:[work.id]});
const shelf=createCollection(database,{kind:'producer',title:'Contributor shelf'});
database.prepare('INSERT INTO collection_producers (collection_id,producer_id) VALUES (?,?)').run(shelf.id,contributor.id);
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
const workAuthors=()=>database.prepare('SELECT p.sync_uid AS uid FROM entry_producers ep JOIN producers p ON p.id=ep.producer_id WHERE ep.entry_id=? ORDER BY p.id').all(work.id).map((row:{uid:string})=>row.uid);
try{for await(const line of createInterface({input:process.stdin})){
 const cmd=JSON.parse(line) as Record<string,unknown>;
 if(cmd.action==='packets'){
  const entry=database.prepare('SELECT sync_uid AS uid,sync_version AS version FROM entries WHERE id=?').get(work.id) as {uid:string;version:number};
  const authorRows=database.prepare('SELECT p.id,p.sync_uid AS uid,p.name,p.sync_version AS version FROM entry_producers ep JOIN producers p ON p.id=ep.producer_id WHERE ep.entry_id=? ORDER BY p.id').all(work.id) as Array<{id:number;uid:string;name:string;version:number}>;
  const authors=authorRows.map(row=>({producerUid:row.uid,name:row.name,version:row.version,
   workUids:database.prepare('SELECT e.sync_uid AS uid FROM entry_producers ep JOIN entries e ON e.id=ep.entry_id WHERE ep.producer_id=? ORDER BY e.sync_uid').all(row.id).map((r:{uid:string})=>r.uid)}));
  const ids=authorRows.map(row=>row.id);
  const owners=[
   ...database.prepare(`SELECT 'author_directory_set' AS kind, sync_uid AS uid, sync_version AS version FROM author_directory_sets WHERE producer_id IN (${ids.map(()=>'?').join(',')})`).all(...ids) as Array<{kind:string;uid:string;version:number}>,
   ...database.prepare(`SELECT DISTINCT 'collection' AS kind, c.sync_uid AS uid, c.sync_version AS version FROM collections c JOIN collection_producers cp ON cp.collection_id=c.id WHERE cp.producer_id IN (${ids.map(()=>'?').join(',')})`).all(...ids) as Array<{kind:string;uid:string;version:number}>,
  ].map(row=>({entityKind:row.kind as 'collection'|'author_directory_set',entityUid:row.uid,version:row.version}));
  const conversion=createPendingSyncOperation({clientId,libraryId:identity.libraryId,syncEpoch:identity.syncEpoch,entityKind:'entry',operationKind:'entry.authors.convert-to-multi',entityUid:entry.uid,baseVersion:entry.version,
   baseValues:{authors,target:null,...(cmd.kind==='legacy'?{}:{cascadeOwners:owners})},payload:{targetUid:randomUUID()}});
  const peerRow=database.prepare('SELECT sync_uid AS uid,sync_version AS version FROM entries WHERE id=?').get(peer.id) as {uid:string;version:number};
  const independent=createPendingSyncOperation({clientId,libraryId:identity.libraryId,syncEpoch:identity.syncEpoch,entityKind:'entry',operationKind:'entry.update',entityUid:peerRow.uid,baseVersion:peerRow.version,baseValues:{title:'Peer work'},payload:{title:'Peer renamed'}});
  const rows=cmd.kind==='solo'?[conversion]:[conversion,independent];const plans=mutationQueuePlan(rows);
  output({packets:rows.map(row=>{const op=originalMutationEnvelope(row);syncReplayOperationSchema.parse(op);return {body:JSON.stringify(op),plan:plans.get(row.opId)};}),businessReceiptsMocked:false});
 }else if(cmd.action==='facts'){
  const targetUid=String(cmd.targetUid??'');
  output({workAuthors:workAuthors(),target:database.prepare("SELECT id,sync_uid AS uid,sync_version AS version FROM producers WHERE name='multiple author' COLLATE NOCASE ORDER BY id LIMIT 1").get()??null,
   contributorRows:database.prepare('SELECT count(*) AS n FROM producers WHERE id=?').get(contributor.id),registryRows:targetUid?database.prepare('SELECT count(*) AS n FROM sync_offline_created_producers WHERE producer_uid=?').get(targetUid):{n:0},
   peerTitle:database.prepare('SELECT title FROM entries WHERE id=?').pluck().get(peer.id)??null,
   receipts:database.prepare('SELECT op_id,result_json FROM sync_operation_receipts').all(),
   journals:database.prepare("SELECT count(*) AS n FROM sync_changes WHERE entity_kind='entry' AND entity_uid=?").get(database.prepare('SELECT sync_uid FROM entries WHERE id=?').pluck().get(work.id))});
 }else if(cmd.action==='mode'){mode=cmd;mutations=[];output({ok:true});}
 else if(cmd.action==='counters')output({mutations,sqlReceipts:(database.prepare('SELECT COUNT(*) AS n FROM sync_operation_receipts').get() as {n:number}).n});
 else if(cmd.action==='close')break;
}}finally{await runtime.close();disposable.cleanup();await rm(directory,{recursive:true,force:true});}
