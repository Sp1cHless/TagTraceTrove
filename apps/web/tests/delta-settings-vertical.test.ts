// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import { mount } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import OfflineLibrarySettings from '../src/components/OfflineLibrarySettings.vue';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';
import { readActiveSnapshot } from '../src/offline/snapshot-store.js';
import type { SyncDeltaRequest, SyncSnapshot } from '@t3/shared';

function snapshot(seq:number,title=`Target ${seq}`,version=1):SyncSnapshot {
  const value=offlineSnapshot(); value.header.snapshotSeq=seq; value.header.changeSeq=seq+40;
  value.payload.entries[0]!.title=title;value.payload.entries[0]!.syncVersion=version;
  const {checksum,...header}=value.header; void checksum;
  value.header.checksum=createHash('sha256').update(JSON.stringify(header)+JSON.stringify(value.payload)).digest('hex');
  return value;
}
it('cold IndexedDB retries the exact install-bound lost ACK before requesting another target',async()=>{
  const {applySnapshot}=await import('../src/offline/snapshot-store.js');
  const {downloadOfflineSnapshot}=await import('../src/offline/offline-sync.js');
  const databaseName=`lost-ack-${crypto.randomUUID()}`;
  let store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const base=snapshot(1);const target=snapshot(2); const bodies:unknown[]=[];let lost=true;
  const api={
    getSyncCapabilities:async()=>({libraryId:'library-1',syncEpoch:'epoch-1',sqliteSchemaVersion:35,snapshotFormatVersion:2,syncProtocolVersion:1,serverBuild:'test',featureFlags:{readOnlySnapshot:true,completeSnapshotDelta:true}}),
    fetchSyncSnapshot:vi.fn(async()=>snapshot(3)),
    fetchSnapshotDelta:vi.fn(async(request:SyncDeltaRequest)=>({version:1 as const,token:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',baseChecksum:request.baseChecksum,target:target.header,prefix:0,remove:JSON.stringify(base).length,insertLength:JSON.stringify(target).length,offset:0,chunk:JSON.stringify(target),done:true})),
    ackSnapshotDelta:async(body:{cursorSeq:number})=>{bodies.push(structuredClone(body));if(lost)throw new TypeError('Committed ACK response lost');return {ackSeq:body.cursorSeq};},
  };
  try {
    await applySnapshot(base,{store,expectedBase:null});
    const result=await downloadOfflineSnapshot({store,api});
    expect(result.ok).toBe(false);
    expect((await readActiveSnapshot(store))?.snapshot).toEqual(target);
    const pending=JSON.parse((await store.readMeta('pendingSnapshotAck'))!) as {generationId:number;snapshot:string;body:{cursorSeq:number}};
    expect(pending.body).toEqual(bodies[0]);expect(pending.body.cursorSeq).toBe(42);
    expect(pending.snapshot).toBe(JSON.stringify(target));
    store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});lost=false;
    api.fetchSnapshotDelta.mockImplementation(async()=>{throw new Error('Stop after old ACK');});
    await downloadOfflineSnapshot({store,api});
    expect(bodies).toEqual([pending.body,pending.body]);
    expect(await store.readMeta('pendingSnapshotAck')).toBeNull();
  } finally {store.close();}
});
it.each(['metadata','thumbnails','selected-originals'] as const)('mounted Settings %s Update shares a durable device identity with facade operations and uses delta without full traffic',async(mode)=>{
  const databaseName=`settings-delta-${crypto.randomUUID()}`;
  const store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const peer=createIndexedDbOfflineStore({indexedDB,databaseName});
  const calls:Array<{url:string;body:unknown}>=[]; let seq=0; let base:SyncSnapshot;let remoteTitle:string|undefined;let version=1;
  const online=createGalleryApi(createApiClient({baseUrl:'http://delta.test/api/',fetchImplementation:async(input,init)=>{
    const url=String(input); const body=init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({url,body}); let result:unknown;
    if(url.includes('capabilities')) result={libraryId:'library-1',syncEpoch:'epoch-1',sqliteSchemaVersion:35,snapshotFormatVersion:2,syncProtocolVersion:1,serverBuild:'test',featureFlags:{readOnlySnapshot:true,completeSnapshotDelta:true,offlineMutations:true,offlineEntryUpdate:true}};
    else if(url.includes('/sync/snapshot')) {base=snapshot(++seq,remoteTitle,version);result=base;}
    else if(url.includes('/sync/replay')) {const operation=body as {opId:string;payload:{title:string}};remoteTitle=operation.payload.title;result={opId:operation.opId,status:'applied',serverSeq:42,resourceVersion:++version};}
    else if(url.includes('/sync/delta')) {
      const request=body as SyncDeltaRequest; const target=snapshot(++seq,remoteTitle,version);
      result={version:1,token:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',baseChecksum:request.baseChecksum,target:target.header,prefix:0,remove:JSON.stringify(base!).length,insertLength:JSON.stringify(target).length,offset:0,chunk:JSON.stringify(target),done:true};base=target;
    } else if(url.includes('/sync/ack')) result={ackSeq:(body as {cursorSeq:number}).cursorSeq};
    else throw new TypeError('Offline');
    return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
  }}));
  const api=createOfflineAwareGalleryApi(online,store);
  const peerApi=createOfflineAwareGalleryApi(online,peer);
  const wrapper=mount(OfflineLibrarySettings,{props:{api,store}});
  try {
    await wrapper.get('[data-testid="offline-media-mode"]').setValue(mode);
    await wrapper.get('[data-testid="offline-download"]').trigger('click');
    await vi.waitFor(async()=>expect((await readActiveSnapshot(store))?.snapshot.header.snapshotSeq).toBe(1));
    await vi.waitFor(()=>expect(wrapper.get('[data-testid="offline-download"]').attributes('disabled')).toBeUndefined());
    const media=mode==='metadata'?'none':'thumbnails';
    expect(calls.find(row=>row.url.includes('/sync/snapshot'))?.url).toContain(`media=${media}`);
    calls.length=0;
    await wrapper.get('[data-testid="offline-download"]').trigger('click');
    await vi.waitFor(async()=>expect((await readActiveSnapshot(store))?.snapshot.header.snapshotSeq).toBe(2));
    await vi.waitFor(()=>expect(calls.some(row=>row.url.includes('/sync/ack'))).toBe(true));
    expect(calls.some(row=>row.url.includes('/sync/snapshot'))).toBe(false);
    const request=calls.find(row=>row.url.includes('/sync/delta'))!.body as SyncDeltaRequest;
    expect(request.media).toBe(media); expect(request.clientId).toMatch(/^[0-9a-f-]{36}$/iu);
    await api.preferOfflineSnapshot!('disconnect'); await peerApi.preferOfflineSnapshot!('disconnect');
    await api.updateEntry(1,{title:'Queued A'}); await peerApi.updateEntry(1,{title:'Queued B'});
    expect((await store.list()).map(row=>({clientId:row.clientId,title:row.payload.title})))
      .toEqual([{clientId:request.clientId,title:'Queued B'}]);
    expect(await store.readMeta('t3.offline-client-id')).toBe(request.clientId);
    await vi.waitFor(()=>expect(wrapper.get('[data-testid="offline-download"]').attributes('disabled')).toBeUndefined());
    await wrapper.get('[data-testid="offline-download"]').trigger('click');
    await vi.waitFor(()=>expect(wrapper.get('[data-testid="offline-download"]').attributes('disabled')).toBeUndefined());
    expect(wrapper.get('[data-testid="offline-status"]').text()).not.toMatch(/changed during|stale|error|失败/iu);
    expect(await store.list()).toEqual([]);
    const cold=createIndexedDbOfflineStore({indexedDB,databaseName});
    const mounted=mount(OfflineLibrarySettings,{props:{api:createOfflineAwareGalleryApi(online,cold),store:cold}});
    try {await vi.waitFor(()=>expect((mounted.get('[data-testid="offline-media-mode"]').element as HTMLSelectElement).value).toBe(mode));}
    finally {mounted.unmount();cold.close();}
  } finally {wrapper.unmount();store.close();peer.close();}
});

it('migrates an existing device identity into IndexedDB without minting a replacement or writing another localStorage UUID',async()=>{
  const {getClientIdentity}=await import('../src/offline/client-identity.js');
  const existing='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  localStorage.setItem('t3.offline-client-id',existing);
  const store=createIndexedDbOfflineStore({indexedDB,databaseName:`legacy-identity-${crypto.randomUUID()}`});
  const create=vi.fn(()=>crypto.randomUUID());
  try {expect(await getClientIdentity(store,undefined,create)).toBe(existing);expect(create).not.toHaveBeenCalled();expect(await store.readMeta('t3.offline-client-id')).toBe(existing);}
  finally {store.close();localStorage.removeItem('t3.offline-client-id');}
});
it('atomic empty-library identity creation mints one UUID across two IndexedDB instances and survives cold reopen',async()=>{
  const {getClientIdentity}=await import('../src/offline/client-identity.js');
  const databaseName=`identity-${crypto.randomUUID()}`;
  const a=createIndexedDbOfflineStore({indexedDB,databaseName});const b=createIndexedDbOfflineStore({indexedDB,databaseName});
  const create=vi.fn(()=>crypto.randomUUID());
  const [first,second]=await Promise.all([getClientIdentity(a,undefined,create),getClientIdentity(b,undefined,create)]);
  expect(first).toBe(second);expect(create).toHaveBeenCalledOnce();a.close();b.close();
  const cold=createIndexedDbOfflineStore({indexedDB,databaseName});
  try {expect(await getClientIdentity(cold,undefined,create)).toBe(first);expect(create).toHaveBeenCalledOnce();}
  finally {cold.close();}
});

it.each(['device','clear','peer'] as const)('does not ACK an installation invalidated by %s after digest/readback',async(change)=>{
  const {applySnapshot}=await import('../src/offline/snapshot-store.js');
  const {getClientIdentity}=await import('../src/offline/client-identity.js');
  const {retryPendingSnapshotAck}=await import('../src/offline/snapshot-delta.js');
  const databaseName=`ack-race-${crypto.randomUUID()}`;
  const store=createIndexedDbOfflineStore({indexedDB,databaseName});const peer=createIndexedDbOfflineStore({indexedDB,databaseName});
  try {
    const clientId=await getClientIdentity(store);const target=snapshot(2);
    await applySnapshot(target,{store,expectedBase:null,acknowledgement:{libraryId:'library-1',syncEpoch:'epoch-1',protocolVersion:1,clientId,cursorSeq:42}});
    const compare=store.compareSnapshotMeta!.bind(store);
    store.compareSnapshotMeta=async(...args)=>{
      if(args[2]===args[3]) {
        if(change==='device')await peer.writeMeta('t3.offline-client-id','another-device');
        else if(change==='clear')await peer.clearSnapshot!();
        else {await peer.writeGeneration(8,JSON.stringify(snapshot(8)));await peer.writeMeta('activeGeneration','8');}
      }
      return compare(...args);
    };
    const ackSnapshotDelta=vi.fn(async()=>({ackSeq:42}));
    await expect(retryPendingSnapshotAck({fetchSyncSnapshot:async()=>target,ackSnapshotDelta},store)).rejects.toThrow(/changed/iu);
    expect(ackSnapshotDelta).not.toHaveBeenCalled();
  }finally {store.close();peer.close();}
});

it('HTTP ACK rejection retains the same pending tuple and prevents a newer target request',async()=>{
  const {ApiError}=await import('../src/api/client.js');
  const {applySnapshot}=await import('../src/offline/snapshot-store.js');
  const {downloadOfflineSnapshot}=await import('../src/offline/offline-sync.js');
  const store=createIndexedDbOfflineStore({indexedDB,databaseName:`ack-reject-${crypto.randomUUID()}`});
  const target=snapshot(2); const base=snapshot(1);
  const fetchSnapshotDelta=vi.fn(async(request:SyncDeltaRequest)=>({version:1 as const,token:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',baseChecksum:request.baseChecksum,target:target.header,prefix:0,remove:JSON.stringify(base).length,insertLength:JSON.stringify(target).length,offset:0,chunk:JSON.stringify(target),done:true}));
  const ackSnapshotDelta=vi.fn(async()=>{throw new ApiError(409,{message:'ACK rejected'});});
  const api={getSyncCapabilities:async()=>({libraryId:'library-1',syncEpoch:'epoch-1',sqliteSchemaVersion:35,snapshotFormatVersion:2,syncProtocolVersion:1,serverBuild:'test',featureFlags:{readOnlySnapshot:true,completeSnapshotDelta:true}}),fetchSyncSnapshot:async()=>target,fetchSnapshotDelta,ackSnapshotDelta};
  try {
    await applySnapshot(base,{store,expectedBase:null});
    expect((await downloadOfflineSnapshot({store,api})).ok).toBe(false);
    const pending=await store.readMeta('pendingSnapshotAck');expect(pending).not.toBeNull();
    expect((await downloadOfflineSnapshot({store,api})).ok).toBe(false);
    expect(await store.readMeta('pendingSnapshotAck')).toBe(pending);expect(fetchSnapshotDelta).toHaveBeenCalledOnce();
    expect(ackSnapshotDelta.mock.calls).toHaveLength(2);expect(ackSnapshotDelta.mock.calls[0]).toEqual(ackSnapshotDelta.mock.calls[1]);
  }finally {store.close();}
});
