// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { GalleryApi } from '../src/api/gallery.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createMemorySnapshotStore, ACTIVE_GENERATION_KEY } from '../src/offline/snapshot-store.js';
import { createMemoryOutboxStore, createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';
const clientId='cccccccc-cccc-4ccc-8ccc-cccccccccccc', uid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function setup(){
 const store={...createMemorySnapshotStore(),...createMemoryOutboxStore()};const snapshot=offlineSnapshot();
 snapshot.payload.tagGroups=[{id:2,entryType:'game',name:'Genre',groupKind:'section',parentId:null,sortOrder:0},{id:1,entryType:'game',name:'Main',groupKind:'facet',parentId:2,sortOrder:0}];
 await store.writeGeneration(1,JSON.stringify(snapshot));await store.writeMeta(ACTIVE_GENERATION_KEY,'1');
 const parent=createPendingSyncOperation({clientId,libraryId:'library-1',syncEpoch:'epoch-1',entityKind:'entry',entityUid:uid,operationKind:'entry.create',baseVersion:0,baseValues:{},payload:{title:'New',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false}});await store.enqueue(parent);
 const online={getSyncCapabilities:vi.fn().mockResolvedValue({featureFlags:{offlineMutations:true,offlinePendingEntryMetadata:true,offlineEntryTags:true,offlinePendingEntryTags:true,offlineEntryAuthors:true,offlinePendingEntryAuthors:true,offlineEntryContentAppend:true}})} as unknown as GalleryApi;
 const api=createOfflineAwareGalleryApi(online,store,{clientId});await api.getSyncCapabilities({replay:false});return {api,store,parent,online,snapshot};
}
async function stamp(snapshot: ReturnType<typeof offlineSnapshot>) {
 snapshot.header.counts.entries=snapshot.payload.entries.length;
 const {checksum,...header}=snapshot.header;void checksum;
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(header)+JSON.stringify(snapshot.payload)));
 snapshot.header.checksum=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');return snapshot;
}
it('holds downgraded metadata then verifies the last applied value of every patched field',async()=>{
 const {api,store,online,snapshot}=await setup();
 await api.enqueueOfflinePendingEntryMetadata!(`local:${uid}`,{title:'Renamed',uploadDate:null,pageCount:null});
 await api.enqueueOfflinePendingEntryMetadata!(`local:${uid}`,{title:'Renamed',uploadDate:null,pageCount:42});
 const replay=vi.fn().mockImplementation(async op=>({status:'applied',opId:op.opId,serverSeq:10,entityId:12}));online.replaySyncOperation=replay;
 snapshot.header.snapshotSeq=2;snapshot.header.changeSeq=10;
 snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:12,syncUid:uid,title:'Wrong',pageCount:42});
 online.fetchSyncSnapshot=vi.fn().mockImplementation(()=>stamp(snapshot));
 await store.writeMeta('capability.offlinePendingEntryMetadata','0');await api.flushOfflineOutbox!();
 expect(replay.mock.calls.map(([op])=>op.operationKind)).toEqual(['entry.create']);expect(await store.list()).toHaveLength(3);
 await store.writeMeta('capability.offlinePendingEntryMetadata','1');replay.mockClear();snapshot.header.snapshotSeq=3;
 await api.flushOfflineOutbox!();expect(await store.list()).toHaveLength(3);
 snapshot.payload.entries.at(-1)!.title='Renamed';await api.flushOfflineOutbox!();expect(await store.list()).toHaveLength(0);
});
it('excludes pending metadata from legacy revision prediction',async()=>{
 const {api,store,snapshot}=await setup();snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:12,syncUid:uid,syncVersion:5});
 await store.writeGeneration(2,JSON.stringify(await stamp(snapshot)));await store.writeMeta(ACTIVE_GENERATION_KEY,'2');
 await api.enqueueOfflinePendingEntryMetadata!(`local:${uid}`,{title:'Renamed',uploadDate:null,pageCount:null});await api.updateEntry(12,{title:'Next'});
 expect((await store.list()).at(-1)!.baseVersion).toBe(5);
});
it('records conjunctive metadata diagnostics',async()=>{
 const {store,online}=await setup();const state={mode:'offline' as const,lastFallbackAt:null};
 const api=createOfflineAwareGalleryApi(online,store,{clientId,state});await api.getSyncCapabilities({replay:false});
 expect(state).toMatchObject({lastCapabilityProbe:{offlinePendingEntryMetadata:true},lastSuccessfulCapabilityProbe:{offlinePendingEntryMetadata:true}});
});
it.each(['clientId','libraryId','syncEpoch'] as const)('rejects mismatched metadata parent %s without queue writes',async field=>{
 const {api,store,parent}=await setup();await store.removeMany([parent.opId]);await store.enqueue({...parent,[field]:'wrong'});const before=await store.list();
 expect((await api.listPendingOfflineEntryCreates!())[0]).not.toHaveProperty('ratings');
 await expect(api.enqueueOfflinePendingEntryMetadata!(`local:${uid}`,{title:'Next',uploadDate:null,pageCount:null})).rejects.toThrow(/not found/i);expect(await store.list()).toEqual(before);
});
it.each(['offlineMutations','offlinePendingEntryMetadata'] as const)('persists missing/false %s gate',async flag=>{
 const {api,store,online}=await setup();for(const value of [undefined,false]){
 const featureFlags:Record<string,boolean>={offlineMutations:true,offlinePendingEntryMetadata:true};if(value===undefined)delete featureFlags[flag];else featureFlags[flag]=value;
 online.getSyncCapabilities=vi.fn().mockResolvedValue({featureFlags});await api.getSyncCapabilities({replay:false});
 expect(await store.readMeta('capability.offlinePendingEntryMetadata')).toBe('0');await expect(api.enqueueOfflinePendingEntryMetadata!(`local:${uid}`,{title:'Next',uploadDate:null,pageCount:null})).rejects.toThrow(/supported/i);expect(await store.list()).toHaveLength(1);
 }
});
it.each(['failed','conflict'] as const)('locks all editors behind %s metadata',async status=>{
 const {api,store}=await setup();await api.enqueueOfflinePendingEntryMetadata!(`local:${uid}`,{title:'Next',uploadDate:null,pageCount:null});await store.update((await store.list())[1]!.opId,{status,lastError:'review'});
 expect((await api.listPendingOfflineEntryCreates!())[0]).toMatchObject({canEditMetadata:false,canEditTags:false,canEditAuthors:false,canAppendContent:false,metadataEditStatus:status});
 const before=await store.list();await expect(api.enqueueOfflinePendingEntryMetadata!(`local:${uid}`,{title:'Later',uploadDate:null,pageCount:null})).rejects.toThrow(/blocked/i);expect(await store.list()).toEqual(before);
});
it('rejects cleanup-before-enqueue without an orphan',async()=>{
 const {api,store,parent}=await setup();const enqueue=store.enqueue.bind(store);vi.spyOn(store,'enqueue').mockImplementation(async op=>{await store.removeMany([parent.opId]);return enqueue(op);});
 await expect(api.enqueueOfflinePendingEntryMetadata!(`local:${uid}`,{title:'Next',uploadDate:null,pageCount:null})).rejects.toThrow(/parent.*missing|refresh/i);expect(await store.list()).toEqual([]);
});
it('retains metadata when snapshot numeric owner disagrees with its receipt',async()=>{
 const {api,store,online,snapshot}=await setup();await api.enqueueOfflinePendingEntryMetadata!(`local:${uid}`,{title:'Next',uploadDate:null,pageCount:null});
 online.replaySyncOperation=vi.fn().mockImplementation(async op=>({status:'applied',opId:op.opId,serverSeq:10,entityId:12}));snapshot.header.snapshotSeq=2;snapshot.header.changeSeq=10;
 snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:13,syncUid:uid,title:'Next'});online.fetchSyncSnapshot=vi.fn().mockImplementation(()=>stamp(snapshot));
 await api.flushOfflineOutbox!();expect(await store.list()).toHaveLength(2);
});
it.each(['wrong-uid','low-cursor','same-generation','bad-checksum'] as const)('retains applied metadata on %s snapshot',async fault=>{
 const {api,store,online,snapshot}=await setup();await api.enqueueOfflinePendingEntryMetadata!(`local:${uid}`,{title:'Next',uploadDate:null,pageCount:null});
 online.replaySyncOperation=vi.fn().mockImplementation(async op=>({status:'applied',opId:op.opId,serverSeq:10,entityId:12}));snapshot.header.snapshotSeq=fault==='same-generation'?1:2;snapshot.header.changeSeq=fault==='low-cursor'?9:10;
 snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:12,syncUid:fault==='wrong-uid'?clientId:uid,title:'Next'});
 online.fetchSyncSnapshot=vi.fn().mockImplementation(async()=>{await stamp(snapshot);if(fault==='bad-checksum')snapshot.header.checksum='0'.repeat(64);return snapshot;});await api.flushOfflineOutbox!();expect(await store.list()).toHaveLength(2);
});
it('does not report a durable metadata save as unsaved after status-read failure',async()=>{
 const {store,online}=await setup();const state={mode:'online' as 'online'|'offline',lastFallbackAt:null,lastReplayError:null as string|null};const api=createOfflineAwareGalleryApi(online,store,{clientId,state});
 const list=store.list.bind(store),enqueue=store.enqueue.bind(store);let committed=false;
 vi.spyOn(store,'enqueue').mockImplementation(async op=>{const result=await enqueue(op);committed=true;return result;});vi.spyOn(store,'list').mockImplementation(async()=>{if(committed){committed=false;throw new Error('status failed');}return list();});
 await expect(api.enqueueOfflinePendingEntryMetadata!(`local:${uid}`,{title:'Next',uploadDate:null,pageCount:null})).resolves.toBeUndefined();expect(await list()).toHaveLength(2);expect(state.lastReplayError).toContain('saved');expect(state.mode).toBe('offline');
});
it('retries the identical immutable operation after response loss and restart',async()=>{
 const {api,store,online}=await setup();await api.enqueueOfflinePendingEntryMetadata!(`local:${uid}`,{title:'Next',uploadDate:null,pageCount:null});
 const captured:unknown[]=[];online.replaySyncOperation=vi.fn().mockImplementation(async op=>{captured.push(op);if(op.operationKind==='entry.update')throw new TypeError('network lost');return {status:'applied',opId:op.opId,serverSeq:10,entityId:12};});
 await api.flushOfflineOutbox!();await createOfflineAwareGalleryApi(online,store,{clientId}).flushOfflineOutbox!();expect(captured[1]).toEqual(captured[3]);expect(await store.list()).toHaveLength(2);
});
it('interleaves all pending families and retains a newly queued metadata child during snapshot cleanup',async()=>{
 const {api,store,online,snapshot,parent}=await setup();const key=`local:${uid}`;
 await api.enqueueOfflinePendingEntryMetadata!(key,{title:'Next',uploadDate:null,pageCount:null});
 await api.enqueueOfflinePendingEntryTags!(key,[{name:'RPG',facetId:1}]);
 await api.enqueueOfflinePendingEntryAuthors!(key,['99999999-9999-4999-8999-999999999999']);
 await api.enqueueOfflinePendingEntryContent!(key,{contentType:'Notes',content:'later'});
 expect((await store.list()).map(row=>row.operationKind)).toEqual(['entry.create','entry.update','entry.tags.set','entry.authors.set','entry.content.append']);
 const children=(await store.list()).slice(2);await store.removeMany(children.map(row=>row.opId));
 let entered!:()=>void,release!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 online.replaySyncOperation=vi.fn().mockImplementation(async op=>({status:'applied',opId:op.opId,serverSeq:10,entityId:12}));
 online.fetchSyncSnapshot=vi.fn().mockImplementation(async()=>{entered();await gate;snapshot.header.snapshotSeq=2;snapshot.header.changeSeq=10;snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:12,syncUid:uid,title:'Next'});return stamp(snapshot);});
 const flushing=api.flushOfflineOutbox!();await waiting;await api.enqueueOfflinePendingEntryMetadata!(key,{title:'Next',uploadDate:null,pageCount:42});release();await flushing;
 const remaining=await store.list();expect(remaining.map(row=>row.operationKind)).toEqual(['entry.create','entry.update']);expect(remaining[0]!.payload).toEqual(parent.payload);expect(remaining[0]!.opId).toBe(parent.opId);expect((await api.listPendingOfflineEntryCreates!())[0]).toMatchObject({title:'Next',pageCount:42});
});
it.each(['entry.tags.set','entry.authors.set','entry.content.append'] as const)('rejects metadata behind a blocked %s sibling',async kind=>{
 const {api,store,parent}=await setup();const payload=kind==='entry.tags.set'?{parentCreateOpId:parent.opId,tags:[{name:'RPG',facetId:1}]}:kind==='entry.authors.set'?{parentCreateOpId:parent.opId,producerUids:['99999999-9999-4999-8999-999999999999']}:{parentCreateOpId:parent.opId,content:{syncUid:crypto.randomUUID(),contentType:'Notes',content:'text'}};
 const child=createPendingSyncOperation({clientId,libraryId:parent.libraryId,syncEpoch:parent.syncEpoch,entityKind:'entry',entityUid:uid,operationKind:kind,baseVersion:0,baseValues:kind==='entry.tags.set'?{tags:[]}:kind==='entry.authors.set'?{producerUids:[]}:{},payload});await store.enqueue(child);await store.update(child.opId,{status:'failed',lastError:'review'});
 expect((await api.listPendingOfflineEntryCreates!())[0]!.canEditMetadata).toBe(false);await expect(api.enqueueOfflinePendingEntryMetadata!(`local:${uid}`,{title:'Next',uploadDate:null,pageCount:null})).rejects.toThrow(/blocked/i);
});
it('replays an independent metadata owner past a blocked parent',async()=>{
 const {api,store,online,parent}=await setup();await store.update(parent.opId,{status:'conflict',lastError:'review'});
 const otherUid='dddddddd-dddd-4ddd-8ddd-dddddddddddd',other={...parent,opId:crypto.randomUUID(),entityUid:otherUid};await store.enqueue(other);
 await api.enqueueOfflinePendingEntryMetadata!(`local:${otherUid}`,{title:'Next',uploadDate:null,pageCount:null});
 const replay=vi.fn().mockImplementation(async op=>({status:'applied',opId:op.opId,serverSeq:10,entityId:13}));online.replaySyncOperation=replay;online.fetchSyncSnapshot=vi.fn().mockRejectedValue(new TypeError('offline'));
 await api.flushOfflineOutbox!();expect(replay.mock.calls.map(([op])=>op.operationKind)).toEqual(['entry.create','entry.update']);expect(replay.mock.calls[0]![0].entityUid).toBe(otherUid);
});
it('queues changed fields independently and projects sequential disjoint patches after restart',async()=>{
 const {api,store,parent}=await setup();const key=`local:${uid}`;
 await api.enqueueOfflinePendingEntryMetadata!(key,{title:'New',uploadDate:null,pageCount:null});
 await api.enqueueOfflinePendingEntryMetadata!(key,{title:'Renamed',uploadDate:null,pageCount:null});
 const restart=createOfflineAwareGalleryApi({} as GalleryApi,store,{clientId});
 await restart.enqueueOfflinePendingEntryMetadata!(key,{title:'Renamed',uploadDate:null,pageCount:42});
 const rows=await store.list();expect(rows[0]).toEqual(parent);
 expect(rows.slice(1).map(row=>[row.baseValues,row.payload])).toEqual([[{title:'New'},{parentCreateOpId:parent.opId,title:'Renamed'}],[{pageCount:null},{parentCreateOpId:parent.opId,pageCount:42}]]);
 expect((await restart.listPendingOfflineEntryCreates!())[0]).toMatchObject({title:'Renamed',pageCount:42,canEditMetadata:true,metadataEditStatus:'pending',metadataEditError:null});
});
