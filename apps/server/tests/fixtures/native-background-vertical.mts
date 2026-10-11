import { createRequire } from 'node:module';
import { nativeMutationContract } from '@t3/shared';
import { randomUUID } from 'node:crypto';
import { createEntry } from '../../src/repositories/entry-repository.js';
import type { T3Database } from '../../src/database/connection.js';
import type { createApiApp } from '../../src/http/app.js';
export async function createVertical(database:T3Database, app:ReturnType<typeof createApiApp>) {
  if(process.env.T3_BACKGROUND_KINDS==='1')return (await import('./native-mutation-vertical.mjs')).createMutationVertical(database,app);
  createEntry(database,{title:'Background seed',type:'comic'});
  const web='../../../web/src/';
  const {createApiClient}=await import(web+'api/client.ts');
  const {createGalleryApi}=await import(web+'api/gallery.ts');
  const {createOfflineAwareGalleryApi}=await import(web+'offline/offline-api.ts');
  const {createIndexedDbOfflineStore}=await import(web+'offline/indexeddb-snapshot-store.ts');
  const {createNativeTransfers}=await import(web+'offline/native-background-transfer.ts');
  const require=createRequire(new URL('../../../web/package.json',import.meta.url));
  const {IDBFactory}=require('fake-indexeddb');
  const indexedDB=new IDBFactory(); const name='native-vertical-'+randomUUID();
  let store=createIndexedDbOfflineStore({indexedDB,databaseName:name});
  const replayBodies:string[]=[]; let uploads=0,acks=0;
  // Byte verification now fetches the original asset via fetch, not the injected JSON client.
  // Give it a real isolated HTTP origin rather than the deliberately non-resolving fixture host.
  const {createServer}=await import('node:http');
  const assetServer=createServer(async(req,res)=>{
    try {const response=await app.fetch(new Request(`http://fixture${req.url}`));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}
    catch(error){res.writeHead(500);res.end(String(error));}
  });
  await new Promise<void>(resolve=>assetServer.listen(0,'127.0.0.1',resolve));
  const assetOrigin=`http://127.0.0.1:${(assetServer.address() as import('node:net').AddressInfo).port}/`;
  const online=createGalleryApi(createApiClient({baseUrl:'http://fixture/api/',fetchImplementation:async(input:RequestInfo|URL,init?:RequestInit)=>{
    const request=new Request(input,init);
    if(request.url.endsWith('/sync/replay'))replayBodies.push(await request.clone().text());
    if(request.url.includes('/sync/media/'))uploads++;
    if(request.url.endsWith('/sync/ack'))acks++;
    return app.fetch(request);
  }}),assetOrigin);
  await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot({media:'none'})));await store.writeMeta('activeGeneration','1');await store.writeMeta('snapshotMediaMode','none');
  let captured:Record<string,unknown>={};let bytes:Buffer[]=[];const capturedJobs:Record<string,unknown>[]=[];
  const native=createNativeTransfers(store,{async call(method:string,args:Record<string,unknown>){
    if(method==='status')return {protocolVersion:1,planVersion:1,operationKinds:Object.keys(nativeMutationContract)};
    if(method==='stage' || method==='stageOperation' || method==='stageStandaloneMedia'){captured=args;bytes=[];return {stageId:'test-stage'};}
    if(method==='chunk'){bytes.push(Buffer.from(String(args.body),'base64'));return {};}
    if(method==='seal')capturedJobs.push({...captured,bytes:Buffer.concat(bytes).toString('base64')});
    return {};
  }});
  const api=createOfflineAwareGalleryApi(online,store,{nativeTransfers:native});
  await api.getSyncCapabilities({replay:false});await api.preferOfflineSnapshot();
  const {default:sharp}=await import('sharp');
  const original=await sharp({create:{width:2,height:2,channels:4,background:'#ff3322'}}).png().toBuffer();
  const standalone=process.env.T3_BACKGROUND_STANDALONE === '1';
  const noMedia=process.env.T3_BACKGROUND_NO_MEDIA === '1';const multiple=process.env.T3_BACKGROUND_MULTIPLE === '1';const two=process.env.T3_BACKGROUND_TWO === '1';
  if(standalone) {
    const seed=(await store.captureSnapshot()).active.snapshot.payload.entries[0];
    await api.uploadEntryMedia(seed.id,'cover',new File([original],'cover.png',{type:'image/png'}));
    await api.uploadEntryMedia(seed.id,'preview',new File([original],'one.png',{type:'image/png'}));
    await api.uploadEntryMedia(seed.id,'preview',new File([original],'two.png',{type:'image/png'}));
  } else await api.enqueueOfflineEntryCreate({title:'Native original proof',type:'comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:(multiple || two) ? new File([original],'cover.png',{type:'image/png'}) : null,...(multiple ? {previewFiles:[new File([original],'one.png',{type:'image/png'}),new File([original],'two.png',{type:'image/png'}),new File([original],'three.png',{type:'image/png'})]} : {}),previewFile:noMedia ? null : new File([original],'original.png',{type:'image/png'})});
  const pending=await store.list(),media=await store.listMedia();
  if(pending.length!==(standalone?0:1) || media.length!==(standalone?3:noMedia?0:multiple?4:two?2:1) || (!noMedia && bytes.length===0))throw new Error('Actual durable facade handoff missing');
  const body=String(captured.body),blob=Buffer.concat(bytes);
  if(!noMedia && !blob.equals(original))throw new Error('Handoff changed original Blob');
  return {
    payload:{...captured,jobs:standalone ? [...new Map(capturedJobs.map(row=>[row.uploadId,row])).values()] : capturedJobs,opId:pending[0]?.opId,bytes:blob.toString('base64'),pendingOperations:pending.length,pendingMedia:media.length},
    async foreground(){
      // A real IDB handle close/new facade, not merely a reconstructed adapter.
      store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName:name});
      const beforeOps=await store.list(),beforeMedia=await store.listMedia();
      const cold=createOfflineAwareGalleryApi(online,store);
      await cold.getSyncCapabilities({replay:false});await cold.flushOfflineOutbox();
      const afterOps=await store.list(),afterMedia=await store.listMedia();
      const capture=await store.captureSnapshot();
      const owner=capture.active?.snapshot.payload.entries.find((entry:{syncUid:string})=>entry.syncUid===(standalone?media[0].entryUid:pending[0].entityUid));
      return {beforeOperations:beforeOps.length,beforeMedia:beforeMedia.length,afterOperations:afterOps.length,afterMedia:afterMedia.length,
        originalUnchanged:JSON.stringify(beforeOps)===JSON.stringify(pending),originalBodyRetry:standalone ? replayBodies.length===0 : JSON.stringify(JSON.parse(replayBodies[0]??'null'))===JSON.stringify(JSON.parse(body)),
        replayCount:replayBodies.length,uploadCount:uploads,ackCount:acks,coveredOwner:owner?.id,
        entryCount:(database.prepare("SELECT COUNT(*) AS n FROM entries WHERE sync_uid=?").get((standalone?media[0].entryUid:pending[0].entityUid)) as {n:number}).n,
        previewCount:owner?.previewRefs.length,registryCount:(database.prepare('SELECT COUNT(*) AS n FROM sync_offline_created_entries').get() as {n:number}).n, pendingAck:await store.readMeta('pendingSnapshotAck')};
    },close(){store.close();assetServer.closeAllConnections();assetServer.close();}
  };
}
