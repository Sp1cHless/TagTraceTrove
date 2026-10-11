// Gallery04 finite acceptance. REAL Worker TLS/SQLite and canonical business SQL, no mocked receipts.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createTempFileDatabase } from '../../src/database/testing.js';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { createApiApp } from '../../src/http/app.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { startSecurePairingListener, privateHttpsHost } from '../../src/http/secure-pairing.js';
import { createPendingSyncOperation } from '../../../web/src/offline/outbox-store.js';
import { mutationQueuePlan, originalMutationEnvelope } from '../../../web/src/offline/sync-mutation-plan.js';
import { syncReplayOperationSchema, syncReplayResultSchema } from '@t3/shared';
const address=Object.values(networkInterfaces()).flat().find(item=>{if(!item || item.family!=='IPv4' || item.internal)return false;try{privateHttpsHost(item.address);return true;}catch{return false;}})?.address;
if(!address)throw new Error('Actual private IPv4 required');
const directory=await mkdtemp(join(tmpdir(),'t3-g04-'));
const disposable=createTempFileDatabase(), database=disposable.database;applyAllMigrations(database);
const assetRoot=join(directory,'assets');await mkdir(assetRoot);
createEntry(database,{title:'Existing type',type:'Comic'});
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
  return Response.json(receipt,{status:response.status});
 }
 return app.fetch(request);
}});
const output=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');output(runtime.issue());
try{for await(const line of createInterface({input:process.stdin})){
 const cmd=JSON.parse(line) as Record<string,unknown>;
 if(cmd.action==='timeline'){
  const common={clientId,libraryId:identity.libraryId,syncEpoch:identity.syncEpoch,entityKind:'entry' as const,operationKind:'entry.create' as const,entityUid:randomUUID(),baseVersion:0,baseValues:{}};
  const payload={title:'Native exact original',type:cmd.kind==='origin'?'NativeNewType':'Comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,...(cmd.kind==='origin'?{partitionScopeUid:randomUUID()}: {})};
  const row=createPendingSyncOperation({...common,payload});const plan=mutationQueuePlan([row]).get(row.opId)!;
  const op=originalMutationEnvelope(row);syncReplayOperationSchema.parse(op);if(!plan.eligible)throw new Error('Illegal actual plan');
  output({packets:[{body:JSON.stringify(op),plan}],businessReceiptsMocked:false});
 }else if(cmd.action==='mode'){mode=cmd;mutations=[];output({ok:true});}
 else if(cmd.action==='counters')output({mutations,sqlReceipts:(database.prepare('SELECT COUNT(*) AS n FROM sync_operation_receipts').get() as {n:number}).n});
 else if(cmd.action==='close')break;
}}finally{await runtime.close();disposable.cleanup();await rm(directory,{recursive:true,force:true});}
