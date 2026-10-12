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
import { createMemoryOfflineStore } from '../src/offline/memory-offline-store.js';
import { createNativeTransfers } from '../src/offline/native-background-transfer.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { applySnapshot, readActiveSnapshot } from '../src/offline/snapshot-store.js';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
import { preparePendingWork } from '../src/offline/pending-work-restore.js';
import { nativeMutationContract, type SyncSnapshot } from '@t3/shared';

async function harness(withNative = false, nativeNeverAttempted = false, memory = false) {
 const [{createTempFileDatabase},{applyAllMigrations},{createEntry},{createApiApp}]=await Promise.all(['database/testing','database/migrations','repositories/entry-repository','http/app'].map(serverModule));
 const temp=createTempFileDatabase(); applyAllMigrations(temp.database);
 const root=mkdtempSync(join(tmpdir(),'t3-existing-client-'));
 const entry=createEntry(temp.database,{title:'Existing',type:'comic'});
 const app=createApiApp(temp.database,{assetRoot:root});
 const trace:Array<{path:string;metadata?:unknown;hash?:string;result?:unknown;body?:unknown}>=[];
 let loseUpload=false,loseReplay=false,loseAck=false,omitMedia=false,downgrade: 'absent' | 'false' | false=false,rejectCover=false;
 let assetFault: 'wrong' | 'missing' | 'failed' | null=null;
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
   if(assetFault && req.url!.startsWith('/api/assets/')){res.writeHead(assetFault==='missing'?404:assetFault==='failed'?503:200,{'content-type':'image/png'});res.end('not-the-original-image');return;}
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(bytes);
  }catch(error){res.writeHead(500);res.end(String(error));}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address() as {port:number};
 const online=createGalleryApi(createApiClient({baseUrl:`http://127.0.0.1:${address.port}/api/`}),`http://127.0.0.1:${address.port}/`);
 const databaseName=`existing-media-${crypto.randomUUID()}`;
 const openStore=()=>memory ? {...createMemoryOfflineStore(),close(){}} : createIndexedDbOfflineStore({indexedDB,databaseName});
 let store=openStore();
 const nativeTrace: Array<{method:string;args:Record<string,unknown>}> = [];
 const native = () => withNative && 'captureNativeTransfers' in store ? {nativeTransfers:createNativeTransfers(store,{call:async(method,args)=>{nativeTrace.push({method,args});return nativeNeverAttempted && method==='status'?{protocolVersion:1,planVersion:1,operationKinds:Object.keys(nativeMutationContract)}:method==='allocateUploadId'?{uploadId:crypto.randomUUID()}:method==='stageStandaloneMedia'?{stageId:crypto.randomUUID()}:method==='reconcile'?{active:0,completed:0,held:0}:method==='authorizePreviewCancel' || method==='inspectPreviewCancel' ? {neverAttempted:nativeNeverAttempted,uploadIds:(args.uploads as Array<{uploadId:string}>).map(row=>row.uploadId)}:{};}})} : {};
 let api=createOfflineAwareGalleryApi(online,store,native());
 await api.getSyncCapabilities({replay:false});
 await store.writeMeta('snapshotMediaMode','none');
 await applySnapshot(await online.fetchSyncSnapshot({media:'none'}),{store,expectedBase:null});
 await api.preferOfflineSnapshot!();
 const bytes=await sharp({create:{width:2,height:2,channels:4,background:'#336699ff'}}).png().toBuffer();
 const file=()=>new File([bytes],'original.png',{type:'image/png'}) as unknown as globalThis.File;
 return {temp,root,entry,trace,nativeTrace,online,file,get store(){return store;},get api(){return api;},
  assetFault(value: 'wrong' | 'missing' | 'failed' | null){assetFault=value;},correctSnapshot(){omitMedia=false;},rejectCover(){rejectCover=true;},loseUpload(){loseUpload=true;},loseReplay(){loseReplay=true;},loseAck(){loseAck=true;},omitMedia(){omitMedia=true;},downgrade(value: 'absent' | 'false' = 'absent'){downgrade=value;},
  async cold(){store.close();store=openStore();api=createOfflineAwareGalleryApi(online,store,native());await api.preferOfflineSnapshot!();},
  async cleanup(){store.close();await new Promise<void>(resolve=>server.close(()=>resolve()));temp.cleanup();rmSync(root,{recursive:true,force:true});}
 };
}
describe('existing Entry real cold client/server media vertical',()=>{
 it.each(['incomplete','wrong'] as const)('deletion-only refuses %s survivor proof before activation ACK and cleanup',async fault=>{
  const h=await harness();const priorCaches=globalThis.caches;const cached=new Map<string,Response>();
  Object.defineProperty(globalThis,'caches',{configurable:true,value:{open:async()=>({match:async(key:unknown)=>cached.get(String(key))?.clone(),delete:async(key:unknown)=>cached.delete(String(key))})}});
  try{
   const images=await Promise.all(['#ff0000ff','#00ff00ff','#0000ffff'].map(async background=>new File([await sharp({create:{width:2,height:2,channels:4,background}}).png().toBuffer()],'image.png',{type:'image/png'}) as unknown as globalThis.File));
   await h.online.uploadEntryMedia(h.entry.id,'cover',images[0]!);for(const image of images.slice(1))await h.online.uploadEntryMedia(h.entry.id,'preview',image);
   await applySnapshot(await h.online.fetchSyncSnapshot({media:'none'}),{store:h.store,expectedBase:await readActiveSnapshot(h.store)});
   const entry=await h.api.getEntry(h.entry.id);
   for(const ref of [entry.coverRef!,...entry.previewRefs])cached.set(h.online.assetUrl(ref),new Response(readFileSync(join(h.root,ref.replace('/api/assets/','')))));
   const survivorUrl=h.online.assetUrl(entry.previewRefs[1]!);const originalBytes=Buffer.from(await cached.get(survivorUrl)!.clone().arrayBuffer());
   await h.api.setEntryMediaOrder!(entry.id,[entry.coverRef!,entry.previewRefs[1]!]);const original=(await h.store.list())[0]!;
   await h.cold();const base=await readActiveSnapshot(h.store);if(fault==='incomplete')h.omitMedia();else h.assetFault('wrong');
   await h.api.replayOfflineOperations!();
   expect(await h.store.list()).toEqual([expect.objectContaining({opId:original.opId,payload:original.payload,baseValues:original.baseValues,status:'pending'})]);
   expect(await readActiveSnapshot(h.store)).toEqual(base);expect(await h.store.readMeta('verifiedReplayProjection')).toBeNull();
   expect(h.trace.filter(row=>row.path.includes('/sync/ack'))).toEqual([]);expect(Buffer.from(await cached.get(survivorUrl)!.clone().arrayBuffer())).toEqual(originalBytes);
   h.correctSnapshot();h.assetFault(null);await h.cold();h.loseAck();await h.api.replayOfflineOperations!();
   expect(await h.store.list()).toHaveLength(1);expect(await h.store.readMeta('pendingSnapshotAck')).not.toBeNull();
   expect(Buffer.from(await cached.get(survivorUrl)!.clone().arrayBuffer())).toEqual(originalBytes);
   await h.cold();await h.api.replayOfflineOperations!();expect(await h.store.list()).toEqual([]);
   const sent=h.trace.filter(row=>row.path.includes('/sync/replay'));for(const row of sent)expect(row.body).toEqual(sent[0]!.body);
   expect(h.temp.database.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(1);
   const current=await h.online.getEntry(entry.id);expect(readFileSync(join(h.root,current.previewRefs[0]!.replace('/api/assets/','')))).toEqual(originalBytes);
  }finally{Object.defineProperty(globalThis,'caches',{configurable:true,value:priorCaches});await h.cleanup();}
 },30000);
 it.each(['wrong','missing','failed'] as const)('retains exact staged bytes and does not validate or ACK a legal snapshot with %s asset bytes',async fault=>{
  const h=await harness();try{
   await h.api.uploadEntryMedia(h.entry.id,'preview',h.file());const original=(await h.store.listMedia())[0]!;
   const base=await readActiveSnapshot(h.store);h.assetFault(fault);await h.api.replayOfflineOperations!();
   const retained=(await h.store.listMedia())[0]!;expect(retained).toMatchObject({uploadId:original.uploadId,sha256:original.sha256,existingEntry:original.existingEntry});
   expect(Buffer.from(await retained.blob.arrayBuffer())).toEqual(Buffer.from(await original.blob.arrayBuffer()));
   expect(h.trace.some(row=>row.path.startsWith('/api/assets/'))).toBe(true);
   expect(h.trace.filter(row=>row.path.includes('/sync/ack'))).toEqual([]);
   expect(await h.store.readMeta('verifiedReplayProjection')).toBeNull();expect(await readActiveSnapshot(h.store)).toEqual(base);
  }finally{await h.cleanup();}
 },30000);
 it.each([false,true])('atomically rejects an upload captured before a same-Entry deletion during hashing (memory=%s)',async memory=>{
  const h=await harness(false,false,memory);let release!:()=>void;
  try{
   for(const color of ['#ef3030','#3030ef'])await h.online.uploadEntryMedia(h.entry.id,'preview',new File([await sharp({create:{width:3,height:3,channels:3,background:color}}).png().toBuffer()],'seed.png',{type:'image/png'}) as unknown as globalThis.File);
   await applySnapshot(await h.online.fetchSyncSnapshot({media:'none'}),{store:h.store,expectedBase:await readActiveSnapshot(h.store)});
   const before=await h.api.getEntry(h.entry.id);expect(before.previewRefs).toHaveLength(2);
   const file=h.file(),original=file.arrayBuffer.bind(file);let entered!:()=>void;
   const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
   Object.defineProperty(file,'arrayBuffer',{value:async()=>{entered();await gate;return original();}});
   const staging=h.api.uploadEntryMedia(h.entry.id,'preview',file).then(()=>null,error=>error);
   await started;await h.api.setEntryMediaOrder!(h.entry.id,[before.previewRefs[0]!]);
   const queued=await h.store.list();expect(queued).toHaveLength(1);
   release();expect(String(await staging)).toMatch(/changed|review|capture|queue|stale/iu);
   expect(await h.store.listMedia()).toEqual([]);expect(await h.store.list()).toEqual(queued);
  }finally{release?.();await h.cleanup();}
 },30000);
 it('pauses the actual native mirror and rejects staged cancellation without durable native never-attempted proof',async()=>{
  const h=await harness(true);try{
   await h.api.uploadEntryMedia(h.entry.id,'preview',h.file());const before=await h.store.listMedia();
   await expect(h.api.setEntryMediaOrder!(h.entry.id,[])).rejects.toThrow(/Native.*attempt/u);
   expect(h.nativeTrace.filter(row=>row.method==='pause').at(-1)?.args).toMatchObject({captureUploadIds:[before[0]!.uploadId]});
   expect(await h.store.listMedia()).toEqual(before);expect(await h.store.list()).toEqual([]);
   // The API answers with a code; the page turns it into the sentence.
   expect(await h.api.getEntryMediaRemovalBlockReason!(h.entry.id)).toBe('native-uncertain');
   // A cover that was never sent is not an uncertain attempt (reported from the
   // device, where the editor refused a fresh work's cover with the wrong
   // sentence). The reason must name that situation.
   await h.api.uploadEntryMedia(h.entry.id,'cover',new File(['cover'],'cover.png',{type:'image/png'}) as unknown as globalThis.File);
   expect(await h.api.getEntryMediaRemovalBlockReason!(h.entry.id)).toBe('cover-not-uploaded');
  }finally{await h.cleanup();}
 },30000);

 it('does not upload a predecessor for an already conflicted media order while an independent Entry advances',async()=>{
  const h=await harness();try{
   const {createEntry}=await serverModule('repositories/entry-repository');const peer=createEntry(h.temp.database,{title:'Peer',type:'comic'});
   await h.online.uploadEntryMedia(h.entry.id,'cover',h.file());await h.online.uploadEntryMedia(h.entry.id,'preview',h.file());
   await applySnapshot(await h.online.fetchSyncSnapshot({media:'none'}),{store:h.store,expectedBase:await readActiveSnapshot(h.store)});
   await h.api.uploadEntryMedia(h.entry.id,'preview',h.file());const entry=await h.api.getEntry(h.entry.id);
   await h.api.setEntryMediaOrder!(entry.id,[entry.coverRef!,entry.previewRefs[1]!]);
   const order=(await h.store.list())[0]!;await h.store.update(order.opId,{status:'conflict',lastError:'review required'});
   await h.api.updateEntry(peer.id,{title:'Advanced'});const media=await h.store.listMedia();
   await h.cold();await h.api.replayOfflineOperations!();
   expect(h.trace.filter(row=>row.metadata)).toEqual([]);expect(await h.store.listMedia()).toEqual(media);
   expect((await h.online.getEntry(peer.id)).title).toBe('Advanced');expect(await h.store.list()).toHaveLength(1);
  }finally{await h.cleanup();}
 },30000);
 it('restores and replays title upload title deletion in one same-Entry causal revision chain with exact retries and cold ACK-loss bytes',async()=>{
  const h=await harness();try{
   await h.online.uploadEntryMedia(h.entry.id,'cover',h.file());await h.online.uploadEntryMedia(h.entry.id,'preview',h.file());
   await applySnapshot(await h.online.fetchSyncSnapshot({media:'none'}),{store:h.store,expectedBase:await readActiveSnapshot(h.store)});
   await h.api.updateEntry(h.entry.id,{title:'Before'});await h.api.uploadEntryMedia(h.entry.id,'preview',h.file());
   await h.api.updateEntry(h.entry.id,{title:'After'});
   const entry=await h.api.getEntry(h.entry.id);await h.api.setEntryMediaOrder!(entry.id,[entry.coverRef!,entry.previewRefs[1]!]);
   const original=await h.store.list();const media=await h.store.listMedia();const backup=JSON.stringify(await buildPendingWorkExport(h.store));
   for(const row of original)await h.store.remove(row.opId);for(const row of media)await h.store.removeMedia(row.uploadId);
   await h.api.restorePendingWork!(backup);await h.cold();expect(await h.store.list()).toEqual(original);
   h.loseReplay();await h.api.replayOfflineOperations!();await h.cold();h.loseAck();await h.api.replayOfflineOperations!();
   expect(h.trace.filter(row=>row.path.includes('/sync/replay') || row.metadata).map(row=>row.metadata?'media':(row.body as {operationKind:string}).operationKind)).toEqual(['entry.update','entry.update','media','entry.update','entry.media.set']);
   expect(await h.store.list()).toHaveLength(3);expect(await h.store.listMedia()).toHaveLength(1);
   await h.cold();const displayed=await h.api.getEntry(entry.id);expect(displayed.title).toBe('After');expect(displayed.previewRefs).toHaveLength(1);
   expect(readFileSync(join(h.root,displayed.previewRefs[0]!.replace('/api/assets/','')))).toEqual(Buffer.from(await h.file().arrayBuffer()));
   await h.api.replayOfflineOperations!();expect(await h.store.list()).toEqual([]);expect(await h.store.listMedia()).toEqual([]);
   expect((await h.online.getEntry(entry.id)).title).toBe('After');
   const sent=h.trace.filter(row=>row.path.includes('/sync/replay'));expect(sent[0]!.body).toEqual(sent[1]!.body);
  }finally{await h.cleanup();}
 },30000);
 it.each([false,true])('cancels an unsent staged preview without resurrecting it and rebuilds the surviving later Blob durably (native=%s)',async native=>{
  const h=await harness(native,true);try{
   await h.online.uploadEntryMedia(h.entry.id,'cover',h.file());
   await applySnapshot(await h.online.fetchSyncSnapshot({media:'none'}),{store:h.store,expectedBase:await readActiveSnapshot(h.store)});
   await h.api.uploadEntryMedia(h.entry.id,'preview',h.file());
   const later=new File([await sharp({create:{width:2,height:2,channels:4,background:'#ffff00ff'}}).png().toBuffer()],'later.png',{type:'image/png'}) as unknown as globalThis.File;
   await h.api.uploadEntryMedia(h.entry.id,'preview',later);await h.cold();
   const before=(await h.store.listMedia()).sort((a,b)=>a.ordinal-b.ordinal);const entry=await h.api.getEntry(h.entry.id);
   expect(entry.previewRefs[0]).toContain(`#t3-upload=${before[0]!.uploadId}`);
   expect(await h.api.getEntryMediaRemovalBlockReason!(entry.id)).toBeNull();
   await h.api.setEntryMediaOrder!(entry.id,[entry.coverRef!,entry.previewRefs[1]!]);await h.cold();
   const remaining=await h.store.listMedia();expect(remaining).toHaveLength(1);
   expect(remaining[0]).toMatchObject({uploadId:before[1]!.uploadId,ordinal:0,sha256:before[1]!.sha256,existingEntry:{expectedPreviewRefs:[]}});
   expect(await h.store.list()).toEqual([]);
   const visible=await h.api.getEntry(entry.id);expect(visible.previewRefs).toHaveLength(1);
   expect(Buffer.from(await (await fetch(visible.previewRefs[0]!)).arrayBuffer())).toEqual(Buffer.from(await later.arrayBuffer()));
   await h.api.replayOfflineOperations!();
   expect(h.trace.filter(row=>row.metadata).map(row=>(row.metadata as {ordinal:number}).ordinal)).toEqual([0]);
   expect(h.trace.filter(row=>row.metadata).map(row=>row.path)).toEqual([`/api/sync/media/${before[1]!.uploadId}`]);
   expect(h.trace.find(row=>row.metadata)!.hash).toBe(before[1]!.sha256);
   if(native){expect(h.nativeTrace.some(row=>row.method==='activateStandaloneMedia')).toBe(true);expect(h.nativeTrace.find(row=>row.method==='authorizePreviewCancel')?.args.uploads).toHaveLength(2);}
   expect(await h.store.listMedia()).toEqual([]);
   const current=await h.online.getEntry(entry.id);expect(readFileSync(join(h.root,current.previewRefs[0]!.replace('/api/assets/','')))).toEqual(Buffer.from(await later.arrayBuffer()));
  }finally{await h.cleanup();}
 },30000);
 it('rejects cancellation of an attempted uncertain staged preview without changing its exact retry identity',async()=>{
  const h=await harness();try{
   await h.api.uploadEntryMedia(h.entry.id,'preview',h.file());h.loseUpload();await h.api.replayOfflineOperations!();await h.cold();
   const before=await h.store.listMedia();
   await expect(h.api.setEntryMediaOrder!(h.entry.id,[])).rejects.toThrow(/attempt|uncertain/u);
   expect(await h.store.listMedia()).toEqual(before);expect(await h.store.list()).toEqual([]);
  }finally{await h.cleanup();}
 },30000);
 it.each(['absent','false'] as const)('holds dependent media order unchanged when upload capability is %s while an independent Entry advances',async flag=>{
  const h=await harness();try{
   const {createEntry}=await serverModule('repositories/entry-repository');
   const peer=createEntry(h.temp.database,{title:'Independent',type:'comic'});
   await h.online.uploadEntryMedia(h.entry.id,'cover',h.file());await h.online.uploadEntryMedia(h.entry.id,'preview',h.file());
   await applySnapshot(await h.online.fetchSyncSnapshot({media:'none'}),{store:h.store,expectedBase:await readActiveSnapshot(h.store)});
   await h.api.uploadEntryMedia(h.entry.id,'preview',h.file());
   const entry=await h.api.getEntry(h.entry.id);
   await h.api.setEntryMediaOrder!(entry.id,[entry.coverRef!,entry.previewRefs[1]!]);
   await h.api.updateEntry(peer.id,{title:'Advanced'});
   const queued=await h.store.list();const original=queued[0]!;const independentUid=queued[1]!.entityUid;const media=await h.store.listMedia();
   await h.cold();h.downgrade(flag);await h.api.replayOfflineOperations!();
   expect(h.trace.filter(row=>row.metadata)).toEqual([]);
   expect(h.trace.filter(row=>row.path.includes('/sync/replay')).map(row=>(row.body as {entityUid:string}).entityUid)).toEqual([independentUid]);
   expect(await h.store.list()).toEqual([original]);expect(await h.store.listMedia()).toEqual(media);
   expect((await h.online.getEntry(peer.id)).title).toBe('Advanced');
  }finally{await h.cleanup();}
 },30000);

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
   // Restore into an actually empty durable queue, not just parse the export.
   const backup=JSON.stringify(await buildPendingWorkExport(h.store));
   await h.store.remove(original.opId);
   await h.api.restorePendingWork!(backup);
   expect(await h.store.list()).toEqual([original]);
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

 it('keeps byte identity through consecutive cold deletions and unchanged response-loss retries',async()=>{
  const h=await harness();try{
   const images=await Promise.all(['#ff0000ff','#00ff00ff','#0000ffff','#ffff00ff'].map(async background=>new File([await sharp({create:{width:2,height:2,channels:4,background}}).png().toBuffer()],'image.png',{type:'image/png'}) as unknown as globalThis.File));
   await h.online.uploadEntryMedia(h.entry.id,'cover',images[0]!);
   for(const image of images.slice(1))await h.online.uploadEntryMedia(h.entry.id,'preview',image);
   await applySnapshot(await h.online.fetchSyncSnapshot({media:'none'}),{store:h.store,expectedBase:await readActiveSnapshot(h.store)});
   let entry=await h.api.getEntry(h.entry.id);
   await h.api.setEntryMediaOrder!(entry.id,[entry.coverRef!,...entry.previewRefs.slice(1)]);
   await h.cold();entry=await h.api.getEntry(h.entry.id);
   expect(entry.previewRefs).toHaveLength(2);
   await h.api.setEntryMediaOrder!(entry.id,[entry.coverRef!,entry.previewRefs[1]!]);
   const original=await h.store.list();
   expect((await preparePendingWork(JSON.stringify(await buildPendingWorkExport(h.store)))).operations).toEqual(original);
   await h.cold();h.loseReplay();await h.api.replayOfflineOperations!();
   await h.cold();h.loseAck();await h.api.replayOfflineOperations!();
   expect(await h.store.list()).toHaveLength(2);
   await h.cold();const displayed=await h.api.getEntry(h.entry.id);
   expect(displayed.previewRefs).toHaveLength(1);
   const shown=displayed.previewRefs[0]!;
   const shownBytes=shown.startsWith('blob:') ? Buffer.from(await (await fetch(shown)).arrayBuffer()) : readFileSync(join(h.root,shown.replace('/api/assets/','')));
   expect(shownBytes).toEqual(Buffer.from(await images[3]!.arrayBuffer()));
   await h.api.replayOfflineOperations!();
   expect(await h.store.list()).toEqual([]);
   const current=await h.online.getEntry(h.entry.id);
   expect(current.previewRefs).toHaveLength(1);
   expect(readFileSync(join(h.root,current.previewRefs[0]!.replace('/api/assets/','')))).toEqual(Buffer.from(await images[3]!.arrayBuffer()));
   const sent=h.trace.filter(row=>row.path.includes('/sync/replay'));
   expect(sent[0]!.body).toEqual(sent[1]!.body);
   expect(h.temp.database.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(2);
  }finally{await h.cleanup();}
 },30000);

 it('restores deletion and appended Blob atomically and replays their causal byte order',async()=>{
  const h=await harness();try{
   const images=await Promise.all(['#ff0000ff','#00ff00ff','#0000ffff','#ffff00ff'].map(async background=>new File([await sharp({create:{width:2,height:2,channels:4,background}}).png().toBuffer()],'image.png',{type:'image/png'}) as unknown as globalThis.File));
   await h.online.uploadEntryMedia(h.entry.id,'cover',images[0]!);
   for(const image of images.slice(1,3))await h.online.uploadEntryMedia(h.entry.id,'preview',image);
   await applySnapshot(await h.online.fetchSyncSnapshot({media:'none'}),{store:h.store,expectedBase:await readActiveSnapshot(h.store)});
   const entry=await h.api.getEntry(h.entry.id);
   await h.api.setEntryMediaOrder!(entry.id,[entry.coverRef!,entry.previewRefs[1]!]);
   await h.api.uploadEntryMedia(entry.id,'preview',images[3]!);
   const original=await h.store.list();const media=await h.store.listMedia();
   const backup=JSON.stringify(await buildPendingWorkExport(h.store));
   await h.store.remove(original[0]!.opId);await h.store.removeMedia(media[0]!.uploadId);
   await h.api.restorePendingWork!(backup);await h.cold();
   expect(await h.store.list()).toEqual(original);
   expect(Buffer.from(await (await h.store.listMedia())[0]!.blob.arrayBuffer())).toEqual(Buffer.from(await images[3]!.arrayBuffer()));
   await h.api.replayOfflineOperations!();
   const current=await h.online.getEntry(entry.id);
   expect(current.previewRefs).toHaveLength(2);
   for(const [i,ref] of current.previewRefs.entries())expect(readFileSync(join(h.root,ref.replace('/api/assets/','')))).toEqual(Buffer.from(await images[i+2]!.arrayBuffer()));
   expect(h.trace.filter(row=>row.body && row.path.includes('/sync/replay') || row.metadata).map(row=>row.metadata?'media':'operation')).toEqual(['operation','media']);
   expect(await h.store.list()).toEqual([]);expect(await h.store.listMedia()).toEqual([]);
  }finally{await h.cleanup();}
 },30000);

 it('keeps an appended Blob after deleting an older preview across cold replay',async()=>{
  const h=await harness();try{
   const images=await Promise.all(['#ff0000ff','#00ff00ff','#0000ffff'].map(async background=>new File([await sharp({create:{width:2,height:2,channels:4,background}}).png().toBuffer()],'image.png',{type:'image/png'}) as unknown as globalThis.File));
   await h.online.uploadEntryMedia(h.entry.id,'cover',images[0]!);await h.online.uploadEntryMedia(h.entry.id,'preview',images[1]!);
   await applySnapshot(await h.online.fetchSyncSnapshot({media:'none'}),{store:h.store,expectedBase:await readActiveSnapshot(h.store)});
   await h.api.uploadEntryMedia(h.entry.id,'preview',images[2]!);await h.cold();
   const entry=await h.api.getEntry(h.entry.id);
   await h.api.setEntryMediaOrder!(entry.id,[entry.coverRef!,entry.previewRefs[1]!]);
   await h.cold();expect((await h.api.getEntry(entry.id)).previewRefs).toHaveLength(1);
   await h.api.replayOfflineOperations!();
   const current=await h.online.getEntry(entry.id);expect(current.previewRefs).toHaveLength(1);
   expect(readFileSync(join(h.root,current.previewRefs[0]!.replace('/api/assets/','')))).toEqual(Buffer.from(await images[2]!.arrayBuffer()));
   expect(h.trace.filter(row=>row.path.includes('/sync/replay') || row.metadata).map(row=>row.metadata?'media':'operation')).toEqual(['media','operation']);
   expect(await h.store.list()).toEqual([]);expect(await h.store.listMedia()).toEqual([]);
  }finally{await h.cleanup();}
 },30000);

 it('retains a conflict when a peer changes bytes behind the same desired positional refs',async()=>{
  const h=await harness();try{
   await h.online.uploadEntryMedia(h.entry.id,'cover',h.file());
   await h.online.uploadEntryMedia(h.entry.id,'preview',h.file());
   await h.online.uploadEntryMedia(h.entry.id,'preview',h.file());
   await applySnapshot(await h.online.fetchSyncSnapshot({media:'none'}),{store:h.store,expectedBase:await readActiveSnapshot(h.store)});
   const entry=await h.api.getEntry(h.entry.id);
   await h.api.setEntryMediaOrder!(entry.id,[entry.coverRef!,entry.previewRefs[0]!]);
   const original=(await h.store.list())[0]!;
   // Peer keeps the OTHER picture. Renaming makes its URL equal to our desired
   // URL, but the reviewed Entry revision is no longer valid.
   const peer=new File([await sharp({create:{width:2,height:2,channels:4,background:'#ff0000ff'}}).png().toBuffer()],'peer.png',{type:'image/png'}) as unknown as globalThis.File;
   await h.online.uploadEntryMedia(entry.id,'preview',peer);
   const serverEntry=await h.online.getEntry(entry.id);
   await h.online.setEntryMediaOrder!(entry.id,[entry.coverRef!,serverEntry.previewRefs[2]!]);
   await h.cold();await h.api.replayOfflineOperations!();
   expect(await h.store.list()).toEqual([expect.objectContaining({opId:original.opId,status:'conflict',payload:original.payload,baseValues:original.baseValues})]);
   expect(h.trace.filter(row=>row.path.includes('/sync/replay'))[0]!.result).toMatchObject({status:'conflict'});
   const current=await h.online.getEntry(entry.id);
   expect(readFileSync(join(h.root,current.previewRefs[0]!.replace('/api/assets/','')))).toEqual(Buffer.from(await peer.arrayBuffer()));
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

