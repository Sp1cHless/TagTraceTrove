import { File } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexedDB } from 'fake-indexeddb';
import sharp from '../../server/node_modules/sharp/lib/index.js';
import { describe, it, expect } from 'vitest';
// Cross-workspace runtime integration: deliberately not part of the web TS rootDir.
const serverModule = async (path: string) => { const target = `../../server/src/${path}.js`; return import(/* @vite-ignore */ target); };
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { applySnapshot, readActiveSnapshot } from '../src/offline/snapshot-store.js';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
import { preparePendingWork } from '../src/offline/pending-work-restore.js';
import type { SyncSnapshot } from '@t3/shared';

async function harness() {
 const [{createTempFileDatabase},{applyAllMigrations},{createEntry},{createApiApp}]=await Promise.all(['database/testing','database/migrations','repositories/entry-repository','http/app'].map(serverModule));
 const temp=createTempFileDatabase(); applyAllMigrations(temp.database);
 const root=mkdtempSync(join(tmpdir(),'t3-existing-client-'));
 const entry=createEntry(temp.database,{title:'Existing',type:'comic'});
 const app=createApiApp(temp.database,{assetRoot:root});
 const trace:Array<{path:string;metadata?:unknown;hash?:string;result?:unknown;body?:unknown}>=[];
 let loseUpload=false,loseReplay=false,loseAck=false,omitMedia=false,downgrade=false,rejectCover=false;
 const server=createServer(async(req,res)=>{
  try {
   const chunks:Buffer[]=[]; for await(const chunk of req) chunks.push(Buffer.from(chunk));
   const body=Buffer.concat(chunks); const url=`http://127.0.0.1${req.url}`;
   const headers=new Headers(); for(const [key,value] of Object.entries(req.headers)) if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
   const request=new Request(url,{method:req.method!,headers,...(body.length?{body}: {})});
   const record:typeof trace[number]={path:req.url!}; trace.push(record);
   if(req.url!.includes('/sync/media/')) { const form=await request.clone().formData(); record.metadata=JSON.parse(String(form.get('metadata'))); record.hash=createHash('sha256').update(Buffer.from(await (form.get('file') as Blob).arrayBuffer())).digest('hex'); }
   if(req.url!.includes('/sync/ack') || req.url!.includes('/sync/replay'))record.body=JSON.parse(body.toString());
   const response=rejectCover && record.metadata && (record.metadata as {kind:string}).kind==='cover' ? Response.json({error:"Cover conflict"},{status:409}) : await app.fetch(request); let bytes=Buffer.from(await response.arrayBuffer());
   if(req.url!.includes('/sync/media/') || req.url!.includes('/sync/replay'))record.result=JSON.parse(bytes.toString());
   if(downgrade && req.url!.includes('/sync/capabilities')) { const value=JSON.parse(bytes.toString());delete value.featureFlags.existingEntryMedia;bytes=Buffer.from(JSON.stringify(value)); }
   if(omitMedia && req.url!.includes('/sync/delta') && response.ok) {
    const value=JSON.parse(bytes.toString()); const base=JSON.stringify((await readActiveSnapshot(store))!.snapshot);
    const snapshot=JSON.parse(base.slice(0,value.prefix)+value.chunk+base.slice(value.prefix+value.remove)) as SyncSnapshot;
    value.prefix=0;value.remove=base.length;
    snapshot.payload.entries[0]!.previewRefs=[];snapshot.payload.entries[0]!.previewRef=null;
    const {checksum,...header}=snapshot.header;void checksum;
    snapshot.header.checksum=createHash('sha256').update(JSON.stringify(header)+JSON.stringify(snapshot.payload)).digest('hex');
    value.target=snapshot.header;value.chunk=JSON.stringify(snapshot);value.insertLength=value.chunk.length;bytes=Buffer.from(JSON.stringify(value));
   }
   if(response.ok && ((loseUpload && req.url!.includes('/sync/media/')) || (loseAck && req.url!.includes('/sync/ack')) || (loseReplay && req.url!.includes('/sync/replay')))) {loseUpload=false;loseAck=false;loseReplay=false;res.destroy();return;}
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(bytes);
  }catch(error){res.writeHead(500);res.end(String(error));}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address() as {port:number};
 const online=createGalleryApi(createApiClient({baseUrl:`http://127.0.0.1:${address.port}/api/`}));
 const databaseName=`existing-media-${crypto.randomUUID()}`;
 let store=createIndexedDbOfflineStore({indexedDB,databaseName});
 let api=createOfflineAwareGalleryApi(online,store);
 await api.getSyncCapabilities({replay:false});
 await store.writeMeta('snapshotMediaMode','none');
 await applySnapshot(await online.fetchSyncSnapshot({media:'none'}),{store,expectedBase:null});
 await api.preferOfflineSnapshot!();
 const bytes=await sharp({create:{width:2,height:2,channels:4,background:'#336699ff'}}).png().toBuffer();
 const file=()=>new File([bytes],'original.png',{type:'image/png'}) as unknown as globalThis.File;
 return {temp,root,entry,trace,online,file,get store(){return store;},get api(){return api;},
  rejectCover(){rejectCover=true;},loseUpload(){loseUpload=true;},loseReplay(){loseReplay=true;},loseAck(){loseAck=true;},omitMedia(){omitMedia=true;},downgrade(){downgrade=true;},
  async cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});api=createOfflineAwareGalleryApi(online,store);await api.preferOfflineSnapshot!();},
  async cleanup(){store.close();await new Promise<void>(resolve=>server.close(()=>resolve()));temp.cleanup();rmSync(root,{recursive:true,force:true});}
 };
}
describe('existing Entry real cold client/server media vertical',()=>{
 it('transports a cold restored preview deletion unchanged after committed response loss and cleans only after durable ACK',async()=>{
  const h=await harness();try{
   await h.online.uploadEntryMedia(h.entry.id,'cover',h.file());
   await h.online.uploadEntryMedia(h.entry.id,'preview',h.file());
   await h.online.uploadEntryMedia(h.entry.id,'preview',h.file());
   await applySnapshot(await h.online.fetchSyncSnapshot({media:'none'}),{store:h.store,expectedBase:await readActiveSnapshot(h.store)});
   const entry=await h.api.getEntry(h.entry.id);
   await h.api.setEntryMediaOrder!(entry.id,[entry.coverRef!,entry.previewRefs[0]!]);
   const original=(await h.store.list())[0]!;
   const prepared=await preparePendingWork(JSON.stringify(await buildPendingWorkExport(h.store)));
   expect(prepared.operations[0]).toEqual(original);
   await h.cold();h.loseReplay();await h.api.replayOfflineOperations!();
   expect(h.trace.filter(row=>row.path.includes('/sync/replay'))).toHaveLength(1);
   expect(await h.store.list()).toHaveLength(1);
   await h.cold();h.loseAck();await h.api.replayOfflineOperations!();
   expect(await h.store.list()).toHaveLength(1);expect(await h.store.readMeta('pendingSnapshotAck')).not.toBeNull();
   await h.cold();await h.api.replayOfflineOperations!();expect(await h.store.list()).toEqual([]);
   const sent=h.trace.filter(row=>row.path.includes('/sync/replay'));expect(sent).toHaveLength(3);
   for(const row of sent)expect(row.body).toEqual(sent[0]!.body);
   expect(sent[1]!.result).toEqual(sent[0]!.result);
   const current=(await readActiveSnapshot(h.store))!.snapshot.payload.entries[0]!;
   expect(current.coverRef).toBe(entry.coverRef);expect(current.previewRefs).toEqual([entry.previewRefs[0]!]);
   expect(readFileSync(join(h.root,current.previewRefs[0]!.replace('/api/assets/','')))).toEqual(Buffer.from(await h.file().arrayBuffer()));
   expect(h.temp.database.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(1);
  }finally{await h.cleanup();}
 },30000);

 it('renders staged preview bytes through the real facade and cold IDB without evicting surviving cache bytes, then reconciles after ACK',async()=>{
  const h=await harness();
  const cached=new Map<string,Response>();
  const priorCaches=globalThis.caches;
  Object.defineProperty(globalThis,'caches',{configurable:true,value:{open:async()=>({delete:async(key:unknown)=>cached.delete(String(key))})}});
  try{
   const cover=await h.online.uploadEntryMedia(h.entry.id,'cover',h.file());
   await applySnapshot(await h.online.fetchSyncSnapshot({media:'none'}),{store:h.store,expectedBase:await readActiveSnapshot(h.store)});
   const coverUrl=h.online.assetUrl(cover.coverRef!);cached.set(coverUrl,new Response('downloaded-cover'));
   const result=await h.api.uploadEntryMedia(h.entry.id,'preview',h.file());
   expect(result.previewRefs).toHaveLength(1);
   expect(result.coverRef).toBe(cover.coverRef);
   expect(Buffer.from(await (await fetch(result.previewRefs[0]!)).arrayBuffer())).toEqual(Buffer.from(await h.file().arrayBuffer()));
   expect(await cached.get(coverUrl)!.clone().text()).toBe('downloaded-cover');
   const original=(await h.store.listMedia())[0]!;
   await h.cold();const detail=await h.api.getEntry(h.entry.id);
   expect(detail.previewRefs).toHaveLength(1);
   expect(Buffer.from(await (await fetch(detail.previewRefs[0]!)).arrayBuffer())).toEqual(Buffer.from(await original.blob.arrayBuffer()));
   expect(await h.store.list()).toEqual([]);expect((await h.store.listMedia())[0]!.uploadId).toBe(original.uploadId);
   h.loseUpload();await h.api.replayOfflineOperations!();await h.cold();
   h.loseAck();await h.api.replayOfflineOperations!();expect(await h.store.listMedia()).toHaveLength(1);
   await h.cold();await h.api.replayOfflineOperations!();expect(await h.store.listMedia()).toEqual([]);
   const current=(await readActiveSnapshot(h.store))!.snapshot.payload.entries[0]!;
   expect(current.coverRef).toBe(cover.coverRef);expect(current.previewRefs).toHaveLength(1);
   expect(readFileSync(join(h.root,current.previewRefs[0]!.replace('/api/assets/','')))).toEqual(Buffer.from(await original.blob.arrayBuffer()));
   const sent=h.trace.filter(row=>row.metadata);expect(sent[0]!.metadata).toEqual(sent[1]!.metadata);expect(sent[0]!.hash).toBe(sent[1]!.hash);
  }finally{Object.defineProperty(globalThis,'caches',{configurable:true,value:priorCaches});await h.cleanup();}
 },30000);
 it('a cover conflict blocks both immutable preview successors on this and cold replay',async()=>{
  const h=await harness();try{
   await h.api.uploadEntryMedia(h.entry.id,'cover',h.file());await h.api.uploadEntryMedia(h.entry.id,'preview',h.file());await h.api.uploadEntryMedia(h.entry.id,'preview',h.file());
   const before=await h.store.listMedia();h.rejectCover();await h.api.replayOfflineOperations!();
   expect(h.trace.filter(row=>row.metadata).map(row=>(row.metadata as {kind:string}).kind)).toEqual(['cover']);
   await h.cold();await h.api.replayOfflineOperations!();expect(h.trace.filter(row=>row.metadata)).toHaveLength(1);
   const after=await h.store.listMedia();expect(after.filter(row=>row.kind==='preview')).toEqual(before.filter(row=>row.kind==='preview'));expect(after.find(row=>row.kind==='cover')!.status).toBe('failed');expect(await h.store.list()).toEqual([]);
   await h.api.discardBlockedOfflineOperations!();expect(await h.store.listMedia()).toEqual([]);
  }finally{await h.cleanup();}
 },30000);

 it('retries unchanged multipart after committed response loss and lost ACK, with ordered previews and no fake create',async()=>{
  const h=await harness();try{
   await h.api.uploadEntryMedia(h.entry.id,'preview',h.file());await h.api.uploadEntryMedia(h.entry.id,'preview',h.file());
   const originals=await h.store.listMedia();expect(originals).toHaveLength(2);expect(await h.store.list()).toEqual([]);
   const exported=await buildPendingWorkExport(h.store); const prepared=await preparePendingWork(JSON.stringify(exported));
   expect(prepared.media.map(row=>row.existingEntry)).toEqual(originals.map(row=>row.existingEntry));
   await h.cold();expect(await h.store.listMedia()).toEqual(originals);
   h.loseUpload();await h.api.replayOfflineOperations!();expect(await h.store.listMedia()).toHaveLength(2);
   expect(h.temp.database.prepare('SELECT COUNT(*) FROM sync_media_upload_receipts').pluck().get()).toBe(1);
   await h.cold();h.loseAck();await h.api.replayOfflineOperations!();expect(await h.store.listMedia()).toHaveLength(2);
   expect(await h.store.readMeta('pendingSnapshotAck')).not.toBeNull();
   await h.cold();await h.api.replayOfflineOperations!();expect(await h.store.listMedia()).toEqual([]);
   expect(await h.store.readMeta('pendingSnapshotAck')).toBeNull();
   const uploads=h.trace.filter(row=>row.metadata);expect(uploads.map(row=>(row.metadata as {ordinal:number}).ordinal)).toEqual([0,0,1,0,1]);
   expect(uploads[0]).toMatchObject({path:uploads[1]!.path,metadata:uploads[1]!.metadata,hash:uploads[1]!.hash,result:uploads[1]!.result});
   const ack=h.trace.filter(row=>row.path.includes('/sync/ack'));expect(ack[1]!.body).toEqual(ack[0]!.body);
   const snapshot=(await readActiveSnapshot(h.store))!.snapshot;const refs=snapshot.payload.entries[0]!.previewRefs;
   expect(refs).toHaveLength(2);for(const ref of refs)expect(readFileSync(join(h.root,ref.replace('/api/assets/','')))).toEqual(Buffer.from(await h.file().arrayBuffer()));
   expect(h.temp.database.prepare('SELECT COUNT(*) FROM sync_media_upload_receipts').pluck().get()).toBe(2);
   expect(h.temp.database.prepare('SELECT COUNT(*) FROM sync_offline_created_entries').pluck().get()).toBe(0);
   expect(h.temp.database.prepare('SELECT COUNT(*) FROM entries').pluck().get()).toBe(1);
   console.log('existing-media HTTP trace',JSON.stringify({uploads:uploads.map(row=>({path:row.path,metadata:row.metadata,hash:row.hash,result:row.result})),acks:ack.map(row=>row.body),receipts:2,entries:1,remainingMedia:0}));
  }finally{await h.cleanup();}
 },30000);
 it('holds all original media with no upload when negotiated capability disappears',async()=>{
  const h=await harness();try{await h.api.uploadEntryMedia(h.entry.id,'preview',h.file());const original=await h.store.listMedia();await h.cold();h.downgrade();await h.api.replayOfflineOperations!();expect(h.trace.filter(row=>row.metadata)).toEqual([]);expect(await h.store.listMedia()).toEqual(original);}finally{await h.cleanup();}
 },30000);
 it('does not clean up a receipt when a checksummed newer snapshot omits the applied media',async()=>{
  const h=await harness();try{await h.api.uploadEntryMedia(h.entry.id,'preview',h.file());h.omitMedia();await h.api.replayOfflineOperations!();expect(await h.store.listMedia()).toHaveLength(1);expect(h.trace.filter(row=>row.path.includes('/sync/ack'))).toEqual([]);}finally{await h.cleanup();}
 },30000);
});

