// @vitest-environment node
import { createHash } from 'node:crypto';
import { indexedDB, IDBObjectStore } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createMemoryOfflineStore } from '../src/offline/memory-offline-store.js';
import { createMemorySnapshotStore, applySnapshot, readActiveSnapshot, type SnapshotStore } from '../src/offline/snapshot-store.js';
import { downloadOfflineSnapshot } from '../src/offline/offline-sync.js';
import { retryPendingSnapshotAck } from '../src/offline/snapshot-delta.js';
import { createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';
const clientId='device';
const capabilities={libraryId:'library-1',syncEpoch:'epoch-1',sqliteSchemaVersion:28,snapshotFormatVersion:2,syncProtocolVersion:1,serverBuild:'test',featureFlags:{readOnlySnapshot:true,completeSnapshotDelta:true}};
function snapshot(seq:number,title=`Snapshot ${seq}`) {
  const value=offlineSnapshot(); value.header.snapshotSeq=seq; value.header.changeSeq=seq;
  value.payload.entries[0]!.title=title;
  const {checksum,...header}=value.header; void checksum;
  value.header.checksum=createHash('sha256').update(JSON.stringify(header)+JSON.stringify(value.payload)).digest('hex');
  return value;
}
const ack=(cursorSeq:number)=>({libraryId:'library-1',syncEpoch:'epoch-1',protocolVersion:1 as const,clientId,cursorSeq});
it.each(['memory','composite','idb'] as const)('%s invalidates null and byte-identical positive bases across Clear and peer reuse',async(kind)=>{
  const databaseName=crypto.randomUUID();
  const durable=kind==='idb' ? createIndexedDbOfflineStore({indexedDB,databaseName}) : null;
  const store:SnapshotStore=durable ?? (kind==='memory' ? createMemorySnapshotStore() : createMemoryOfflineStore());
  const peer=durable ? createIndexedDbOfflineStore({indexedDB,databaseName}) : store;
  try {
    const empty=await store.captureSnapshot!();
    await peer.clearSnapshot!();
    expect(await store.installSnapshot!(null,JSON.stringify(snapshot(1)),undefined,empty.revision)).toBeNull();
    const beforePeer=await store.captureSnapshot!();
    await applySnapshot(snapshot(1),{store:peer}); await peer.clearSnapshot!();
    expect(await store.installSnapshot!(null,JSON.stringify(snapshot(2)),undefined,beforePeer.revision)).toBeNull();
    await applySnapshot(snapshot(1),{store});
    const positive=await readActiveSnapshot(store);
    await peer.clearSnapshot!(); await applySnapshot(snapshot(1),{store:peer});
    const winner=await readActiveSnapshot(peer);
    expect(winner?.generationId).toBe(positive?.generationId);
    expect(winner?.snapshot).toEqual(positive?.snapshot);
    expect(winner?.revision).not.toBe(positive?.revision);
    expect(await store.installSnapshot!(positive,JSON.stringify(snapshot(2)))).toBeNull();
    await peer.writeMeta('pendingSnapshotAck','same tuple');
    expect(await store.compareSnapshotMeta!(positive,'pendingSnapshotAck','same tuple',null)).toBe(false);
    expect(await peer.readMeta('pendingSnapshotAck')).toBe('same tuple');
    if (durable) {
      durable.close(); (peer as typeof durable).close();
      const reopened=createIndexedDbOfflineStore({indexedDB,databaseName});
      try {expect(await reopened.captureSnapshot!()).toEqual({active:winner,revision:winner!.revision});}
      finally {reopened.close();}
    }
  } finally {durable?.close(); if (durable) (peer as typeof durable).close();}
});
it.each(['clear-first','install-first'] as const)('two IndexedDB instances linearize %s without resurrection',async(order)=>{
  const databaseName=crypto.randomUUID(); const store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const peer=createIndexedDbOfflineStore({indexedDB,databaseName});
  try {
    const captured=await store.captureSnapshot!(); await peer.captureSnapshot!();
    const install=()=>store.installSnapshot!(null,JSON.stringify(snapshot(1)),undefined,captured.revision);
    const clear=()=>peer.clearSnapshot!();
    const tasks=order==='clear-first' ? [clear(),install()] : [install(),clear()];
    const results=await Promise.all(tasks);
    expect(results[order==='clear-first' ? 1 : 0] === null).toBe(order==='clear-first');
    expect(await readActiveSnapshot(store)).toBeNull();
    expect(await store.listGenerationIds()).toEqual([]);
    expect((await store.captureSnapshot!()).revision).toBe(order==='clear-first' ? '1' : '2');
  } finally {store.close();peer.close();}
});
it.each(['identity-first','install-first'] as const)('two IndexedDB instances linearize %s against installation and ACK',async(order)=>{
  const databaseName=crypto.randomUUID(); const store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const peer=createIndexedDbOfflineStore({indexedDB,databaseName});
  try {
    await store.writeMeta('t3.offline-client-id',clientId);
    const captured=await store.captureSnapshot!(); await peer.captureSnapshot!();
    const install=()=>store.installSnapshot!(null,JSON.stringify(snapshot(1)),ack(1),captured.revision,clientId);
    const change=()=>peer.writeMeta('t3.offline-client-id','replacement');
    const results=await Promise.all(order==='identity-first' ? [change(),install()] : [install(),change()]);
    expect(results[order==='identity-first' ? 1 : 0] === null).toBe(order==='identity-first');
    const ackSnapshotDelta=vi.fn(async()=>({ackSeq:1}));
    if (order==='install-first') {
      await expect(retryPendingSnapshotAck({fetchSyncSnapshot:async()=>snapshot(1),ackSnapshotDelta},store)).rejects.toThrow(/device changed/);
      expect(await store.readMeta('pendingSnapshotAck')).not.toBeNull();
    } else {expect(await readActiveSnapshot(store)).toBeNull();expect(await store.readMeta('pendingSnapshotAck')).toBeNull();}
    expect(ackSnapshotDelta).not.toHaveBeenCalled();
  } finally {store.close();peer.close();}
});
it('a delayed old ACK settlement cannot clear a newly installed peer tuple',async()=>{
  const databaseName=crypto.randomUUID(); const store=createIndexedDbOfflineStore({indexedDB,databaseName});
  const peer=createIndexedDbOfflineStore({indexedDB,databaseName});
  try {
    await store.writeMeta('t3.offline-client-id',clientId);
    await applySnapshot(snapshot(1),{store,acknowledgement:ack(1)});
    const base=await readActiveSnapshot(store); const raw=await store.readMeta('pendingSnapshotAck');
    let release!:(value:{ackSeq:number})=>void; let started!:()=>void;
    const ready=new Promise<void>(resolve=>{started=resolve;});
    const old=retryPendingSnapshotAck({fetchSyncSnapshot:async()=>snapshot(1),ackSnapshotDelta:async()=>{started();return new Promise(resolve=>{release=resolve;});}},store);
    await ready;
    expect(await peer.compareSnapshotMeta!(base,'pendingSnapshotAck',raw,null,clientId)).toBe(true);
    await applySnapshot(snapshot(2),{store:peer,expectedBase:base,acknowledgement:ack(2)});
    const newer=await peer.readMeta('pendingSnapshotAck');
    expect(newer).not.toBe(raw);release({ackSeq:1});await old;
    expect(await store.readMeta('pendingSnapshotAck')).toBe(newer);
    expect((await readActiveSnapshot(store))?.snapshot.header.changeSeq).toBe(2);
  } finally {store.close();peer.close();}
});
it('an abort after real generation and pending-ACK inserts restores the old history and original Outbox Blob',async()=>{
  const store=createIndexedDbOfflineStore({indexedDB,databaseName:crypto.randomUUID()});
  await store.writeMeta('t3.offline-client-id',clientId);
  for (let seq=1;seq<=3;seq++) await applySnapshot(snapshot(seq),{store});
  const base=await readActiveSnapshot(store); const revision=(await store.captureSnapshot!()).revision;
  const operation=createPendingSyncOperation({clientId,libraryId:'library-1',syncEpoch:'epoch-1',entityKind:'entry',entityUid:crypto.randomUUID(),operationKind:'entry.create',baseVersion:0,baseValues:{},payload:{title:'Original',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false}});
  const blob=new Blob(['unchanged original bytes'],{type:'image/png'});
  const media={uploadId:crypto.randomUUID(),libraryId:'library-1',syncEpoch:'epoch-1',entryUid:operation.entityUid,kind:'cover' as const,ordinal:0,mimeType:'image/png' as const,byteLength:blob.size,sha256:createHash('sha256').update('unchanged original bytes').digest('hex'),blob,status:'pending' as const,lastAttemptAt:null,lastError:null};
  await store.enqueueEntryCreate(operation,[media]);
  let inserted=false;
  const original=IDBObjectStore.prototype.put;
  const fault=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value:unknown,key?:IDBValidKey){
    const request=original.call(this,value,key);
    if (this.name==='meta' && key==='pendingSnapshotAck') request.addEventListener('success',()=>{
      const generation=this.transaction.objectStore('snapshotGenerations').get(4);
      const tuple=this.get('pendingSnapshotAck');
      tuple.addEventListener('success',()=>{inserted=generation.readyState==='done' && typeof generation.result==='string' && typeof tuple.result==='string';this.transaction.abort();});
    });
    return request;
  });
  const ackSnapshotDelta=vi.fn(async()=>({ackSeq:4}));
  const target=snapshot(4);
  try {
    const result=await downloadOfflineSnapshot({store,api:{getSyncCapabilities:async()=>capabilities,fetchSyncSnapshot:async()=>target,
      fetchSnapshotDelta:async()=>({version:1,token:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',baseChecksum:base!.snapshot.header.checksum,prefix:0,remove:JSON.stringify(base!.snapshot).length,insertLength:JSON.stringify(target).length,offset:0,chunk:JSON.stringify(target),done:true,target:target.header}),ackSnapshotDelta}});
    expect(inserted).toBe(true);expect(result).toMatchObject({ok:false,reason:'quota'});
    expect(await readActiveSnapshot(store)).toEqual(base);
    expect((await store.captureSnapshot!()).revision).toBe(revision);
    expect(await store.listGenerationIds()).toEqual([2,3]);
    expect(await store.readMeta('pendingSnapshotAck')).toBeNull();
    expect(await store.list()).toEqual([operation]);
    const saved=await store.listMedia();expect(saved).toEqual([media]);
    expect(await saved[0]!.blob.text()).toBe('unchanged original bytes');
    expect(ackSnapshotDelta).not.toHaveBeenCalled();
  } finally {fault.mockRestore();store.close();}
});
it('rolls back a synchronous quota fault while pruning the staged IndexedDB install',async()=>{
  const store=createIndexedDbOfflineStore({indexedDB,databaseName:crypto.randomUUID()});
  await store.writeMeta('t3.offline-client-id',clientId);
  for (let seq=1;seq<=2;seq++) expect((await applySnapshot(snapshot(seq),{store})).ok).toBe(true);
  const base=await readActiveSnapshot(store);
  const original=IDBObjectStore.prototype.delete;
  const spy=vi.spyOn(IDBObjectStore.prototype,'delete').mockImplementation(function(this:IDBObjectStore,key:IDBValidKey|IDBKeyRange){
    if (this.name==='snapshotGenerations') throw new DOMException('Quota during prune','QuotaExceededError');
    return original.call(this,key);
  });
  try {
    const result=await applySnapshot(snapshot(3),{store,expectedBase:base,acknowledgement:ack(3)});
    expect(result).toMatchObject({ok:false,failure:{reason:'quota'}});
    expect(await readActiveSnapshot(store)).toEqual(base);
    expect(await store.listGenerationIds()).toEqual([1,2]);
    expect(await store.readMeta('pendingSnapshotAck')).toBeNull();
  } finally {spy.mockRestore();store.close();}
});
