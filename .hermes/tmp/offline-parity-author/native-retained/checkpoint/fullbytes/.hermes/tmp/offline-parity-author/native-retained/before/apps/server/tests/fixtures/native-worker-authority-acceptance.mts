// Acceptance fixture: real pinned TLS, real pairing authority and migrated file SQLite.
// Replay responses are EXPLICIT CONTRACT MOCKS, not claims of 23 SQL business applies.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createTempFileDatabase } from '../../src/database/testing.js';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { createApiApp } from '../../src/http/app.js';
import { getSyncIdentity, rotateSyncEpoch } from '../../src/sync/sync-service.js';
import { startSecurePairingListener, privateHttpsHost, recoverSecurePairing } from '../../src/http/secure-pairing.js';
import { validKindRows } from '../../../web/tests/fixtures/native-valid-kind-fixture.js';
import { syncReplayOperationSchema, syncReplayResultSchema } from '@t3/shared';
const address=Object.values(networkInterfaces()).flat().find(item=>{if(!item || item.family!=='IPv4' || item.internal)return false;try{privateHttpsHost(item.address);return true;}catch{return false;}})?.address;
if(!address)throw new Error('Actual private IPv4 required');
const directory=await mkdtemp(join(tmpdir(),'t3-worker-authority-'));
const disposable=createTempFileDatabase();const database=disposable.database;applyAllMigrations(database);
const assetRoot=join(directory,'assets');await mkdir(assetRoot);
const app=createApiApp(database,{assetRoot});
let mode:Record<string,unknown>={};let mutations:string[]=[];let preflights=0;
const options={configDirectory:join(directory,'auth'),libraryId:getSyncIdentity(database).libraryId,hostname:address,advertisedHost:address,fetch:async(request:Request)=>{
 const path=new URL(request.url).pathname;
 if(path==='/api/sync/capabilities'){
  preflights++;const response=await app.fetch(request);const caps=await response.json() as {featureFlags:Record<string,boolean>};
  if(mode.flag){if(mode.absent)delete caps.featureFlags[String(mode.flag)];else caps.featureFlags[String(mode.flag)]=false;}
  return Response.json(caps,{status:response.status});
 }
 if(request.method!=='GET')mutations.push(await request.clone().text());
 if(path==='/api/sync/replay'){
  const op=syncReplayOperationSchema.parse(JSON.parse(mutations.at(-1)!));
  const receipt:Record<string,unknown>={opId:op.opId,status:'applied',resourceVersion:2,serverSeq:1};
  syncReplayResultSchema.parse(receipt);
  if(mode.bad && (!mode.target || mode.target===op.opId)){
   if(mode.bad==='opId')receipt.opId='99999999-9999-4999-8999-999999999999';
   else if(mode.bad==='status')receipt.status='conflict';
   else receipt[String(mode.bad)]='foreign-scope';
  }
  return Response.json(receipt);
 }
 return app.fetch(request);
}};
let runtime=await startSecurePairingListener({...options,port:0});const port=Number(new URL(runtime.endpoint).port);
const output=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');output(runtime.issue());
try{
 for await(const line of createInterface({input:process.stdin})){
  const cmd=JSON.parse(line) as Record<string,unknown>;
  if(cmd.action==='rows'){const identity=getSyncIdentity(database);output({rows:validKindRows(identity.libraryId,identity.syncEpoch)});}
  else if(cmd.action==='mode'){mode=cmd;mutations=[];preflights=0;output({ok:true});}
  else if(cmd.action==='counters')output({mutations,preflights,receipts:(database.prepare('SELECT COUNT(*) AS n FROM sync_operation_receipts').get() as {n:number}).n});
  else if(cmd.action==='revoke'){runtime.revoke(String(cmd.deviceId));output({ok:true});}
  else if(cmd.action==='epoch'){rotateSyncEpoch(database);output({ok:true});}
  else if(cmd.action==='pin'){await runtime.close();recoverSecurePairing(options,{libraryId:options.libraryId,ownerPid:0,action:'reset-identity'});runtime=await startSecurePairingListener({...options,port});output(runtime.issue());}
  else if(cmd.action==='close')break;
 }
}finally{await runtime.close();disposable.cleanup();await rm(directory,{recursive:true,force:true});}
