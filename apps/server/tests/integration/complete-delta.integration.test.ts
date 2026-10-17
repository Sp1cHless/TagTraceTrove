import { expect, it } from 'vitest';
import { syncCapabilitiesSchema } from '@t3/shared';

it('strict HTTP capabilities advertise complete snapshot delta on the migrated server', async () => {
  const db = createMigratedMemoryDatabase();
  try {
    const response = await createApiApp(db).request('http://delta.test/api/sync/capabilities');
    expect(response.status).toBe(200);
    const capabilities = syncCapabilitiesSchema.parse(await response.json());
    expect(capabilities.featureFlags.completeSnapshotDelta).toBe(true);
  } finally { db.close(); }
});
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { buildSyncSnapshot } from '../../src/sync/sync-service.js';
import { createApiApp } from '../../src/http/app.js';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

it.each(['lost response','HTTP rejection'] as const)('cold IndexedDB reconnect retries restored immutable operations and media, then handles ACK %s before cleanup', async (ackFailure) => {
  const paths=['../../../web/src/api/gallery.js','../../../web/src/api/client.js','../../../web/src/offline/indexeddb-snapshot-store.js','../../../web/src/offline/offline-sync.js','../../../web/src/offline/offline-api.js','../../../web/src/offline/snapshot-store.js','../../../web/src/offline/pending-work-export.js','../../../web/src/offline/connection-recovery.js'];
  paths.push('../../../web/node_modules/fake-indexeddb/build/esm/index.js');
  const [gallery,client,idb,sync,facade,snapshots,exports,recovery,fake]=await Promise.all(paths.map(path=>import(path)));
  const {indexedDB}=fake;
  const db=createMigratedMemoryDatabase(); const root=mkdtempSync(join(tmpdir(),'t3-cold-delta-'));
  const databaseName=`cold-delta-${crypto.randomUUID()}`;
  let store=idb.createIndexedDbOfflineStore({indexedDB,databaseName});
  const calls:Array<{url:string;body:string}>=[]; const ackBodies:string[]=[];
  let disconnected=false; let loseReplay=true; let rejectAck=true; let cleanupRecovery:(()=>void)|undefined;
  const state={mode:'online' as 'online'|'offline',lastFallbackAt:null as string|null,lastReplayError:null as string|null};
  try {
    createEntry(db,{title:'Seed',type:'game'});
    const app=createApiApp(db,{assetRoot:root});
    const online=gallery.createGalleryApi(client.createApiClient({baseUrl:'http://delta.test/api/',fetchImplementation:async(input:RequestInfo|URL,init?:RequestInit)=>{
      if(disconnected) throw new TypeError('Offline');
      const url=String(input);calls.push({url,body:typeof init?.body==='string'?init.body:''});
      if(url.includes('/sync/ack')) {
        const active=await snapshots.readActiveSnapshot(store);
        expect(active?.snapshot.header.changeSeq).toBeGreaterThanOrEqual(JSON.parse(String(init?.body)).cursorSeq);
        expect(await store.readMeta('pendingSnapshotAck')).not.toBeNull();
        ackBodies.push(String(init?.body));
        if (rejectAck && ackFailure==='HTTP rejection') return new Response(JSON.stringify({message:'ACK rejected'}),{status:409,headers:{'content-type':'application/json'}});
      }
      const response=await app.request(url,init);
      if(url.includes('/sync/replay') && loseReplay) {loseReplay=false;expect(response.status).toBe(200);throw new TypeError('Committed replay response lost');}
      if(url.includes('/sync/ack') && rejectAck) {expect(response.status).toBe(200);throw new TypeError('Committed ACK response lost');}
      return response;
    }}));
    expect((await online.getSyncCapabilities()).featureFlags.completeSnapshotDelta).toBe(true);
    let api=facade.createOfflineAwareGalleryApi(online,store,{state});
    expect((await sync.downloadOfflineSnapshot({api,store,media:'none'})).ok).toBe(true);
    disconnected=true;await api.preferOfflineSnapshot('disconnect');
    const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#ff0000'}}).png().toBuffer();
    const created=await api.enqueueOfflineEntryCreate({title:'Created',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:new File([new Uint8Array(bytes)],'cover.png',{type:'image/png'}),previewFile:null});
    await store.captureLocalFinalState(true); // A submitted original is the boundary this retry test exercises.
    await api.enqueueOfflinePendingEntryMetadata(created.localKey,{title:'Final',uploadDate:null,pageCount:7});
    const original=await store.list();const media=await store.listMedia();
    const originalBlob=new Uint8Array(await media[0].blob.arrayBuffer());
    const exported=JSON.stringify(await exports.buildPendingWorkExport(store));
    for(const row of original)await store.remove(row.opId);
    for(const row of media)await store.removeMedia(row.uploadId);
    const beforeRestore=calls.length;
    await api.previewPendingWorkRestore(exported);await api.restorePendingWork(exported);
    expect(calls.length).toBe(beforeRestore);
    expect(await store.list()).toEqual(original);
    expect(new Uint8Array(await (await store.listMedia())[0].blob.arrayBuffer())).toEqual(originalBlob);
    disconnected=false;calls.length=0;
    await api.getSyncCapabilities();
    expect(await store.list()).toHaveLength(2);expect(await store.listMedia()).toHaveLength(1);
    const sentFirst=calls.find(row=>row.url.includes('/sync/replay'))!.body;
    store.close();store=idb.createIndexedDbOfflineStore({indexedDB,databaseName});
    api=facade.createOfflineAwareGalleryApi(online,store,{state});
    await api.preferOfflineSnapshot('startup');expect(state.mode).toBe('offline');
    expect(new Uint8Array(await (await store.listMedia())[0].blob.arrayBuffer())).toEqual(originalBlob);
    const windowTarget=new EventTarget();const documentTarget=new EventTarget();
    let reconnect:Promise<void>|undefined;
    cleanupRecovery=recovery.startConnectionRecovery({probe:()=>api.getSyncCapabilities({replay:false}),isOffline:()=>state.mode==='offline',isVisible:()=>true,windowTarget,documentTarget,onProbeSuccess:()=>{reconnect=api.flushOfflineOutbox();},intervalMs:100000});
    const {vi}=await import('vitest');
    await vi.waitFor(()=>expect(reconnect).toBeDefined());await reconnect;
    expect(state.mode).toBe('online');
    expect(calls.filter(row=>row.url.includes('/sync/replay'))[1]?.body).toBe(sentFirst);
    expect(await store.list()).toHaveLength(2);expect(await store.listMedia()).toHaveLength(1);
    expect(state.lastReplayError).toMatch(/ACK response lost|ACK rejected/u);
    const pending=await store.readMeta('pendingSnapshotAck');expect(pending).not.toBeNull();
    const active=await snapshots.readActiveSnapshot(store);
    const owner=active.snapshot.payload.entries.find((row:{syncUid:string})=>row.syncUid===created.localKey.slice(6));
    expect(owner).toMatchObject({title:'Final',pageCount:7});expect(owner.id).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(2);
    for (const operation of original) {
      const receipt=JSON.parse(db.prepare('SELECT result_json FROM sync_operation_receipts WHERE op_id = ?').pluck().get(operation.opId) as string) as {opId:string;status:string;entityId:number};
      expect(receipt).toMatchObject({opId:operation.opId,status:'applied',entityId:owner.id});
    }
    expect(calls.some(row=>row.url.includes('/sync/delta'))).toBe(true);
    expect(calls.some(row=>row.url.includes('/sync/snapshot'))).toBe(false);
    cleanupRecovery?.();cleanupRecovery=undefined;store.close();store=idb.createIndexedDbOfflineStore({indexedDB,databaseName});
    api=facade.createOfflineAwareGalleryApi(online,store,{state});rejectAck=false;
    await api.preferOfflineSnapshot('startup');const start=calls.length;
    await api.getSyncCapabilities();
    const after=calls.slice(start);expect(after.find(row=>!row.url.includes('/capabilities'))?.url).toContain('/sync/ack');
    expect(ackBodies[1]).toBe(ackBodies[0]);
    expect(await store.readMeta('pendingSnapshotAck')).toBeNull();
    expect(await store.list()).toEqual([]);expect(await store.listMedia()).toEqual([]);
    const retries=calls.filter(row=>row.url.includes('/sync/replay') && JSON.parse(row.body).opId===original[0].opId);
    expect(retries.every(row=>row.body===sentFirst)).toBe(true);
  } finally {cleanupRecovery?.();store.close();db.close();rmSync(root,{recursive:true,force:true});}
});


