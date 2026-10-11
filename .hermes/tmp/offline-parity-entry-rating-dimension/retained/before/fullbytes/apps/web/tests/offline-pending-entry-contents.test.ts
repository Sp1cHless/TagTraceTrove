// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { syncSnapshotSchema } from '@t3/shared';
import { indexedDB } from 'fake-indexeddb';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import type { SnapshotStore } from '../src/offline/snapshot-store.js';
import type { OutboxStore } from '../src/offline/outbox-store.js';
import type { GalleryApi } from '../src/api/gallery.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createMemorySnapshotStore, ACTIVE_GENERATION_KEY } from '../src/offline/snapshot-store.js';
import { createMemoryOutboxStore, createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';
const clientId='cccccccc-cccc-4ccc-8ccc-cccccccccccc', uid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const contentUid='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
async function setup(provided?: SnapshotStore & OutboxStore){
 const store=provided ?? {...createMemorySnapshotStore(),...createMemoryOutboxStore()};const snapshot=offlineSnapshot();
 await store.writeGeneration(1,JSON.stringify(snapshot));await store.writeMeta(ACTIVE_GENERATION_KEY,'1');
 const parent=createPendingSyncOperation({clientId,libraryId:'library-1',syncEpoch:'epoch-1',entityKind:'entry',entityUid:uid,operationKind:'entry.create',baseVersion:0,baseValues:{},payload:{title:'New',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false,contents:[{syncUid:contentUid,contentType:'Notes',content:'original',sortOrder:0}]}});await store.enqueue(parent);
 const online={getSyncCapabilities:vi.fn().mockResolvedValue({featureFlags:{offlineMutations:true,offlineEntryInitialContents:true,offlineEntryContents:true,offlinePendingEntryContents:true,offlineEntryContentAppend:true}})} as unknown as GalleryApi;
 const state={mode:'offline' as const,lastFallbackAt:null,lastReplayError:null as string|null};
 const api=createOfflineAwareGalleryApi(online,store,{clientId,state});await api.getSyncCapabilities({replay:false});return {api,store,parent,online,snapshot,state};
}
async function stamp(snapshot: ReturnType<typeof offlineSnapshot>) {
 snapshot=syncSnapshotSchema.parse(snapshot);
 snapshot.header.counts.entries=snapshot.payload.entries.length;
 snapshot.header.counts.entryContents=snapshot.payload.entryContents.length;
 const {checksum,...header}=snapshot.header;void checksum;
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(header)+JSON.stringify(snapshot.payload)));
 snapshot.header.checksum=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');return snapshot;
}
it('cleans removed initial and appended Contents but verifies append after the last set',async()=>{
 const {api,store,online,snapshot,state}=await setup();const key=`local:${uid}`;
 await api.enqueueOfflinePendingEntryContent!(key,{contentType:'Notes',content:'removed append'});
 await api.enqueueOfflinePendingEntryContents!(key,[]);
 await api.enqueueOfflinePendingEntryContent!(key,{contentType:'Notes',content:'survives'});
 const append=(await store.list()).at(-1)!;const row=append.payload.content as {syncUid:string;contentType:string;content:string};
 online.replaySyncOperation=vi.fn().mockImplementation(async op=>({status:'applied',opId:op.opId,serverSeq:10,entityId:12}));
 snapshot.header.snapshotSeq=2;snapshot.header.changeSeq=10;
 snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:12,syncUid:uid});
 snapshot.payload.entryContents.push({id:22,entryId:12,...row,sortOrder:0,syncVersion:1});
 online.fetchSyncSnapshot=vi.fn().mockImplementation(()=>stamp(snapshot));
 await api.flushOfflineOutbox!();expect(state.lastReplayError).toBeNull();expect(await store.list()).toEqual([]);
});
it('holds pending Content set and later appends on capability downgrade',async()=>{
 const {api,store,online,snapshot}=await setup();const key=`local:${uid}`;
 await api.enqueueOfflinePendingEntryContents!(key,[]);
 await api.enqueueOfflinePendingEntryContent!(key,{contentType:'Notes',content:'later'});
 await store.writeMeta('capability.offlinePendingEntryContents','0');
 const replay=vi.fn().mockImplementation(async op=>({status:'applied',opId:op.opId,serverSeq:10,entityId:12}));online.replaySyncOperation=replay;
 snapshot.header.snapshotSeq=2;snapshot.header.changeSeq=10;snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:12,syncUid:uid});
 snapshot.payload.entryContents.push({id:22,entryId:12,syncUid:contentUid,contentType:'Notes',content:'original',sortOrder:0,syncVersion:1});online.fetchSyncSnapshot=vi.fn().mockImplementation(()=>stamp(snapshot));
 await api.flushOfflineOutbox!();expect(replay.mock.calls.map(([op])=>op.operationKind)).toEqual(['entry.create']);expect(await store.list()).toHaveLength(3);
});
it('excludes explicit-parent Content sets from positive legacy revision prediction',async()=>{
 const {api,store,snapshot}=await setup();snapshot.payload.entries.push({...snapshot.payload.entries[0]!,id:12,syncUid:uid,syncVersion:5});
 snapshot.payload.entryContents.push({id:22,entryId:12,syncUid:contentUid,contentType:'Notes',content:'original',sortOrder:0,syncVersion:1});
 await store.writeGeneration(2,JSON.stringify(await stamp(snapshot)));await store.writeMeta(ACTIVE_GENERATION_KEY,'2');
 await api.enqueueOfflinePendingEntryContents!(`local:${uid}`,[]);await api.updateEntry(12,{title:'Next'});
 expect((await store.list()).at(-1)!.baseVersion).toBe(5);
});
it('captures immutable full Content baseline and projects replacement/removal after restart',async()=>{
 const {api,store,parent}=await setup();const key=`local:${uid}`;
 expect(await api.getPendingOfflineEntryContentOptions!(key)).toEqual({contents:[{syncUid:contentUid,contentType:'Notes',content:'original',sortOrder:0}]});
 await api.enqueueOfflinePendingEntryContents!(key,[{syncUid:contentUid,contentType:'Notes',content:'changed',sortOrder:3}]);
 const rows=await store.list();expect(rows[0]).toEqual(parent);expect(rows[1]).toMatchObject({operationKind:'entry.contents.set',baseVersion:0,baseValues:{contents:[{syncUid:contentUid,contentType:'Notes',content:'original',sortOrder:0}]},payload:{parentCreateOpId:parent.opId,contents:[{syncUid:contentUid,contentType:'Notes',content:'changed',sortOrder:3}]}});
 const restart=createOfflineAwareGalleryApi({} as GalleryApi,store,{clientId});expect((await restart.listPendingOfflineEntryCreates!())[0]).toMatchObject({contents:[{syncUid:contentUid,content:'changed',sortOrder:3}],canEditContents:true});
 await restart.enqueueOfflinePendingEntryContents!(key,[]);expect(await restart.getPendingOfflineEntryContentOptions!(key)).toEqual({contents:[]});
});
it('durably cold reopens initial and appended Content edits in real IndexedDB', async () => {
 const databaseName=crypto.randomUUID();
 const first=createIndexedDbOfflineStore({indexedDB,databaseName});
 try {
  const {api,parent}=await setup(first);
  await api.enqueueOfflinePendingEntryContent!(`local:${uid}`,{contentType:'Notes',content:'later'});
  const before=(await api.getPendingOfflineEntryContentOptions!(`local:${uid}`)).contents;
  await api.enqueueOfflinePendingEntryContents!(`local:${uid}`,before.slice(0,1).map(row=>({...row,content:'cold edit'})));
  first.close();
  const reopened=createIndexedDbOfflineStore({indexedDB,databaseName});
  try {
   const restarted=createOfflineAwareGalleryApi({} as GalleryApi,reopened,{clientId});
   expect(await restarted.getPendingOfflineEntryContentOptions!(`local:${uid}`)).toEqual({contents:[{syncUid:contentUid,contentType:'Notes',content:'cold edit',sortOrder:0}]});
   expect((await reopened.list())[0]).toEqual(parent);
   expect((await restarted.listPendingOfflineEntryCreates!())[0]).toMatchObject({canEditContents:true,contents:[{content:'cold edit'}]});
  } finally {reopened.close();}
 } finally {first.close();}
});
it.each(['offlineMutations','offlineEntryContents','offlinePendingEntryContents'])('rejects new Content edits when %s is false',async flag=>{
 const {api,store,online}=await setup();
 online.getSyncCapabilities=vi.fn().mockResolvedValue({featureFlags:{offlineMutations:true,offlineEntryContents:true,offlinePendingEntryContents:true,[flag]:false}});
 await api.getSyncCapabilities({replay:false});
 await expect(api.enqueueOfflinePendingEntryContents!(`local:${uid}`,[])).rejects.toThrow();
 expect(await store.list()).toHaveLength(1);
});
it('rejects UUID retargeting and suppresses a complete-list no-op',async()=>{
 const {api,store}=await setup();
 const options=await api.getPendingOfflineEntryContentOptions!(`local:${uid}`);
 await api.enqueueOfflinePendingEntryContents!(`local:${uid}`,options.contents);
 expect(await store.list()).toHaveLength(1);
 await expect(api.enqueueOfflinePendingEntryContents!(`local:${uid}`,options.contents.map(row=>({...row,syncUid:crypto.randomUUID()})))).rejects.toThrow();
 expect(await store.list()).toHaveLength(1);
});

