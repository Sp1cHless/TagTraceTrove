import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { createTempFileDatabase } from '../../src/database/testing.js';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createApiApp } from '../../src/http/app.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { startSecurePairingListener, privateHttpsHost } from '../../src/http/secure-pairing.js';

// Node owns only the real isolated server and production JS caller. JVM owns
// claimed PairingState, authorization revalidation, pinning and raw transport.
const address=Object.values(networkInterfaces()).flat().find(row=>{if(!row || row.family!=='IPv4' || row.internal)return false;try{privateHttpsHost(row.address);return true;}catch{return false;}})?.address;
assert.ok(address,'Private IPv4 required by existing production pairing policy');
const root=await mkdtemp(join(tmpdir(),'t3-bootstrap-bytes-'));
const temp=createTempFileDatabase();applyAllMigrations(temp.database);
const entry=createEntry(temp.database,{title:'Paired byte caller',type:'comic'});
const app=createApiApp(temp.database,{assetRoot:join(root,'assets')});
const trace:Array<{path:string;authorized:boolean}>=[];
let fault:'wrong'|'missing'|null=null;
const runtime=await startSecurePairingListener({configDirectory:join(root,'auth'),libraryId:getSyncIdentity(temp.database).libraryId,hostname:address,advertisedHost:address,port:0,fetch:async request=>{
 const url=new URL(request.url);trace.push({path:url.pathname+url.search,authorized:!!request.headers.get('authorization')});
 const response=await app.fetch(request);
 if(fault && url.pathname.startsWith('/api/assets/'))return new Response(new Uint8Array([0,255,128,1]),{status:fault==='missing'?404:200,headers:{'content-type':'image/png'}});
 return response;
}});
const output=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');
const inputLines=createInterface({input:process.stdin});
const lines=inputLines[Symbol.asyncIterator]();
const receive=async()=>{const row=await lines.next();assert.ok(!row.done);return JSON.parse(row.value);};
const priorFetch=globalThis.fetch;
let store:{close():void}|undefined;
try{
 output(runtime.issue());assert.equal((await receive()).ready,true);
 const bridgeCalls:Array<{path:string;method:string;contentType:string|null;body?:string}>=[];
 let originalFetchCalls=0;
 const window={fetch:async()=>{originalFetchCalls++;return new Response('unapproved URL not paired',{status:418});},addEventListener:()=>{},Capacitor:{nativePromise:async(plugin:string,method:string,args:{path:string;method:string;contentType:string|null;body?:string})=>{
  assert.equal(plugin,'T3PairedTransport');assert.equal(method,'request');
  assert.deepEqual(Object.keys(args).sort(),['body','contentType','method','path']);
  bridgeCalls.push(args);output({request:args});const result=await receive();assert.ok(!('token' in result));return result;
 }}};
 const prepare=await readFile(new URL('../../../../spikes/001-android-webview-shell/prepare-web.mjs',import.meta.url),'utf8');
 const script=prepare.match(/const pairingBootstrap = String\.raw`([\s\S]*?)`;/)![1]!.match(/<script>([\s\S]*?)<\/script>/)![1]!;
 runInNewContext(script,{window,location:{href:'https://localhost/'},Request,Response,URL,DOMException,Uint8Array,atob,btoa});
 globalThis.fetch=window.fetch as typeof fetch;
 const web='../../../web/src/';
 const {createApiClient}=await import(web+'api/client.ts');const {createGalleryApi}=await import(web+'api/gallery.ts');
 const {createOfflineAwareGalleryApi}=await import(web+'offline/offline-api.ts');
 const {createIndexedDbOfflineStore}=await import(web+'offline/indexeddb-snapshot-store.ts');
 const {applySnapshot,readActiveSnapshot}=await import(web+'offline/snapshot-store.ts');
 const require=createRequire(new URL('../../../web/package.json',import.meta.url));const {IDBFactory}=require('fake-indexeddb');
 const indexedDB=new IDBFactory(),databaseName='paired-bootstrap-'+crypto.randomUUID();
 const online=createGalleryApi(createApiClient({baseUrl:'https://localhost/api/'}),'https://localhost/');
 let durable=createIndexedDbOfflineStore({indexedDB,databaseName});store=durable;
 let api=createOfflineAwareGalleryApi(online,durable);await api.getSyncCapabilities({replay:false});
 await durable.writeMeta('snapshotMediaMode','none');await applySnapshot(await online.fetchSyncSnapshot({media:'none'}),{store:durable,expectedBase:null});await api.preferOfflineSnapshot();
 const {default:sharp}=await import('sharp');const bytes=await sharp({create:{width:3,height:3,channels:4,background:'#138efaff'}}).png().toBuffer();
 assert.ok(bytes.some((byte:number)=>byte===0));assert.ok(bytes.some((byte:number)=>byte>127));
 await api.uploadEntryMedia(entry.id,'preview',new File([bytes],'binary.png',{type:'image/png'}));const original=(await durable.listMedia())[0];const base=await readActiveSnapshot(durable);
 const cold=async()=>{durable.close();durable=createIndexedDbOfflineStore({indexedDB,databaseName});store=durable;api=createOfflineAwareGalleryApi(online,durable);await api.preferOfflineSnapshot();};
 for(const value of ['wrong','missing'] as const){
  fault=value;await cold();await api.replayOfflineOperations();const retained=(await durable.listMedia())[0];
  assert.equal(retained.uploadId,original.uploadId);assert.equal(retained.sha256,original.sha256);assert.deepEqual(retained.existingEntry,original.existingEntry);assert.deepEqual(Buffer.from(await retained.blob.arrayBuffer()),bytes);
  assert.deepEqual(await readActiveSnapshot(durable),base);assert.equal(await durable.readMeta('verifiedReplayProjection'),null);assert.equal(trace.filter(row=>row.path.includes('/sync/ack')).length,0);
 }
 fault=null;await cold();await api.replayOfflineOperations();assert.deepEqual(await durable.listMedia(),[]);
 const current=await online.getEntry(entry.id);const ref=current.previewRefs[0];
 const query='?version=a%2Fb&raw=1';const raw=await fetch(online.assetUrl(ref)+query);assert.equal(raw.status,200);assert.deepEqual(Buffer.from(await raw.arrayBuffer()),bytes);
 assert.equal(bridgeCalls.at(-1)!.path,ref+query);assert.ok(trace.some(row=>row.path===ref+query && row.authorized));
 const count=bridgeCalls.length;
 for(const url of ['https://evil.invalid/api/assets/entries/1/preview.png','http://localhost/api/sync/capabilities','https://localhost/not-api'])assert.equal((await fetch(url)).status,418);
 assert.equal(bridgeCalls.length,count);assert.equal(originalFetchCalls,3);
 assert.ok(trace.every(row=>row.authorized));assert.ok(trace.filter(row=>row.path.includes('/api/assets/')).length>=3);
 output({done:true,pass:true,wrongMissingRetained:true,canonicalQuery:true,rawBytes:bytes.length,authenticatedRequests:trace.length,bridgeCalls:bridgeCalls.length,unapprovedNotPaired:3});
}catch(error){output({done:true,pass:false,error:String(error),stack:error instanceof Error?error.stack:undefined});process.exitCode=1;}
finally{inputLines.close();process.stdin.pause();globalThis.fetch=priorFetch;store?.close();await runtime.close();temp.cleanup();await rm(root,{recursive:true,force:true});}