it('pulls, replays a real queued create, and installs the covering delta through the offline facade', async () => {
  const paths=['../../../web/src/api/gallery.js','../../../web/src/api/client.js','../../../web/src/offline/snapshot-store.js','../../../web/src/offline/offline-sync.js','../../../web/src/offline/offline-api.js','../../../web/src/offline/outbox-store.js'];
  paths.push('../../../web/src/offline/media-outbox-store.js');
  const [gallery,client,snapshots,sync,facade,outboxes,media]=await Promise.all(paths.map(path=>import(path)));
  const db=createMigratedMemoryDatabase();
  try {
    createEntry(db,{title:'Seed',type:'game'});
    const app=createApiApp(db); const requests:string[]=[];
    const online=gallery.createGalleryApi(client.createApiClient({baseUrl:'http://delta.test/api/',fetchImplementation:async(input:RequestInfo|URL,init?:RequestInit)=>{
      requests.push(String(input)); return app.request(String(input),init);
    }}));
    expect((await online.getSyncCapabilities()).featureFlags.completeSnapshotDelta).toBe(true);
    const outbox=outboxes.createMemoryOutboxStore();
    const store={...snapshots.createMemorySnapshotStore(),...outbox,...media.createMemoryMediaOutboxStore(outbox.enqueue)};
    expect((await sync.downloadOfflineSnapshot({api:online,store})).ok).toBe(true);
    const api=facade.createOfflineAwareGalleryApi(online,store,{clientId:'delta-replay-device'});
    await api.getSyncCapabilities({replay:false});
    await api.enqueueOfflineEntryCreate({title:'Replayed',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false,coverFile:null,previewFile:null});
    const original=await store.list(); requests.length=0;
    await api.flushOfflineOutbox();
    expect(await store.list()).toEqual([]);
    expect(requests.some(url=>url.includes('/sync/delta'))).toBe(true);
    expect(requests.some(url=>url.includes('/sync/snapshot'))).toBe(false);
    expect(requests.some(url=>url.includes('/sync/ack'))).toBe(true);
    expect((await snapshots.readActiveSnapshot(store))?.snapshot.payload).toEqual(buildSyncSnapshot(db,{media:'thumbnails'}).payload);
    expect(original[0].payload.title).toBe('Replayed');
  } finally {db.close();}
});
it('updates and deletes Entries through the actual delta transport and durable materializer', async () => {
  const paths=['../../../web/src/api/gallery.js','../../../web/src/api/client.js','../../../web/src/offline/snapshot-store.js','../../../web/src/offline/offline-sync.js'];
  const [gallery,client,snapshots,sync]=await Promise.all(paths.map(path=>import(path)));
  const {createGalleryApi}=gallery; const {createApiClient}=client;
  const {createMemorySnapshotStore,readActiveSnapshot}=snapshots; const {downloadOfflineSnapshot}=sync;
  const db = createMigratedMemoryDatabase();
  try {
    const entry = createEntry(db, { title: 'Before', type: 'game' });
    const app = createApiApp(db);
    const requests: string[] = [];
    const api = createGalleryApi(createApiClient({ baseUrl: 'http://delta.test/api/', fetchImplementation: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); requests.push(url);
      return app.request(url, init);
    } }));
    expect((await api.getSyncCapabilities()).featureFlags.completeSnapshotDelta).toBe(true);
    const store = createMemorySnapshotStore();
    expect((await downloadOfflineSnapshot({ api, store })).ok).toBe(true);
    requests.length = 0;
    db.prepare('UPDATE entries SET title = ? WHERE id = ?').run('After', entry.id);
    expect((await downloadOfflineSnapshot({ api, store })).ok).toBe(true);
    expect(requests.some(url => url.includes('/sync/delta'))).toBe(true);
    expect(requests.some(url => url.includes('/sync/snapshot'))).toBe(false);
    expect((await readActiveSnapshot(store))?.snapshot.payload).toEqual(buildSyncSnapshot(db, {media:'thumbnails'}).payload);
    db.prepare('DELETE FROM entries WHERE id = ?').run(entry.id);
    expect((await downloadOfflineSnapshot({ api, store })).ok).toBe(true);
    expect((await readActiveSnapshot(store))?.snapshot.payload).toEqual(buildSyncSnapshot(db, {media:'thumbnails'}).payload);
    expect(requests.some(url => url.includes('/sync/ack'))).toBe(true);
  } finally { db.close(); }
});
