// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { GalleryApi } from '../src/api/gallery.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createMemorySnapshotStore, ACTIVE_GENERATION_KEY } from '../src/offline/snapshot-store.js';
import { createMemoryOutboxStore, createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';
const clientId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const uid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function setup() {
  const snapshot = offlineSnapshot();
  snapshot.payload.tagGroups = [
    {id:2,entryType:'game',name:'Genre',groupKind:'section',parentId:null,sortOrder:0},
    {id:1,entryType:'game',name:'Main',groupKind:'facet',parentId:2,sortOrder:0},
    {id:3,entryType:'game',name:'Theme',groupKind:'facet',parentId:2,sortOrder:1},
  ];
  const store = {...createMemorySnapshotStore(), ...createMemoryOutboxStore()};
  await store.writeGeneration(1, JSON.stringify(snapshot));
  await store.writeMeta(ACTIVE_GENERATION_KEY,'1');
  const parent = createPendingSyncOperation({clientId,libraryId:'library-1',syncEpoch:'epoch-1',entityKind:'entry',entityUid:uid,operationKind:'entry.create',baseVersion:0,baseValues:{},payload:{title:'New',type:'game',uploadDate:null,pageCount:null,ratings:[],viewLater:false}});
  await store.enqueue(parent);
  const online = {getSyncCapabilities:vi.fn().mockResolvedValue({featureFlags:{offlineMutations:true,offlineEntryTags:true,offlinePendingEntryTags:true}})} as unknown as GalleryApi;
  const state = {mode:'offline' as 'offline'|'online',lastFallbackAt:null,lastReplayError:null as string|null};
  const api = createOfflineAwareGalleryApi(online,store,{clientId,state});
  await api.getSyncCapabilities({replay:false});
  return {api,store,parent,online,snapshot,state};
}
it('projects stable Facet dependencies into local IDs without changing immutable transport identities', async () => {
  const { api, store, parent } = await setup();
  const tagUid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const facetUid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const sectionUid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const active = offlineSnapshot();
  active.payload.tagGroups = [
    { id: 2, syncUid: sectionUid, entryType: 'game', name: 'Genre', groupKind: 'section', parentId: null, sortOrder: 0 },
  ];
  await store.writeGeneration(2, JSON.stringify(active));
  await store.writeMeta(ACTIVE_GENERATION_KEY, '2');
  const tagCreate = createPendingSyncOperation({ clientId, libraryId: parent.libraryId, syncEpoch: parent.syncEpoch,
    entityKind: 'entry_tag', entityUid: tagUid, operationKind: 'entry.tag.create', baseVersion: 0,
    baseValues: {}, payload: { name: 'School Life' } });
  const facetCreate = createPendingSyncOperation({ clientId, libraryId: parent.libraryId, syncEpoch: parent.syncEpoch,
    entityKind: 'entry_facet', entityUid: facetUid, operationKind: 'entry.facet.create', baseVersion: 1,
    baseValues: { entryType: 'game', sectionUid }, payload: { entryType: 'game', sectionUid, name: 'Theme' } });
  await store.enqueue(tagCreate); await store.enqueue(facetCreate);
  const child = createPendingSyncOperation({ clientId, libraryId: parent.libraryId, syncEpoch: parent.syncEpoch,
    entityKind: 'entry', entityUid: uid, operationKind: 'entry.tags.set', baseVersion: 0,
    baseValues: { tags: [] }, payload: { parentCreateOpId: parent.opId,
      tags: [{ name: 'School Life', tagUid, facetUid }],
      tagCreates: [{ tagUid, createOpId: tagCreate.opId }], facetCreates: [{ facetUid, createOpId: facetCreate.opId }] } });
  await store.enqueue(child);
  const before = await store.list();
  const options = await api.getPendingOfflineEntryTagOptions!(`local:${uid}`);
  const facet = options.facets.find(row => row.name === 'Theme');
  expect(facet?.id).toBeLessThan(0);
  expect(options.tags).toEqual([{ name: 'School Life', facetId: facet?.id }]);
  expect(options.availableTags).toContainEqual({ id: expect.any(Number), name: 'School Life' });
  expect(await store.list()).toEqual(before);
  const restarted = createOfflineAwareGalleryApi({} as GalleryApi, store, { clientId });
  expect(await restarted.getPendingOfflineEntryTagOptions!(`local:${uid}`)).toEqual(options);
});

it('retains stable Tag and Facet dependencies when removing a staged assignment', async () => {
  const { api, store, parent, snapshot } = await setup();
  const tagUid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const facetUid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const sectionUid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  snapshot.payload.tagGroups.find(row => row.id === 2)!.syncUid = sectionUid;
  await store.writeGeneration(2, JSON.stringify(snapshot)); await store.writeMeta(ACTIVE_GENERATION_KEY, '2');
  const tagCreate = createPendingSyncOperation({ clientId, libraryId: parent.libraryId, syncEpoch: parent.syncEpoch,
    entityKind: 'entry_tag', entityUid: tagUid, operationKind: 'entry.tag.create', baseVersion: 0, baseValues: {}, payload: { name: 'School Life' } });
  const facetCreate = createPendingSyncOperation({ clientId, libraryId: parent.libraryId, syncEpoch: parent.syncEpoch,
    entityKind: 'entry_facet', entityUid: facetUid, operationKind: 'entry.facet.create', baseVersion: 1,
    baseValues: { entryType: 'game', sectionUid }, payload: { entryType: 'game', sectionUid, name: 'Theme' } });
  await store.enqueue(tagCreate); await store.enqueue(facetCreate);
  const assignment = createPendingSyncOperation({ clientId, libraryId: parent.libraryId, syncEpoch: parent.syncEpoch,
    entityKind: 'entry', entityUid: uid, operationKind: 'entry.tags.set', baseVersion: 0, baseValues: { tags: [] },
    payload: { parentCreateOpId: parent.opId, tags: [{ name: 'School Life', tagUid, facetUid }],
      tagCreates: [{ tagUid, createOpId: tagCreate.opId }], facetCreates: [{ facetUid, createOpId: facetCreate.opId }] } });
  await store.enqueue(assignment);
  await api.enqueueOfflinePendingEntryTags!(`local:${uid}`, []);
  const removed = (await store.list()).at(-1)!;
  expect(removed.baseValues).toEqual({ tags: [{ name: 'School Life', tagUid, facetUid }] });
  expect(removed.payload).toEqual({ parentCreateOpId: parent.opId, tags: [],
    tagCreates: [{ tagUid, createOpId: tagCreate.opId }], facetCreates: [{ facetUid, createOpId: facetCreate.opId }] });
  expect((await api.getPendingOfflineEntryTagOptions!(`local:${uid}`)).tags).toEqual([]);
});

it('reports the pending Tag write as saved when only the post-commit status refresh fails', async () => {
  const { api, store, state } = await setup();
  const list = store.list.bind(store);
  const enqueue = store.enqueue.bind(store);
  let committed = false;
  vi.spyOn(store, 'enqueue').mockImplementation(async (operation) => {
    const result = await enqueue(operation); committed = true; return result;
  });
  vi.spyOn(store, 'list').mockImplementation(async () => {
    if (committed) { committed = false; throw new Error('pending status read failed'); }
    return list();
  });
  state.mode = 'online';
  await expect(api.enqueueOfflinePendingEntryTags!(`local:${uid}`, [{ name: 'RPG', facetId: 1 }])).resolves.toBeUndefined();
  expect((await list()).filter(row => row.operationKind === 'entry.tags.set')).toHaveLength(1);
  expect(state.mode).toBe('offline');
  expect(state.lastReplayError).toContain('status');
});

it.each(['failed', 'conflict'] as const)('blocks Content writes behind a %s pending Tag operation', async (status) => {
  const { api, store } = await setup();
  await store.writeMeta('capability.offlineEntryContentAppend', '1');
  await api.enqueueOfflinePendingEntryTags!(`local:${uid}`, [{ name: 'RPG', facetId: 1 }]);
  const tag = (await store.list())[1]!;
  await store.update(tag.opId, { status, lastError: 'Tag edit needs review' });
  const before = await store.list();
  await expect(api.enqueueOfflinePendingEntryContent!(`local:${uid}`, { contentType: 'Notes', content: 'later' })).rejects.toThrow(/blocked/i);
  expect((await api.listPendingOfflineEntryCreates!())[0]?.canAppendContent).toBe(false);
  expect(await store.list()).toEqual(before);
});

it.each(['offlineMutations', 'offlineEntryTags', 'offlinePendingEntryTags'] as const)('refuses pending Tags when %s capability is false', async (flag) => {
  const { api, store, online } = await setup();
  const capabilities = await online.getSyncCapabilities();
  vi.spyOn(online, 'getSyncCapabilities').mockResolvedValue({ ...capabilities,
    featureFlags: { ...capabilities.featureFlags, [flag]: false } });
  await api.getSyncCapabilities({ replay: false });
  const before = await store.list();
  expect(await store.readMeta('capability.offlinePendingEntryTags')).toBe('0');
  await expect(api.getPendingOfflineEntryTagOptions!(`local:${uid}`)).rejects.toThrow(/supported/i);
  await expect(api.enqueueOfflinePendingEntryTags!(`local:${uid}`, [{ name: 'RPG', facetId: 1 }])).rejects.toThrow(/supported/i);
  expect(await store.list()).toEqual(before);
});

it.each(['clientId', 'libraryId', 'syncEpoch'] as const)('does not retarget a pending parent with a different %s', async (field) => {
  const { api, store, parent } = await setup();
  await store.removeMany([parent.opId]);
  await store.enqueue({ ...parent, [field]: 'different-identity' });
  const before = await store.list();
  await expect(api.getPendingOfflineEntryTagOptions!(`local:${uid}`)).rejects.toThrow(/not found/i);
  await expect(api.enqueueOfflinePendingEntryTags!(`local:${uid}`, [{ name: 'RPG', facetId: 1 }])).rejects.toThrow(/not found/i);
  expect(await store.list()).toEqual(before);
});

it('uses the authoritative owner Tags after earlier applied edits have been cleared but the create is still retained', async () => {
  const { api, store, snapshot } = await setup();
  const covered = structuredClone(snapshot);
  covered.header.snapshotSeq = 2;
  covered.payload.entries.push({ ...covered.payload.entries[0]!, id: 12, syncUid: uid });
  covered.payload.entryTags.push({ entryId: 12, tagId: 10, facetId: 1 });
  covered.header.counts.entries = covered.payload.entries.length;
  covered.header.counts.entryTags = covered.payload.entryTags.length;
  await store.writeGeneration(2, JSON.stringify(covered));
  await store.writeMeta(ACTIVE_GENERATION_KEY, '2');
  expect((await api.getPendingOfflineEntryTagOptions!(`local:${uid}`)).tags).toEqual([{ name: 'RPG', facetId: 1 }]);
  const projected = (await api.listPendingOfflineEntryCreates!())[0]!;
  expect(projected.tags).toEqual([{ name: 'RPG', facetId: 1 }]);
  expect(projected.tagEditStatus).toBeUndefined();
  await api.enqueueOfflinePendingEntryTags!(`local:${uid}`, [{ name: 'RPG', facetId: 3 }]);
  expect((await store.list())[1]?.baseValues).toEqual({ tags: [{ name: 'RPG', facetId: 1 }] });
});

it('labels unnamed cached Facets by their owning Section so a move target is identifiable', async () => {
  const { api, store, snapshot } = await setup();
  snapshot.payload.tagGroups.find(row => row.id === 1)!.name = '';
  const other = snapshot.payload.tagGroups.find(row => row.id === 3)!;
  other.name = ''; other.parentId = 4;
  snapshot.payload.tagGroups.push({ id: 4, entryType: 'game', name: 'Other', groupKind: 'section', parentId: null, sortOrder: 1 });
  await store.writeGeneration(2, JSON.stringify(snapshot));
  await store.writeMeta(ACTIVE_GENERATION_KEY, '2');
  expect((await api.getPendingOfflineEntryTagOptions!(`local:${uid}`)).facets).toEqual([
    { id: 1, name: 'Genre' }, { id: 3, name: 'Other' },
  ]);
});

it('queues immutable add move remove sets and projects them after restart',async()=>{
  const {api,store,parent}=await setup();
  const key=`local:${uid}`;
  expect(await api.getPendingOfflineEntryTagOptions!(key)).toEqual({facets:[{id:1,name:'Main'},{id:3,name:'Theme'}],tags:[],availableTags:[{id:10,name:'RPG'}]});
  await expect(api.enqueueOfflinePendingEntryTags!(key,[{name:'Unknown',facetId:1}])).rejects.toThrow();
  await expect(api.enqueueOfflinePendingEntryTags!(key,[{name:'RPG',facetId:2}])).rejects.toThrow();
  await api.enqueueOfflinePendingEntryTags!(key,[{name:' rpg ',facetId:1}]);
  await api.enqueueOfflinePendingEntryTags!(key,[{name:'RPG',facetId:1}]);
  await api.enqueueOfflinePendingEntryTags!(key,[{name:'RPG',facetId:3}]);
  const restarted=createOfflineAwareGalleryApi({} as GalleryApi,store,{clientId});
  expect((await restarted.listPendingOfflineEntryCreates!())[0]).toMatchObject({canEditTags:true,tags:[{name:'RPG',facetId:3}],tagEditStatus:'pending',tagEditError:null});
  await restarted.enqueueOfflinePendingEntryTags!(key,[]);
  const rows=await store.list();
  expect(rows[0]).toEqual(parent);
  expect(rows.slice(1).map(row=>[row.baseVersion,row.baseValues,row.payload])).toEqual([
    [0,{tags:[]},{parentCreateOpId:parent.opId,tags:[{name:'RPG',facetId:1}]}],
    [0,{tags:[{name:'RPG',facetId:1}]},{parentCreateOpId:parent.opId,tags:[{name:'RPG',facetId:3}]}],
    [0,{tags:[{name:'RPG',facetId:3}]},{parentCreateOpId:parent.opId,tags:[]}],
  ]);
  await store.update(rows[2]!.opId,{status:'conflict',lastError:'review'});
  expect((await restarted.listPendingOfflineEntryCreates!())[0]).toMatchObject({canEditTags:false});
  await expect(restarted.enqueueOfflinePendingEntryTags!(key,[])).rejects.toThrow('blocked');
});
it('holds downgraded children and verifies the final applied desired set before snapshot cleanup',async()=>{
  const {api,store,online,snapshot,parent,state}=await setup();
  await api.enqueueOfflinePendingEntryTags!(`local:${uid}`,[{name:'RPG',facetId:1}]);
  await api.enqueueOfflinePendingEntryTags!(`local:${uid}`,[{name:'RPG',facetId:3}]);
  await api.enqueueOfflinePendingEntryTags!(`local:${uid}`,[]);
  const replay=vi.fn().mockImplementation(async(op)=>({status:'applied',opId:op.opId,serverSeq:10,entityId:12}));
  online.replaySyncOperation=replay;
  const covering=structuredClone(snapshot);
  covering.header.snapshotSeq=2;covering.header.changeSeq=10;
  covering.payload.entries.push({...covering.payload.entries[0]!,id:12,syncUid:uid});
  covering.payload.entryTags.push({entryId:12,tagId:10,facetId:1});
  const stamp=async()=>{
    covering.header.counts.entries=covering.payload.entries.length;
    covering.header.counts.entryTags=covering.payload.entryTags.length;
    const {checksum,...header}=covering.header;void checksum;
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(header)+JSON.stringify(covering.payload)));
    covering.header.checksum=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
  };
  online.fetchSyncSnapshot=vi.fn().mockImplementation(async()=>{await stamp();return covering;});
  await store.writeMeta('capability.offlinePendingEntryTags','0');
  await api.flushOfflineOutbox!();
  expect(replay.mock.calls.map(([op])=>op.opId)).toEqual([parent.opId]);
  expect(await store.list()).toHaveLength(4);
  await store.writeMeta('capability.offlinePendingEntryTags','1');
  replay.mockClear();await api.flushOfflineOutbox!();
  expect(replay.mock.calls.map(([op])=>op.operationKind)).toEqual(['entry.create','entry.tags.set','entry.tags.set','entry.tags.set']);
  expect(await store.list()).toHaveLength(4);
  covering.header.snapshotSeq=3;
  covering.payload.entryTags=covering.payload.entryTags.filter(row=>row.entryId!==12);
  await api.flushOfflineOutbox!();
  expect(state.lastReplayError).toBeNull();
  expect(await store.list()).toHaveLength(0);
});
it('retains the pending editor when a new Tag child is queued during snapshot refresh', async () => {
  const { api, store, online, snapshot, parent } = await setup();
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  online.replaySyncOperation = vi.fn().mockImplementation(async op => ({ status: 'applied', opId: op.opId, serverSeq: 10, entityId: 12 }));
  online.fetchSyncSnapshot = vi.fn().mockImplementation(async () => {
    entered(); await gate;
    const covering = structuredClone(snapshot);
    covering.header.snapshotSeq = 2; covering.header.changeSeq = 10;
    covering.payload.entries.push({ ...covering.payload.entries[0]!, id: 12, syncUid: uid });
    covering.header.counts.entries = covering.payload.entries.length;
    const { checksum, ...header } = covering.header; void checksum;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(header) + JSON.stringify(covering.payload)));
    covering.header.checksum = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
    return covering;
  });
  const flushing = api.flushOfflineOutbox!();
  await waiting;
  await api.enqueueOfflinePendingEntryTags!(`local:${uid}`, [{ name: 'RPG', facetId: 1 }]);
  release(); await flushing;
  expect((await store.list()).map(row => row.operationKind)).toEqual(['entry.create', 'entry.tags.set']);
  expect((await store.list())[0]?.opId).toBe(parent.opId);
  expect((await api.listPendingOfflineEntryCreates!())[0]).toMatchObject({ canEditTags: true, tags: [{ name: 'RPG', facetId: 1 }] });
  await expect(api.getPendingOfflineEntryTagOptions!(`local:${uid}`)).resolves.toMatchObject({ tags: [{ name: 'RPG', facetId: 1 }] });
});

it('persists the conjunctive pending-tag capability and rejects malformed or missing parents',async()=>{
  const {api,store}=await setup();
  expect(await store.readMeta('capability.offlinePendingEntryTags')).toBe('1');
  for(const key of ['local:garbage',`local:${clientId}`,'1']) {
    await expect(api.getPendingOfflineEntryTagOptions!(key)).rejects.toThrow();
    await expect(api.enqueueOfflinePendingEntryTags!(key,[])).rejects.toThrow();
  }
});
