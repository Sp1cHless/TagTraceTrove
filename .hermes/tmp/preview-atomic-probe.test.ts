import { File } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexedDB } from 'fake-indexeddb';
import sharp from '../../apps/server/node_modules/sharp/lib/index.js';
import { describe, it, expect } from 'vitest';
// Cross-workspace runtime integration: deliberately not part of the web TS rootDir.
const serverModule = async (path: string) => { const target = `../../apps/server/src/${path}.js`; return import(/* @vite-ignore */ target); };
import { createIndexedDbOfflineStore } from '../../apps/web/src/offline/indexeddb-snapshot-store.js';
import { createNativeTransfers } from '../../apps/web/src/offline/native-background-transfer.js';
import { createOfflineAwareGalleryApi } from '../../apps/web/src/offline/offline-api.js';
import { createGalleryApi } from '../../apps/web/src/api/gallery.js';
import { createApiClient } from '../../apps/web/src/api/client.js';
import { applySnapshot, readActiveSnapshot } from '../../apps/web/src/offline/snapshot-store.js';
import { buildPendingWorkExport } from '../../apps/web/src/offline/pending-work-export.js';
import { preparePendingWork } from '../../apps/web/src/offline/pending-work-restore.js';
import type { SyncSnapshot } from '@t3/shared';

async function harness(withNative = false, nativeNeverAttempted = false) {
 const [{createTempFileDatabase},{applyAllMigrations},{createEntry},{createApiApp}]=await Promise.all(['database/testing','database/migrations','repositories/entry-repository','http/app'].map(serverModule));
 const temp=createTempFileDatabase(); applyAllMigrations(temp.database);
 const root=mkdtempSync(join(tmpdir(),'t3-existing-client-'));
 const entry=createEntry(temp.database,{title:'Existing',type:'comic'});
 const app=createApiApp(temp.database,{assetRoot:root});
 const trace:Array<{path:string;metadata?:unknown;hash?:string;result?:unknown;body?:unknown}>=[];
 let loseUpload=false,loseReplay=false,loseAck=false,omitMedia=false,downgrade: 'absent' | 'false' | false=false,rejectCover=false;
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
   if(downgrade && req.url!.includes('/sync/capabilities')) { const value=JSON.parse(bytes.toString());if(downgrade==='absent')delete value.featureFlags.existingEntryMedia;else value.featureFlags.existingEntryMedia=false;bytes=Buffer.from(JSON.stringify(value)); }
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
 const online=createGalleryApi(createApiClient({baseUrl:`http://127.0.0.1:${address.port}/api/`}),`http://127.0.0.1:${address.port}/`);
 const databaseName=`existing-media-${crypto.randomUUID()}`;
 let store=createIndexedDbOfflineStore({indexedDB,databaseName});
 const nativeTrace: Array<{method:string;args:Record<string,unknown>}> = [];
 const native = () => withNative ? {nativeTransfers:createNativeTransfers(store,{call:async(method,args)=>{nativeTrace.push({method,args});return method==='reconcile'?{active:0,completed:0,held:0}:method==='authorizePreviewCancel' || method==='inspectPreviewCancel' ? {neverAttempted:nativeNeverAttempted,uploadIds:(args.uploads as Array<{uploadId:string}>).map(row=>row.uploadId)}:{};}})} : {};
 let api=createOfflineAwareGalleryApi(online,store,native());
 await api.getSyncCapabilities({replay:false});
 await store.writeMeta('snapshotMediaMode','none');
 await applySnapshot(await online.fetchSyncSnapshot({media:'none'}),{store,expectedBase:null});
 await api.preferOfflineSnapshot!();
 const bytes=await sharp({create:{width:2,height:2,channels:4,background:'#336699ff'}}).png().toBuffer();
 const file=()=>new File([bytes],'original.png',{type:'image/png'}) as unknown as globalThis.File;
 return {temp,root,entry,trace,nativeTrace,online,file,get store(){return store;},get api(){return api;},
  rejectCover(){rejectCover=true;},loseUpload(){loseUpload=true;},loseReplay(){loseReplay=true;},loseAck(){loseAck=true;},omitMedia(){omitMedia=true;},downgrade(value: 'absent' | 'false' = 'absent'){downgrade=value;},
  async cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});api=createOfflineAwareGalleryApi(online,store,native());await api.preferOfflineSnapshot!();},
  async cleanup(){store.close();await new Promise<void>(resolve=>server.close(()=>resolve()));temp.cleanup();rmSync(root,{recursive:true,force:true});}
 };
}

describe('same Entry concurrent local edits',()=>{
 it('refuses or refreshes an upload reviewed before a queued local deletion',async()=>{
  const h=await harness();let release!:()=>void;
  try {
   const colors=['#ef3030','#3030ef'];
   for(const color of colors){const bytes=await sharp({create:{width:3,height:3,channels:3,background:color}}).png().toBuffer();await h.online.uploadEntryMedia(h.entry.id,'preview',new File([bytes],'seed.png',{type:'image/png'}) as unknown as globalThis.File);}
   const active=await readActiveSnapshot(h.store);
   await applySnapshot(await h.online.fetchSyncSnapshot({media:'none'}),{store:h.store,expectedBase:active});
   const before=await h.api.getEntry(h.entry.id);
   expect(before.previewRefs).toHaveLength(2);
   const file=h.file();const original=file.arrayBuffer.bind(file);
   let entered!:()=>void;const enteredPromise=new Promise<void>(r=>entered=r);const gate=new Promise<void>(r=>release=r);
   Object.defineProperty(file,'arrayBuffer',{value:async()=>{entered();await gate;return original();}});
   const staged=h.api.uploadEntryMedia(h.entry.id,'preview',file).then(value=>({value,error:null}),error=>({value:null,error}));
   await enteredPromise;
   await h.api.setEntryMediaOrder!(h.entry.id,[before.previewRefs[0]!]);
   expect(await h.store.list()).toHaveLength(1);
   release();const result=await staged;
   const media=await h.store.listMedia();
   console.log('concurrent local edit observation',JSON.stringify({error:result.error?String(result.error):null,originalReviewedRefs:before.previewRefs,staged:media.map(row=>({ordinal:row.ordinal,existingEntry:row.existingEntry}))}));
   if(result.error){expect(String(result.error)).toMatch(/changed|review|capture|queue|stale/iu);expect(media).toEqual([]);}
   else {expect(media).toHaveLength(1);expect(media[0]!.existingEntry!.expectedPreviewRefs).toEqual([before.previewRefs[0]!]);expect(media[0]!.ordinal).toBe(1);}
  } finally {release?.();await h.cleanup();}
 },30000);
});
