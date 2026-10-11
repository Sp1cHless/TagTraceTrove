// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import type { SnapshotStore } from '../src/offline/snapshot-store.js';
import type { OutboxStore } from '../src/offline/outbox-store.js';
import type { GalleryApi } from '../src/api/gallery.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createMemorySnapshotStore, ACTIVE_GENERATION_KEY } from '../src/offline/snapshot-store.js';
import { createMemoryOutboxStore, createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';
const clientId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const uid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const authorUid = '99999999-9999-4999-8999-999999999999';
async function stamp(snapshot: ReturnType<typeof offlineSnapshot>) {
  snapshot.header.counts.entries = snapshot.payload.entries.length;
  snapshot.header.counts.producers = snapshot.payload.producers.length;
  const {checksum, ...header}=snapshot.header; void checksum;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(header)+JSON.stringify(snapshot.payload)));
  snapshot.header.checksum=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
  return snapshot;
}
it('holds downgraded Author children and cleans only a verified final desired set',async()=>{
  const {api,store,online,snapshot,parent}=await setup();
  await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid]);
  await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[]);
  const replay=vi.fn().mockImplementation(async op=>({status:'applied',opId:op.opId,serverSeq:10,entityId:12}));
  online.replaySyncOperation=replay;
  const covering=structuredClone(snapshot);
  covering.header.snapshotSeq=2; covering.header.changeSeq=10;
  covering.payload.entries.push({...covering.payload.entries[0]!,id:12,syncUid:uid});
  covering.payload.entryProducers.push({entryId:12,producerId:9});
  online.fetchSyncSnapshot=vi.fn().mockImplementation(()=>stamp(covering));
  await store.writeMeta('capability.offlinePendingEntryAuthors','0');
  await api.flushOfflineOutbox!();
  expect(replay.mock.calls.map(([op])=>op.opId)).toEqual([parent.opId]);
  expect(await store.list()).toHaveLength(3);
  await store.writeMeta('capability.offlinePendingEntryAuthors','1');
  replay.mockClear(); covering.header.snapshotSeq=3; await api.flushOfflineOutbox!();
  expect(replay.mock.calls.map(([op])=>op.operationKind)).toEqual(['entry.create','entry.authors.set','entry.authors.set']);
  expect(await store.list()).toHaveLength(3);
  covering.header.snapshotSeq=3; covering.payload.entryProducers=[];
  await api.flushOfflineOutbox!();
  expect(await store.list()).toHaveLength(0);
});
it.each(['clientId','libraryId','syncEpoch'] as const)('rejects a parent with different %s',async(field)=>{
  const {api,store,parent}=await setup();
  await store.removeMany([parent.opId]); await store.enqueue({...parent,[field]:'different'});
  const before=await store.list();
  await expect(api.getPendingOfflineEntryAuthorOptions!(`local:${uid}`)).rejects.toThrow(/not found/i);
  await expect(api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid])).rejects.toThrow(/not found/i);
  expect(await store.list()).toEqual(before);
});
it.each(['offlineMutations','offlineEntryAuthors','offlinePendingEntryAuthors'] as const)('persists false and rejects when %s is missing or false',async(flag)=>{
  const {api,store,online}=await setup();
  const caps=await online.getSyncCapabilities();
  for(const value of [undefined,false]) {
    const featureFlags = {...caps.featureFlags};
    if (value === undefined) delete featureFlags[flag]; else featureFlags[flag] = value;
    vi.spyOn(online,'getSyncCapabilities').mockResolvedValue({...caps,featureFlags});
    await api.getSyncCapabilities({replay:false});
    expect(await store.readMeta('capability.offlinePendingEntryAuthors')).toBe('0');
    await expect(api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid])).rejects.toThrow(/supported/i);
    expect((await api.listPendingOfflineEntryCreates!())[0]).not.toHaveProperty('authors');
    expect(await store.list()).toHaveLength(1);
  }
});
it('rejects malformed keys, missing parents, unknown and duplicate canonical Author UIDs',async()=>{
  const {api,store}=await setup();
  for(const key of ['local:garbage',`local:${clientId}`,'1']) {
    await expect(api.getPendingOfflineEntryAuthorOptions!(key)).rejects.toThrow();
    await expect(api.enqueueOfflinePendingEntryAuthors!(key,[])).rejects.toThrow();
  }
  await expect(api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[clientId])).rejects.toThrow(/existing/i);
  await expect(api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid,authorUid.toUpperCase()])).rejects.toThrow(/duplicate/i);
  expect(await store.list()).toHaveLength(1);
});
it.each(['conflict','failed'] as const)('locks all three editors behind %s Author children',async(status)=>{
  const {api,store}=await setup();
  await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid]);
  await store.update((await store.list())[1]!.opId,{status,lastError:'review'});
  const before=await store.list();
  expect((await api.listPendingOfflineEntryCreates!())[0]).toMatchObject({canEditAuthors:false,canEditTags:false,canAppendContent:false,authorStatus:status,authorLastError:'review'});
  await expect(api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[])).rejects.toThrow(/blocked/i);
  await expect(api.enqueueOfflinePendingEntryTags!(`local:${uid}`,[])).rejects.toThrow(/blocked/i);
  await expect(api.enqueueOfflinePendingEntryContent!(`local:${uid}`,{contentType:'Notes',content:'later'})).rejects.toThrow(/blocked/i);
  expect(await store.list()).toEqual(before);
});
it('uses authoritative UID-mapped owner links as the baseline while retaining the create',async()=>{
  const {api,store,snapshot}=await setup();
  snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:12,syncUid:uid});
  snapshot.payload.entryProducers.push({entryId:12,producerId:9});
  await store.writeGeneration(2,JSON.stringify(await stamp(snapshot))); await store.writeMeta(ACTIVE_GENERATION_KEY,'2');
  expect((await api.listPendingOfflineEntryCreates!())[0]).toMatchObject({authors:[{producerUid:authorUid,name:'Offline Author'}]});
  await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid]);
  expect(await store.list()).toHaveLength(1);
  await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[]);
  expect((await store.list())[1]!.baseValues).toEqual({producerUids:[authorUid]});
});
it('does not report a durable Author save as unsaved after status-read failure',async()=>{
  const {api,store,state}=await setup();
  const list=store.list.bind(store), enqueue=store.enqueue.bind(store); let committed=false;
  vi.spyOn(store,'enqueue').mockImplementation(async op=>{const result=await enqueue(op);committed=true;return result;});
  vi.spyOn(store,'list').mockImplementation(async()=>{if(committed){committed=false;throw new Error('status read failed');}return list();});
  state.mode='online';
  await expect(api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid])).resolves.toBeUndefined();
  expect(await list()).toHaveLength(2); expect(state.mode).toBe('offline'); expect(state.lastReplayError).toContain('saved');
});
it('diagnoses the conjunctive pending Author capability',async()=>{
  const {state}=await setup();
  expect(state).toMatchObject({lastCapabilityProbe:{offlinePendingEntryAuthors:true},lastSuccessfulCapabilityProbe:{offlinePendingEntryAuthors:true}});
});
it('retains a concurrently enqueued child across snapshot cleanup',async()=>{
  const {api,store,online,snapshot,parent}=await setup();
  let release!:()=>void, entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}), gate=new Promise<void>(resolve=>{release=resolve;});
  online.replaySyncOperation=vi.fn().mockImplementation(async op=>({status:'applied',opId:op.opId,serverSeq:10,entityId:12}));
  online.fetchSyncSnapshot=vi.fn().mockImplementation(async()=>{
    entered(); await gate;
    const covering=structuredClone(snapshot); covering.header.snapshotSeq=2;covering.header.changeSeq=10;
    covering.payload.entries.push({...covering.payload.entries[0]!,id:12,syncUid:uid});return stamp(covering);
  });
  const flushing=api.flushOfflineOutbox!();await waiting;
  await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid]);release();await flushing;
  expect((await store.list()).map(row=>row.operationKind)).toEqual(['entry.create','entry.authors.set']);
  expect((await store.list())[0]!.opId).toBe(parent.opId);
  expect((await api.listPendingOfflineEntryCreates!())[0]).toMatchObject({canEditAuthors:true,authors:[{producerUid:authorUid,name:'Offline Author'}]});
});
it('cleans the last applied set after a later conflict but retains its parent and unapplied children',async()=>{
  const {api,store,online,snapshot,parent}=await setup();
  await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid]);
  await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[]);
  await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid]);
  const rows=await store.list();
  const replay=vi.fn().mockImplementation(async op=>op.opId===rows[2]!.opId
    ? {status:'conflict',opId:op.opId,currentVersion:2,currentValues:{producerUids:[authorUid]}}
    : {status:'applied',opId:op.opId,serverSeq:10,entityId:12});
  online.replaySyncOperation=replay;
  snapshot.header.snapshotSeq=2;snapshot.header.changeSeq=10;
  snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:12,syncUid:uid});snapshot.payload.entryProducers=[{entryId:12,producerId:9}];
  online.fetchSyncSnapshot=vi.fn().mockImplementation(()=>stamp(snapshot));
  await api.flushOfflineOutbox!();
  expect(replay.mock.calls.map(([op])=>op.opId)).toEqual(rows.slice(0,3).map(row=>row.opId));
  expect((await store.list()).map(row=>row.opId)).toEqual([parent.opId,rows[2]!.opId,rows[3]!.opId]);
  expect((await api.listPendingOfflineEntryCreates!())[0]!.canEditAuthors).toBe(false);
});
it.each(['wrong-owner','low-cursor','same-generation','bad-checksum'] as const)('retains Author chains for %s snapshots',async(fault)=>{
  const {api,store,online,snapshot}=await setup();
  await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid]);
  online.replaySyncOperation=vi.fn().mockImplementation(async op=>({status:'applied',opId:op.opId,serverSeq:10,entityId:12}));
  snapshot.header.snapshotSeq=fault==='same-generation'?1:2;snapshot.header.changeSeq=fault==='low-cursor'?9:1000;
  snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:12,syncUid:fault==='wrong-owner'?clientId:uid});
  snapshot.payload.entryProducers=[{entryId:12,producerId:9}];
  online.fetchSyncSnapshot=vi.fn().mockImplementation(async()=>{await stamp(snapshot);if(fault==='bad-checksum')snapshot.header.checksum='0'.repeat(64);return snapshot;});
  await api.flushOfflineOutbox!();expect(await store.list()).toHaveLength(2);
});
it.each(['entry.content.append','entry.tags.set'] as const)('locks Authors behind blocked %s siblings',async(kind)=>{
  const {api,store,parent}=await setup();
  const child=createPendingSyncOperation({clientId,libraryId:parent.libraryId,syncEpoch:parent.syncEpoch,entityKind:'entry',entityUid:uid,operationKind:kind,baseVersion:0,baseValues:kind==='entry.tags.set'?{tags:[]}:{},payload:kind==='entry.tags.set'?{parentCreateOpId:parent.opId,tags:[{name:'RPG',facetId:1}]}:{parentCreateOpId:parent.opId,content:{syncUid:crypto.randomUUID(),contentType:'Notes',content:'text'}}});
  await store.enqueue(child);await store.update(child.opId,{status:'failed',lastError:'review'});
  expect((await api.listPendingOfflineEntryCreates!())[0]!.canEditAuthors).toBe(false);
  await expect(api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid])).rejects.toThrow(/blocked/i);
});
it('does not predict revisions for pending Author children after snapshot mapping',async()=>{
  const {api,store,snapshot}=await setup();
  snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:12,syncUid:uid,syncVersion:5});
  await store.writeGeneration(2,JSON.stringify(await stamp(snapshot)));await store.writeMeta(ACTIVE_GENERATION_KEY,'2');
  await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid]);
  await api.updateEntry(12,{title:'changed'});
  expect((await store.list()).at(-1)!.baseVersion).toBe(5);
});
it('rejects an orphan if parent cleanup wins before the atomic enqueue',async()=>{
  const {api,store,parent}=await setup();
  const enqueue=store.enqueue.bind(store);
  vi.spyOn(store,'enqueue').mockImplementation(async operation=>{
    await store.removeMany([parent.opId]); return enqueue(operation);
  });
  await expect(api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid])).rejects.toThrow(/parent.*missing|refresh/i);
  expect(await store.list()).toEqual([]);
});
it.each(['failed','conflict'] as const)('rejects %s parents without saving children',async(status)=>{
  const {api,store,parent}=await setup();await store.update(parent.opId,{status,lastError:'review'});
  const before=await store.list();
  await expect(api.getPendingOfflineEntryAuthorOptions!(`local:${uid}`)).rejects.toThrow(/blocked/i);
  await expect(api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[authorUid])).rejects.toThrow(/blocked/i);
  expect(await store.list()).toEqual(before);
});
it('allows disjoint pending Tag and Content chains past a blocked Author owner',async()=>{
  const {api,store,online,parent}=await setup();
  await store.update(parent.opId,{status:'conflict',lastError:'review'});
  const otherUid='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const other={...parent,opId:crypto.randomUUID(),entityUid:otherUid}; await store.enqueue(other);
  const tag=createPendingSyncOperation({clientId,libraryId:parent.libraryId,syncEpoch:parent.syncEpoch,entityKind:'entry',entityUid:otherUid,operationKind:'entry.tags.set',baseVersion:0,baseValues:{tags:[]},payload:{parentCreateOpId:other.opId,tags:[{name:'RPG',facetId:1}]}});
  const content=createPendingSyncOperation({clientId,libraryId:parent.libraryId,syncEpoch:parent.syncEpoch,entityKind:'entry',entityUid:otherUid,operationKind:'entry.content.append',baseVersion:0,baseValues:{},payload:{parentCreateOpId:other.opId,content:{syncUid:crypto.randomUUID(),contentType:'Notes',content:'text'}}});
  await store.enqueue(tag);await store.enqueue(content);
  const replay=vi.fn().mockImplementation(async op=>({status:'applied',opId:op.opId,serverSeq:10,entityId:13}));
  online.replaySyncOperation=replay;online.fetchSyncSnapshot=vi.fn().mockRejectedValue(new Error('keep queued'));
  await api.flushOfflineOutbox!();
  expect(replay.mock.calls.map(([op])=>op.opId)).toEqual([other.opId,tag.opId,content.opId]);
  expect(await store.list()).toHaveLength(4);
});
it('creates a separate immutable pending Author and retains same-owner options after unlink/relink', async()=>{
  const {api,store,parent}=await setup();
  await store.writeMeta('capability.offlinePendingEntryAuthorCreate','1');
  const key=`local:${uid}`;
  const author=await api.enqueueOfflinePendingEntryAuthorCreate!(key,' New Author ');
  expect(author.name).toBe('New Author');
  expect((await store.list())[0]).toEqual(parent);
  expect((await store.list())[1]).toMatchObject({operationKind:'entry.author.create-and-link',baseVersion:0,baseValues:{producerUids:[]},payload:{parentCreateOpId:parent.opId,...author}});
  expect((await api.listPendingOfflineEntryCreates!())[0]!.authors).toEqual([author]);
  await api.enqueueOfflinePendingEntryAuthors!(key,[]);
  expect((await api.getPendingOfflineEntryAuthorOptions!(key)).authors).toContainEqual(author);
  await api.enqueueOfflinePendingEntryAuthors!(key,[author.producerUid]);
  expect((await api.listPendingOfflineEntryCreates!())[0]!.authors).toEqual([author]);
});
it('persists the new Author conjunctive gate and holds later children on downgrade', async()=>{
  const {api,store,online,parent}=await setup();
  const caps=await online.getSyncCapabilities();
  online.getSyncCapabilities=vi.fn().mockResolvedValue({...caps,featureFlags:{...caps.featureFlags,offlineAuthorCreate:true,offlinePendingEntryAuthorCreate:true}});
  await api.getSyncCapabilities({replay:false});
  expect(await store.readMeta('capability.offlinePendingEntryAuthorCreate')).toBe('1');
  expect((await api.getPendingOfflineEntryAuthorOptions!(`local:${uid}`)).canCreateAuthor).toBe(true);
  await api.enqueueOfflinePendingEntryAuthorCreate!(`local:${uid}`,'New');
  await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[]);
  await store.writeMeta('capability.offlinePendingEntryAuthorCreate','0');
  online.replaySyncOperation=vi.fn().mockImplementation(async op=>({status:'applied',opId:op.opId,serverSeq:10,entityId:12}));
  online.fetchSyncSnapshot=vi.fn().mockRejectedValue(new Error('keep queued'));
  await api.flushOfflineOutbox!();
  expect(vi.mocked(online.replaySyncOperation).mock.calls.map(([op])=>op.opId)).toEqual([parent.opId]);
});
it('cleans a created Author after a later applied unlink without requiring its historical link', async()=>{
  const {api,store,online,snapshot}=await setup();
  await store.writeMeta('capability.offlinePendingEntryAuthorCreate','1');
  await store.writeMeta('capability.offlineAuthorCreate','1');
  const author=await api.enqueueOfflinePendingEntryAuthorCreate!(`local:${uid}`,'New');
  await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[]);
  online.replaySyncOperation=vi.fn().mockImplementation(async op=>({status:'applied',opId:op.opId,serverSeq:10,entityId:op.operationKind==='entry.author.create-and-link'?17:12}));
  snapshot.header.snapshotSeq=2;snapshot.header.changeSeq=10;
  snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:12,syncUid:uid});
  snapshot.payload.producers.push({...snapshot.payload.producers[0]!,id:17,syncUid:author.producerUid,name:author.name});
  online.fetchSyncSnapshot=vi.fn().mockImplementation(()=>stamp(snapshot));
  await api.flushOfflineOutbox!();
  expect(await store.list()).toEqual([]);
});
it('excludes pending new Author links from legacy revision prediction', async()=>{
  const {api,store,snapshot}=await setup();
  await store.writeMeta('capability.offlinePendingEntryAuthorCreate','1');
  snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:12,syncUid:uid,syncVersion:5});
  await store.writeGeneration(2,JSON.stringify(await stamp(snapshot)));await store.writeMeta(ACTIVE_GENERATION_KEY,'2');
  await api.enqueueOfflinePendingEntryAuthorCreate!(`local:${uid}`,'New');await api.updateEntry(12,{title:'changed'});
  expect((await store.list()).at(-1)!.baseVersion).toBe(5);
});
it('cold reopens IndexedDB create unlink relink with stable same-owner Author options', async()=>{
  const databaseName=crypto.randomUUID();
  const first=createIndexedDbOfflineStore({indexedDB,databaseName});
  try {
    const {api,parent}=await setup(first);
    await first.writeMeta('capability.offlinePendingEntryAuthorCreate','1');
    const author=await api.enqueueOfflinePendingEntryAuthorCreate!(`local:${uid}`,'Cold Author');
    await api.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[]);
    first.close();
    const reopened=createIndexedDbOfflineStore({indexedDB,databaseName});
    try {
      const restart=createOfflineAwareGalleryApi({} as GalleryApi,reopened,{clientId});
      expect((await restart.getPendingOfflineEntryAuthorOptions!(`local:${uid}`)).authors).toContainEqual(author);
      expect((await restart.listPendingOfflineEntryCreates!())[0]!.authors).toEqual([]);
      await restart.enqueueOfflinePendingEntryAuthors!(`local:${uid}`,[author.producerUid]);
      expect((await restart.listPendingOfflineEntryCreates!())[0]!.authors).toEqual([author]);
      expect((await reopened.list())[0]).toEqual(parent);
    } finally {reopened.close();}
  } finally {first.close();}
});
it.each(['offlineMutations','offlineAuthorCreate','offlineEntryAuthors','offlinePendingEntryAuthors','offlinePendingEntryAuthorCreate'])('fails closed when new Author gate %s is absent or false',async flag=>{
  const {api,store,online}=await setup();
  for(const value of [undefined,false]){
    const flags: Record<string,boolean>={offlineMutations:true,offlineAuthorCreate:true,offlineEntryAuthors:true,offlinePendingEntryAuthors:true,offlinePendingEntryAuthorCreate:true};
    if(value===undefined) delete flags[flag]; else flags[flag]=value;
    online.getSyncCapabilities=vi.fn().mockResolvedValue({featureFlags:flags});await api.getSyncCapabilities({replay:false});
    expect(await store.readMeta('capability.offlinePendingEntryAuthorCreate')).toBe('0');
    await expect(api.enqueueOfflinePendingEntryAuthorCreate!(`local:${uid}`,'New')).rejects.toThrow(/supported/i);
    expect(await store.list()).toHaveLength(1);
  }
});
it('refuses typed existing names and aliases rather than silently retargeting',async()=>{
  const {api,store,snapshot}=await setup();await store.writeMeta('capability.offlinePendingEntryAuthorCreate','1');
  snapshot.payload.taxonomyAliases ??= [];
  snapshot.payload.taxonomyAliases.push({id:1,vocabulary:'producer',partition:'authors',aliasName:'Alias',normalizedAlias:'alias',canonicalName:'Offline Author',normalizedCanonical:'offline author'});
  await store.writeGeneration(2,JSON.stringify(await stamp(snapshot)));await store.writeMeta(ACTIVE_GENERATION_KEY,'2');
  for(const name of [' offline author ','Alias','   ']) await expect(api.enqueueOfflinePendingEntryAuthorCreate!(`local:${uid}`,name)).rejects.toThrow();
  expect(await store.list()).toHaveLength(1);
});
it('rejects another pending Entry local Author without writing a child',async()=>{
  const {api,store,parent}=await setup();await store.writeMeta('capability.offlinePendingEntryAuthorCreate','1');
  const author=await api.enqueueOfflinePendingEntryAuthorCreate!(`local:${uid}`,'New');
  const otherUid=crypto.randomUUID();await store.enqueue({...parent,opId:crypto.randomUUID(),entityUid:otherUid});
  await expect(api.enqueueOfflinePendingEntryAuthors!(`local:${otherUid}`,[author.producerUid])).rejects.toThrow(/existing/i);
  expect(await store.list()).toHaveLength(3);
});
it('keeps new Author chains when a covering verified snapshot maps its Producer UID to the wrong receipt ID',async()=>{
  const {api,store,online,snapshot}=await setup();await store.writeMeta('capability.offlinePendingEntryAuthorCreate','1');await store.writeMeta('capability.offlineAuthorCreate','1');
  const author=await api.enqueueOfflinePendingEntryAuthorCreate!(`local:${uid}`,'New');
  online.replaySyncOperation=vi.fn().mockImplementation(async op=>({status:'applied',opId:op.opId,serverSeq:10,entityId:op.operationKind==='entry.author.create-and-link'?17:12}));
  snapshot.header.snapshotSeq=2;snapshot.header.changeSeq=10;
  snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:12,syncUid:uid});
  snapshot.payload.producers.push({...snapshot.payload.producers[0]!,id:18,syncUid:author.producerUid,name:author.name});snapshot.payload.entryProducers.push({entryId:12,producerId:18});
  online.fetchSyncSnapshot=vi.fn().mockImplementation(()=>stamp(snapshot));await api.flushOfflineOutbox!();expect(await store.list()).toHaveLength(2);
});
async function setup(provided?: SnapshotStore & OutboxStore) {
  const snapshot = offlineSnapshot();
  snapshot.payload.entryProducers = [];
  const store = provided ?? { ...createMemorySnapshotStore(), ...createMemoryOutboxStore() };
  await store.writeGeneration(1, JSON.stringify(snapshot));
  await store.writeMeta(ACTIVE_GENERATION_KEY, '1');
  const parent = createPendingSyncOperation({clientId,libraryId:'library-1',syncEpoch:'epoch-1',entityKind:'entry',entityUid:uid,operationKind:'entry.create',baseVersion:0,baseValues:{},payload:{title:'New',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false}});
  await store.enqueue(parent);
  const online = {getSyncCapabilities:vi.fn().mockResolvedValue({featureFlags:{offlineMutations:true,offlineEntryAuthors:true,offlinePendingEntryAuthors:true,offlineEntryTags:true,offlinePendingEntryTags:true,offlineEntryContentAppend:true}})} as unknown as GalleryApi;
  const state = {mode:'offline' as 'offline'|'online',lastFallbackAt:null,lastReplayError:null as string|null};
  const api = createOfflineAwareGalleryApi(online,store,{clientId,state});
  await api.getSyncCapabilities({replay:false});
  return {api,store,parent,online,snapshot,state};
}
it('queues immutable existing workless Author add/remove sets, skips noops and projects after restart', async () => {
  const {api,store,parent}=await setup();
  const key=`local:${uid}`;
  expect(await api.getPendingOfflineEntryAuthorOptions!(key)).toEqual({authors:[{producerUid:authorUid,name:'Offline Author'}]});
  await api.enqueueOfflinePendingEntryAuthors!(key,[]);
  await api.enqueueOfflinePendingEntryAuthors!(key,[authorUid]);
  await api.enqueueOfflinePendingEntryAuthors!(key,[authorUid.toUpperCase()]);
  const restarted=createOfflineAwareGalleryApi({} as GalleryApi,store,{clientId});
  expect((await restarted.listPendingOfflineEntryCreates!())[0]).toMatchObject({authors:[{producerUid:authorUid,name:'Offline Author'}],authorStatus:'pending',authorLastError:null,canEditAuthors:true});
  await restarted.enqueueOfflinePendingEntryAuthors!(key,[]);
  const rows=await store.list();
  expect(rows[0]).toEqual(parent);
  expect(rows.slice(1).map(row=>[row.baseVersion,row.baseValues,row.payload])).toEqual([
    [0,{producerUids:[]},{parentCreateOpId:parent.opId,producerUids:[authorUid]}],
    [0,{producerUids:[authorUid]},{parentCreateOpId:parent.opId,producerUids:[]}],
  ]);
});
