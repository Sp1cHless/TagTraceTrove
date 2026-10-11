import { createHash } from 'node:crypto';
import { indexedDB } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client.js';
import { fetchSnapshotCandidate, acknowledgeSnapshotCandidate } from '../src/offline/snapshot-delta.js';
import { createMemoryOfflineStore } from '../src/offline/memory-offline-store.js';
import { createMemorySnapshotStore } from '../src/offline/snapshot-store.js';
import { clearOfflineSnapshot, downloadOfflineSnapshot } from '../src/offline/offline-sync.js';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { applySnapshot, readActiveSnapshot } from '../src/offline/snapshot-store.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';
import { createPendingSyncOperation } from '../src/offline/outbox-store.js';
it('does not request or acknowledge a delta through a legacy adapter without conditional activation', async () => {
  const memory=createMemorySnapshotStore();
  const {installSnapshot,...store}=memory; void installSnapshot;
  expect((await applySnapshot(snapshot(1,'Base'),{store})).ok).toBe(true);
  const fetchSnapshotDelta=vi.fn(async () => {throw new Error('Delta must not be requested');});
  const ackSnapshotDelta=vi.fn(async () => ({ackSeq:1}));
  const result=await downloadOfflineSnapshot({store,api:{
    getSyncCapabilities:async()=>({libraryId:'library-1',syncEpoch:'epoch-1',sqliteSchemaVersion:28,
      snapshotFormatVersion:2,syncProtocolVersion:1,serverBuild:'test',featureFlags:{readOnlySnapshot:true,completeSnapshotDelta:true}}),
    fetchSyncSnapshot:async()=>snapshot(2,'Full fallback'),fetchSnapshotDelta,ackSnapshotDelta,
  }});
  expect(result).toMatchObject({ok:false,reason:'stale-snapshot'}); expect(fetchSnapshotDelta).not.toHaveBeenCalled(); expect(ackSnapshotDelta).not.toHaveBeenCalled();
  expect((await readActiveSnapshot(store))?.snapshot.payload.entries[0]?.title).toBe('Base');
});
it('atomically bounds installed generations in memory and across IndexedDB cold reopen', async () => {
  const databaseName=`delta-prune-${crypto.randomUUID()}`;
  const durable=createIndexedDbOfflineStore({indexedDB,databaseName});
  for (const store of [createMemorySnapshotStore(),durable]) {
    for (let seq=1;seq<=5;seq++) {
      const base=await readActiveSnapshot(store);
      expect((await applySnapshot(snapshot(seq,`Target ${seq}`),{store,expectedBase:base})).ok).toBe(true);
      expect((await store.listGenerationIds()).length).toBeLessThanOrEqual(2);
    }
    expect((await readActiveSnapshot(store))?.snapshot.header.snapshotSeq).toBe(5);
  }
  durable.close();
  const reopened=createIndexedDbOfflineStore({indexedDB,databaseName});
  try { expect(await reopened.listGenerationIds()).toEqual([4,5]); }
  finally { reopened.close(); }
});
it('Clear cannot erase a peer activation committed after its atomic boundary', async () => {
  const databaseName=`delta-clear-${crypto.randomUUID()}`;
  const store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const peer=createIndexedDbOfflineStore({indexedDB,databaseName});
  try {
    await applySnapshot(snapshot(1,'Base'),{store});
    const originalList=store.listGenerationIds;
    let interleaved=false;
    store.listGenerationIds=async()=>{
      interleaved=true;
      await applySnapshot(snapshot(2,'Peer after Clear'),{store:peer,expectedBase:null});
      return originalList();
    };
    await clearOfflineSnapshot(store);
    // Atomic Clear never calls the separate list/delete path; install afterwards.
    if (!interleaved) {
      await applySnapshot(snapshot(2,'Peer after Clear'),{store:peer,expectedBase:null});
    }
    expect((await readActiveSnapshot(peer))?.snapshot.payload.entries[0]?.title).toBe('Peer after Clear');
  } finally {store.close();peer.close();}
});
it('rejects corrupt delta pages without silently publishing a full fallback or acknowledging', async () => {
  const store=createMemorySnapshotStore();
  const base=snapshot(1,'Base'); base.header.changeSeq=1;
  const {checksum,...header}=base.header; void checksum;
  base.header.checksum=createHash('sha256').update(JSON.stringify(header)+JSON.stringify(base.payload)).digest('hex');
  await applySnapshot(base,{store});
  const fetchSyncSnapshot=vi.fn(async()=>snapshot(2,'Unexpected fallback'));
  const ackSnapshotDelta=vi.fn(async()=>({ackSeq:2}));
  const result=await downloadOfflineSnapshot({store,api:{
    getSyncCapabilities:async()=>({libraryId:'library-1',syncEpoch:'epoch-1',sqliteSchemaVersion:28,
      snapshotFormatVersion:2,syncProtocolVersion:1,serverBuild:'test',featureFlags:{readOnlySnapshot:true,completeSnapshotDelta:true}}),
    fetchSyncSnapshot,fetchSnapshotDelta:async()=>({version:99} as never),ackSnapshotDelta,
  }});
  expect(result.ok).toBe(false);
  expect(fetchSyncSnapshot).not.toHaveBeenCalled();
  expect(ackSnapshotDelta).not.toHaveBeenCalled();
  expect((await readActiveSnapshot(store))?.snapshot).toEqual(base);
});
it('composite memory Clear has one boundary and cannot delete a subsequent peer install', async () => {
  const store=createMemoryOfflineStore();
  await applySnapshot(snapshot(1,'Base'),{store});
  const original=store.listGenerationIds;
  let interleaved=false;
  store.listGenerationIds=async()=>{
    interleaved=true;
    await applySnapshot(snapshot(2,'After Clear'),{store,expectedBase:null});
    return original();
  };
  await clearOfflineSnapshot(store);
  if (!interleaved) await applySnapshot(snapshot(2,'After Clear'),{store,expectedBase:null});
  expect((await readActiveSnapshot(store))?.snapshot.payload.entries[0]?.title).toBe('After Clear');
});
it('reports exactly the generations pruned by conditional activation for all atomic adapters', async () => {
  const durable=createIndexedDbOfflineStore({indexedDB,databaseName:`prune-report-${crypto.randomUUID()}`});
  try {
    for (const store of [createMemorySnapshotStore(),createMemoryOfflineStore(),durable]) {
      await applySnapshot(snapshot(1,'First'),{store,expectedBase:null});
      await applySnapshot(snapshot(2,'Second'),{store,expectedBase:await readActiveSnapshot(store)});
      const result=await applySnapshot(snapshot(3,'Third'),{store,expectedBase:await readActiveSnapshot(store)});
      expect(result.ok && result.prunedGenerations).toEqual([1]);
      expect(await store.listGenerationIds()).toEqual([2,3]);
    }
  } finally {durable.close();}
});
it.each([
  [404,'Not found',true], [501,'Unsupported protocol',true],
  [409,'Verified baseline unavailable; fetch full snapshot',true],
  [409,'Delta session unavailable; fetch full snapshot',true],
  [409,'Delta identity mismatch',false], [409,'Unserved delta offset',false],
  [500,'Internal failure',false],
] as const)('bounds explicit full fallback for HTTP %s %s', async (status,message,fallback) => {
  const base={generationId:1,snapshot:snapshot(1,'Base')};
  const fetchSyncSnapshot=vi.fn(async()=>snapshot(2,'Full'));
  const api={fetchSyncSnapshot,fetchSnapshotDelta:async()=>{throw new ApiError(status,{message});},
    ackSnapshotDelta:async()=>({ackSeq:2})};
  const request=fetchSnapshotCandidate(api,base,{libraryId:'library-1',syncEpoch:'epoch-1',sqliteSchemaVersion:28,
    snapshotFormatVersion:2,syncProtocolVersion:1,serverBuild:'test',featureFlags:{readOnlySnapshot:true,completeSnapshotDelta:true}},'device');
  if (fallback) expect((await request).snapshot.payload.entries[0]?.title).toBe('Full');
  else await expect(request).rejects.toThrow(message);
  expect(fetchSyncSnapshot).toHaveBeenCalledTimes(fallback ? 1 : 0);
});
it('does not resurrect a delayed full candidate after Clear returns an empty captured base to null', async () => {
  const store=createMemoryOfflineStore();
  let release!: () => void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let started!: () => void;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  const task=downloadOfflineSnapshot({store,api:{
    getSyncCapabilities:async()=>({libraryId:'library-1',syncEpoch:'epoch-1',sqliteSchemaVersion:28,
      snapshotFormatVersion:2,syncProtocolVersion:1,serverBuild:'test',featureFlags:{readOnlySnapshot:true}}),
    fetchSyncSnapshot:async()=>{started();await gate;return snapshot(2,'Late');},
  }});
  await ready; await clearOfflineSnapshot(store); release();
  expect((await task).ok).toBe(false);
  expect(await readActiveSnapshot(store)).toBeNull();
});
it('legacy full fallback fails closed rather than publishing after a same-scope Clear', async () => {
  const memory=createMemorySnapshotStore();
  const {installSnapshot,captureSnapshot,...store}=memory; void installSnapshot; void captureSnapshot;
  await applySnapshot(snapshot(1,'Base'),{store});
  const result=await downloadOfflineSnapshot({store,api:{
    getSyncCapabilities:async()=>({libraryId:'library-1',syncEpoch:'epoch-1',sqliteSchemaVersion:28,
      snapshotFormatVersion:2,syncProtocolVersion:1,serverBuild:'test',featureFlags:{readOnlySnapshot:true}}),
    fetchSyncSnapshot:async()=>{await clearOfflineSnapshot(store);return snapshot(2,'Late legacy full');},
  }});
  expect(result.ok).toBe(false);
  expect(await readActiveSnapshot(store)).toBeNull();
});
it('memory installation prepares the ACK before publishing any generation or pointer', async () => {
  for (const store of [createMemorySnapshotStore(),createMemoryOfflineStore()]) {
    await store.writeMeta('t3.offline-client-id','device');
    await applySnapshot(snapshot(1,'Before'),{store});
    const base=await readActiveSnapshot(store);
    const ack={libraryId:'library-1',syncEpoch:'epoch-1',protocolVersion:1 as const,clientId:'device',cursorSeq:2,
      toJSON(){throw new Error('ACK serialization aborted');}};
    const result=await applySnapshot(snapshot(2,'Must not publish'),{store,expectedBase:base,acknowledgement:ack});
    expect(result).toMatchObject({ok:false,failure:{reason:'quota'}});
    expect(await readActiveSnapshot(store)).toEqual(base);
    expect(await store.listGenerationIds()).toEqual([1]);
    expect(await store.readMeta('pendingSnapshotAck')).toBeNull();
  }
});
it('rejects a full install when the device identity changes during candidate acquisition', async () => {
  const store=createMemoryOfflineStore();
  await store.writeMeta('t3.offline-client-id','before');
  const result=await downloadOfflineSnapshot({store,api:{
    getSyncCapabilities:async()=>({libraryId:'library-1',syncEpoch:'epoch-1',sqliteSchemaVersion:28,
      snapshotFormatVersion:2,syncProtocolVersion:1,serverBuild:'test',featureFlags:{readOnlySnapshot:true}}),
    fetchSyncSnapshot:async()=>{await store.writeMeta('t3.offline-client-id','after');return snapshot(2,'Wrong device');},
  }});
  expect(result.ok).toBe(false);
  expect(await readActiveSnapshot(store)).toBeNull();
});
it('does not ACK an identically reused generation after Clear invalidates the original install', async () => {
  const store=createMemoryOfflineStore(); await store.writeMeta('t3.offline-client-id','device');
  const value=snapshot(1,'Same bytes');
  const acknowledgement={libraryId:'library-1',syncEpoch:'epoch-1',protocolVersion:1 as const,clientId:'device',cursorSeq:1};
  await applySnapshot(value,{store,acknowledgement});
  const original=await readActiveSnapshot(store);
  await clearOfflineSnapshot(store);
  await applySnapshot(value,{store,acknowledgement});
  expect((await readActiveSnapshot(store))?.generationId).toBe(original?.generationId);
  const ackSnapshotDelta=vi.fn(async()=>({ackSeq:1}));
  await expect(acknowledgeSnapshotCandidate({fetchSyncSnapshot:async()=>value,ackSnapshotDelta},store,
    {snapshot:value,acknowledgement},original!.generationId,original!.revision)).rejects.toThrow(/changed/);
  expect(ackSnapshotDelta).not.toHaveBeenCalled();
  expect(await store.readMeta('pendingSnapshotAck')).not.toBeNull();
});
it('an adapter with activation but no transactional capture token cannot use delta or publish an unguarded full Update', async () => {
  const memory=createMemorySnapshotStore(); await applySnapshot(snapshot(1,'Base'),{store:memory});
  const {captureSnapshot,...store}=memory; void captureSnapshot;
  const fetchSnapshotDelta=vi.fn(async()=>{throw new ApiError(404,{message:'Not found'});});
  const fetchSyncSnapshot=vi.fn(async()=>snapshot(2,'Unsafe full'));
  const result=await downloadOfflineSnapshot({store,api:{getSyncCapabilities:async()=>({libraryId:'library-1',syncEpoch:'epoch-1',sqliteSchemaVersion:28,
    snapshotFormatVersion:2,syncProtocolVersion:1,serverBuild:'test',featureFlags:{readOnlySnapshot:true,completeSnapshotDelta:true}}),fetchSyncSnapshot,fetchSnapshotDelta,ackSnapshotDelta:async()=>({ackSeq:2})}});
  expect(fetchSnapshotDelta).not.toHaveBeenCalled();
  expect(fetchSyncSnapshot).toHaveBeenCalledOnce();
  expect(result.ok).toBe(false);
  expect((await readActiveSnapshot(memory))?.snapshot.payload.entries[0]?.title).toBe('Base');
});
it('epoch replacement never runs a split cleanup that deletes a subsequent peer install', async () => {
  const store=createMemoryOfflineStore();await applySnapshot(snapshot(1,'Old epoch'),{store});
  const target=snapshot(2,'New epoch');target.header.syncEpoch='epoch-2';
  const {checksum,...header}=target.header;void checksum;
  target.header.checksum=createHash('sha256').update(JSON.stringify(header)+JSON.stringify(target.payload)).digest('hex');
  const peer=structuredClone(target);peer.header.snapshotSeq=3;peer.payload.entries[0]!.title='Peer new epoch';
  const {checksum:peerChecksum,...peerHeader}=peer.header;void peerChecksum;
  peer.header.checksum=createHash('sha256').update(JSON.stringify(peerHeader)+JSON.stringify(peer.payload)).digest('hex');
  const list=store.listGenerationIds;let interleaved=false;
  store.listGenerationIds=async()=>{interleaved=true;expect((await applySnapshot(peer,{store})).ok).toBe(true);expect((await readActiveSnapshot(store))?.snapshot).toEqual(peer);return list();};
  const result=await downloadOfflineSnapshot({store,api:{getSyncCapabilities:async()=>({libraryId:'library-1',syncEpoch:'epoch-2',sqliteSchemaVersion:28,
    snapshotFormatVersion:2,syncProtocolVersion:1,serverBuild:'test',featureFlags:{readOnlySnapshot:true}}),fetchSyncSnapshot:async()=>target}});
  if (!interleaved) { expect(await list()).toEqual([2]); expect((await applySnapshot(peer,{store})).ok).toBe(true); }
  expect((await readActiveSnapshot(store))?.snapshot.payload.entries[0]?.title).toBe('Peer new epoch');
  expect(result, JSON.stringify(result)).toMatchObject({ok:true});
});
it.each(['memory','idb'] as const)('%s epoch activation rejects late operations and media without changing its captured scope', async kind => {
  const databaseName=`epoch-late-${crypto.randomUUID()}`;
  const durable=kind==='idb' ? createIndexedDbOfflineStore({indexedDB,databaseName}) : null;
  const store=durable ?? createMemoryOfflineStore();
  const peer=durable ? createIndexedDbOfflineStore({indexedDB,databaseName}) : store;
  try {
    await store.writeMeta('t3.offline-client-id','device');
    await applySnapshot(snapshot(1,'History'),{store});
    await applySnapshot(snapshot(2,'Old epoch'),{store});
    const base=await store.captureSnapshot!();
    const target=snapshot(3,'New epoch');target.header.syncEpoch='epoch-2';
    const {checksum,...header}=target.header;void checksum;
    target.header.checksum=createHash('sha256').update(JSON.stringify(header)+JSON.stringify(target.payload)).digest('hex');
    const operation=createPendingSyncOperation({clientId:'device',libraryId:'library-1',syncEpoch:'epoch-1',entityKind:'entry',entityUid:crypto.randomUUID(),operationKind:'entry.create',baseVersion:0,baseValues:{},payload:{title:'Preserve',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false}});
    const blob=new Blob(['original'],{type:'image/png'});
    const media={uploadId:crypto.randomUUID(),libraryId:'library-1',syncEpoch:'epoch-1',entryUid:operation.entityUid,kind:'cover' as const,ordinal:0,mimeType:'image/png' as const,byteLength:blob.size,sha256:createHash('sha256').update('original').digest('hex'),blob,status:'pending' as const,lastAttemptAt:null,lastError:null};
    const install=store.installSnapshot!;
    for (const mediaOnly of [false,true]) {
      store.installSnapshot=async (...args)=>{
        await peer.enqueueEntryCreate(operation,[media]);
        if (mediaOnly) await peer.remove(operation.opId);
        return install(...args);
      };
      const result=await downloadOfflineSnapshot({store,api:{getSyncCapabilities:async()=>({libraryId:'library-1',syncEpoch:'epoch-2',sqliteSchemaVersion:28,snapshotFormatVersion:2,syncProtocolVersion:1,serverBuild:'test',featureFlags:{readOnlySnapshot:true}}),fetchSyncSnapshot:async()=>target}});
      expect(result.ok).toBe(false);
      expect(await store.captureSnapshot!()).toEqual(base);
      expect(await store.listGenerationIds()).toEqual([1,2]);
      expect(await store.readMeta('pendingSnapshotAck')).toBeNull();
      expect(await store.list()).toEqual(mediaOnly ? [] : [operation]);
      expect(await (await store.listMedia())[0]!.blob.text()).toBe('original');
      await peer.remove(operation.opId);await peer.removeMedia(media.uploadId);
    }
    store.installSnapshot=install;
    const result=await applySnapshot(target,{store,expectedBase:base.active,expectedRevision:base.revision,expectedClientId:'device'});
    expect(result.ok && result.prunedGenerations).toEqual([1,2]);
    expect(await store.listGenerationIds()).toEqual([3]);
    expect(await store.readMeta('t3.offline-client-id')).toBe('device');
    if (durable) {
      durable.close();(peer as typeof durable).close();
      const reopened=createIndexedDbOfflineStore({indexedDB,databaseName});
      try {expect((await readActiveSnapshot(reopened))?.snapshot).toEqual(target);expect(await reopened.listGenerationIds()).toEqual([3]);expect((await reopened.captureSnapshot!()).revision).not.toBe(base.revision);}
      finally {reopened.close();}
    }
  } finally {durable?.close();if(durable)(peer as typeof durable).close();}
});
function snapshot(seq:number,title:string) {
  const value=offlineSnapshot(); value.header.snapshotSeq=seq; value.payload.entries[0]!.title=title;
  const {checksum,...header}=value.header; void checksum;
  value.header.checksum=createHash('sha256').update(JSON.stringify(header)+JSON.stringify(value.payload)).digest('hex');
  return value;
}
it('refuses a delayed install after a peer replaces the captured IndexedDB base, and cold reopens the winner', async () => {
  const databaseName=`delta-race-${crypto.randomUUID()}`;
  const store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const peer=createIndexedDbOfflineStore({indexedDB,databaseName});
  try {
    expect((await applySnapshot(snapshot(1,'Base'),{store})).ok).toBe(true);
    const base=await readActiveSnapshot(store);
    const delayed=snapshot(2,'Delayed'); const winner=snapshot(3,'Peer');
    expect((await applySnapshot(winner,{store:peer})).ok).toBe(true);
    expect((await applySnapshot(delayed,{store,expectedBase:base})).ok).toBe(false);
    store.close(); peer.close();
    const reopened=createIndexedDbOfflineStore({indexedDB,databaseName});
    try { expect((await readActiveSnapshot(reopened))?.snapshot).toEqual(winner); }
    finally { reopened.close(); }
  } finally { store.close(); peer.close(); }
});
