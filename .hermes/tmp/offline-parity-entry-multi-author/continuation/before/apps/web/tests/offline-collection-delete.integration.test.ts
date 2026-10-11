import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
import { preparePendingWork } from '../src/offline/pending-work-restore.js';
import { syncReplayRequestSchema, pendingWorkFileSchema } from '@t3/shared';
import { mutationQueuePlan, originalMutationEnvelope } from '../src/offline/sync-mutation-plan.js';
import { expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const window = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://isolated/' }).window;
  for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'localStorage', 'sessionStorage', 'MutationObserver', 'navigator', 'getComputedStyle']) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key as keyof typeof window], configurable: true });
  }
});
import CollectionsPage from '../src/CollectionsPage.vue';
import { setLocale } from '../src/i18n.js';
import { showNsfw } from '../src/stores/preferences.js';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';

const serverModule = async (path: string) => {
  const target = `../../server/src/${path}.js`;
  return import(/* @vite-ignore */ target);
};
async function fixture(install=true) {
  const { createMigratedMemoryDatabase } = await serverModule('database/testing');
  const { createApiApp } = await serverModule('http/app');
  const { createEntry } = await serverModule('repositories/entry-repository');
  const { createProducer, linkEntryProducer } = await serverModule('repositories/producer-repository');
  const { createSection } = await serverModule('repositories/layout-repository');
  const { createCollection, addCollectionEntry } = await serverModule('repositories/collection-repository');
  const db = createMigratedMemoryDatabase();
  const root = mkdtempSync(join(tmpdir(), 't3-collection-parity-'));
  const section = createSection(db, { entryType: 'Comic', name: 'Tags' });
  const work = createEntry(db, { title: 'Shared work', type: 'Comic' });
  const other = createEntry(db, { title: 'Child work', type: 'Comic' });
  const skipped = createEntry(db, { title: 'Unstructured work', type: 'Unstructured' });
  const author = createProducer(db, { name: 'Surviving Author' });
  linkEntryProducer(db, work.id, author.id);
  const parent = createCollection(db, { kind: 'entry', title: 'Shelf', galleryType: 'Comic' });
  const child = createCollection(db, { kind: 'entry', title: 'Child shelf', parentId: parent.id });
  const peer = createCollection(db, { kind: 'entry', title: 'Peer shelf', galleryType: 'Comic' });
  for (const folder of [parent, child, peer]) addCollectionEntry(db, folder.id, work.id);
  addCollectionEntry(db, child.id, other.id);
  addCollectionEntry(db, parent.id, skipped.id);
  addCollectionEntry(db, child.id, skipped.id);
  const app = createApiApp(db, { assetRoot: join(root, 'assets'), dataDir: root });
  const calls: string[] = [];
  let disconnected = false, loseReplay = false, loseAck = false;
  const bodies: string[] = [];
  const online = createGalleryApi(createApiClient({ baseUrl: 'http://isolated/api', fetchImplementation: async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (disconnected) throw new TypeError('Known offline');
    if (url.pathname === '/api/sync/replay') bodies.push(String(init?.body));
    const response = await app.request(url.pathname + url.search, init);
    if (loseReplay && url.pathname === '/api/sync/replay' && response.ok) {loseReplay=false;throw new TypeError('Replay response lost');}
    if (loseAck && url.pathname.includes('/ack') && response.ok) {loseAck=false;throw new TypeError('ACK response lost');}
    return response;
  } }));
  const indexedDB = new IDBFactory(), databaseName = randomUUID();
  let store = createIndexedDbOfflineStore({ indexedDB, databaseName });
  const api = createOfflineAwareGalleryApi(online, store, { clientId: 'collection-parity-phone', randomUUID });
  if (install) {await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');}
  await api.getSyncCapabilities({replay:false});
  return { db, section, work, other, skipped, author, parent, child, peer, online, api, calls, bodies, get store(){return store;},
    async removeMeta(key:string){const req=indexedDB.open(databaseName);const db=await new Promise<IDBDatabase>((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}finally{db.close();}},
    connect(){disconnected=false;}, loseReplay(){loseReplay=true;},loseAck(){loseAck=true;},
    cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'collection-parity-phone',randomUUID});},
    async offline() {
      await store.writeGeneration(1, JSON.stringify(await online.fetchSyncSnapshot()));
      await store.writeMeta('activeGeneration', '1');
      await api.getSyncCapabilities({ replay: false });
      await api.preferOfflineSnapshot!();
      disconnected = true;
      calls.length = 0;
    },
    close() { store.close(); db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
const settle = async () => { for (let i = 0; i < 20; i++) { await flushPromises(); await new Promise(resolve=>setTimeout(resolve,5)); } };

it('Collection delete actual double-confirm projects root and child cold, commits SQL, and retains exact originals across replay and ACK loss', async () => {
  const f=await fixture(); setLocale('en');showNsfw.value=true;vi.stubGlobal('scrollTo',vi.fn());
  let wrapper:ReturnType<typeof mount>|undefined;
  try {
    await f.online.addCollectionTag(f.parent.id,'Winter');await f.offline();
    wrapper=mount(CollectionsPage,{props:{api:f.api}});await settle();
    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');f.calls.length=0;
    await wrapper.get(`[data-testid="delete-collection-${f.parent.id}"]`).trigger('click');expect(await f.store.list()).toEqual([]);
    await wrapper.get(`[data-testid="delete-collection-${f.parent.id}"]`).trigger('click');await settle();
    expect(f.calls).toEqual([]);expect((await f.store.list()).map(row=>row.operationKind)).toEqual(['collection.delete']);
    wrapper.unmount();wrapper=undefined;
    const originals=(await f.store.list()).map(originalMutationEnvelope);const cold=f.cold();await cold.preferOfflineSnapshot!();
    expect((await cold.listCollections('entry',true)).map(row=>row.id)).toEqual([f.peer.id]);
    f.connect();f.loseReplay();await cold.flushOfflineOutbox!();
    expect(f.db.prepare('SELECT id FROM collections ORDER BY id').pluck().all()).toEqual([f.peer.id]);
    const retry=f.cold();f.loseAck();await retry.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);
    const final=f.cold();await final.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
    expect(f.bodies.filter(body=>JSON.parse(body).opId===originals[0]!.opId).length).toBeGreaterThanOrEqual(3);
    expect(new Set(f.bodies).size).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(3);
    expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM entry_producers').pluck().get()).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM entry_tags').pluck().get()).toBe(2);
    expect(f.db.prepare('SELECT collection_id,entry_id FROM collection_entries').all()).toEqual([{collection_id:f.peer.id,entry_id:f.work.id}]);
  } finally {wrapper?.unmount();f.close();vi.unstubAllGlobals();}
});

it.each(['no-copy','old-copy'] as const)('connected %s bounded identity deletes a new folder without snapshot prefetch or numeric DELETE',async mode=>{
 const f=await fixture(mode==='old-copy');try{
  const folder=await f.online.createCollection({kind:'entry',title:'New after copy',galleryType:'Comic'});f.calls.length=0;
  f.loseReplay();await f.api.deleteCollection(folder.id);const originals=(await f.store.list()).map(originalMutationEnvelope);expect(originals.length).toBe(1);
  const retry=f.cold();f.loseAck();await retry.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);await f.cold().flushOfflineOutbox!();expect(new Set(f.bodies).size).toBe(1);
  expect(f.calls[0]).toBe(`GET /api/collections/${folder.id}/sync-identity`);
  expect(f.calls).not.toContain(`DELETE /api/collections/${folder.id}`);
  expect(f.calls.indexOf('POST /api/sync/replay')).toBeGreaterThan(0);
  const snapshot=f.calls.indexOf('GET /api/sync/snapshot');expect(snapshot===-1 || snapshot>f.calls.indexOf('POST /api/sync/replay')).toBe(true);
  expect(f.db.prepare('SELECT id FROM collections WHERE id=?').get(folder.id)).toBeUndefined();expect(await f.store.list()).toEqual([]);
 }finally{f.close();}
});
it.each(['child','author','empty'] as const)('finite %s deletion preserves peers and subject rows',async kind=>{
 const f=await fixture();try{
  let id=f.child.id;
  if(kind!=='child') {const folder=await f.online.createCollection({kind:kind==='author'?'producer':'entry',title:kind,galleryType:kind==='author'?undefined:'Comic'});id=folder.id;if(kind==='author')await f.online.addCollectionProducer(id,f.author.id);}
  await f.offline();await f.api.deleteCollection(id);const cold=f.cold();await cold.preferOfflineSnapshot!();
  const records=await cold.listCollections(kind==='author'?'producer':'entry',true);expect(records.some(row=>row.id===id || row.children.some(child=>child.id===id))).toBe(false);
  f.connect();await cold.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT id FROM collections WHERE id=?').get(f.parent.id)).toBeDefined();expect(f.db.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(3);expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(1);
 }finally{f.close();}
});
it.each(['add','edit'] as const)('frozen direct-child scope rejects concurrent child %s and keeps the original queue',async kind=>{
 const f=await fixture();try{await f.offline();await f.api.deleteCollection(f.parent.id);const originals=(await f.store.list()).map(originalMutationEnvelope);
 if(kind==='add'){const {createCollection}=await serverModule('repositories/collection-repository');createCollection(f.db,{kind:'entry',title:'Concurrent',parentId:f.parent.id});}else f.db.prepare('UPDATE collections SET title=? WHERE id=?').run('Concurrent edit',f.child.id);
 f.connect();await f.api.flushOfflineOutbox!();expect(f.db.prepare('SELECT id FROM collections WHERE id=?').get(f.parent.id)).toBeDefined();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);expect((await f.store.list())[0]?.status).toBe('conflict');
 }finally{f.close();}
});
it('held child membership blocks root deletion while an independent Entry progresses, then exact originals settle',async()=>{
 const f=await fixture();try{await f.offline();await f.api.removeCollectionEntry(f.child.id,f.other.id);const predecessor=(await f.store.list())[0]!;await f.store.update(predecessor.opId,{status:'conflict'});
 await f.api.deleteCollection(f.parent.id);await f.api.updateEntry(f.work.id,{title:'Independent'});const originals=(await f.store.list()).map(originalMutationEnvelope);f.connect();await f.api.flushOfflineOutbox!();
 expect(f.db.prepare('SELECT id FROM collections WHERE id=?').get(f.parent.id)).toBeDefined();expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.work.id)).toBe('Independent');
 await f.store.update(predecessor.opId,{status:'pending'});f.loseAck();await f.api.flushOfflineOutbox!();const final=f.cold();await final.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
 for(const op of originals){const bodies=f.bodies.filter(body=>JSON.parse(body).opId===op.opId);expect(bodies.length).toBeGreaterThan(0);expect(new Set(bodies).size).toBe(1);}
 }finally{f.close();}
});
it.each(['offlineMutations','offlineCollectionManagement','offlineCollectionDelete'])('capability %s false and absent fail closed cold with unchanged original work',async flag=>{
 for(const absent of [false,true]){const f=await fixture();try{await f.offline();await f.api.updateEntry(f.work.id,{title:'Retained'});const before=JSON.stringify(await f.store.list());
 if(absent){const req=(f.store as unknown as {unused?:number});void req; // meta key is actually removed, not null-valued.
 const factory=(f as unknown as {removeMeta?:(key:string)=>Promise<void>});await factory.removeMeta!('capability.'+flag);
 }else await f.store.writeMeta('capability.'+flag,'0');
 const cold=f.cold();await cold.preferOfflineSnapshot!();f.calls.length=0;await expect(cold.deleteCollection(f.parent.id)).rejects.toThrow('not available under offline');expect(JSON.stringify(await f.store.list())).toBe(before);expect(f.calls).toEqual([]);
 }finally{f.close();}}
});
it('unknown legacy child identity is not a default empty scope and retains originals',async()=>{
 const f=await fixture();try{await f.offline();const snapshot=await f.online.fetchSyncSnapshot().catch(()=>undefined);void snapshot;
 const raw=await f.store.readGeneration(1);const value=JSON.parse(raw!);delete value.payload.collections.find((row:{id:number})=>row.id===f.child.id).syncUid;
 // A valid legacy snapshot must be checksummed with the real shared checksum helper.
 const {createHash}=await import('node:crypto');const {checksum,...header}=value.header;void checksum;value.header.checksum=createHash('sha256').update(JSON.stringify(header)+JSON.stringify(value.payload)).digest('hex');
 await f.store.writeGeneration(2,JSON.stringify(value));await f.store.writeMeta('activeGeneration','2');const cold=f.cold();await cold.preferOfflineSnapshot!();f.calls.length=0;
 await expect(cold.deleteCollection(f.parent.id)).rejects.toThrow('unknown child identity/scope');expect(await f.store.list()).toEqual([]);expect(f.calls).toEqual([]);
 }finally{f.close();}
});
it('attempted delete export/atomic restore retains metadata and rejects structurally valid later same-child writes',async()=>{
 const f=await fixture();try{await f.offline();await f.api.deleteCollection(f.parent.id);f.connect();f.loseReplay();await f.api.flushOfflineOutbox!();const saved=await f.store.list();expect(saved[0]?.lastAttemptAt).not.toBeNull();
 const text=JSON.stringify(await buildPendingWorkExport(f.store));await preparePendingWork(text);await f.store.removeMany(saved.map(row=>row.opId));const cold=f.cold();await cold.restorePendingWork!(text);expect(await f.store.list()).toEqual(saved);
 const value=JSON.parse(text);const original=value.operations[0];const later={...original,opId:randomUUID(),entityUid:original.baseValues.children[0].syncUid,operationKind:'collection.update',baseVersion:original.baseValues.children[0].syncVersion+1,clientCreatedAt:new Date(Date.parse(original.clientCreatedAt)+1000).toISOString(),baseValues:{title:'Child shelf'},payload:{title:'Invalid later write'},status:'pending',lastAttemptAt:null,lastError:null};
 const {status,lastAttemptAt,lastError,...envelope}=later;void status;void lastAttemptAt;void lastError;expect(syncReplayRequestSchema.safeParse(envelope).success).toBe(true);value.operations.push(later);expect(pendingWorkFileSchema.safeParse(value).success).toBe(true);await preparePendingWork(JSON.stringify(value));const before=JSON.stringify(await f.store.list());await expect(cold.restorePendingWork!(JSON.stringify(value))).rejects.toThrow('deleted Collection child');expect(JSON.stringify(await f.store.list())).toBe(before);
 f.loseAck();await cold.flushOfflineOutbox!();const final=f.cold();await final.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);expect(new Set(f.bodies).size).toBe(1);
 }finally{f.close();}
});
it.each(['fingerprint','foreign-child'] as const)('corrupt %s foreground proof after actual ACK loss cannot authorize cleanup',async corrupt=>{
 const f=await fixture();try{await f.offline();await f.api.deleteCollection(f.parent.id);const original=(await f.store.list())[0]!;f.connect();f.loseAck();await f.api.flushOfflineOutbox!();expect((await f.store.list()).length).toBe(1);
 const key='collectionDeleteProof.'+original.opId;const proof=JSON.parse((await f.store.readMeta(key))!);if(corrupt==='fingerprint')proof.fingerprint='foreign';else proof.receipt.collectionDeleteJournal[1].id=f.peer.id;await f.store.writeMeta(key,JSON.stringify(proof));
 const cold=f.cold();const remove=vi.spyOn(f.store,'removeMany');await cold.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual([originalMutationEnvelope(original)]);expect(remove).not.toHaveBeenCalled();expect(f.calls.some(call=>call==='GET /api/sync/changes')).toBe(true);remove.mockRestore();
 }finally{f.close();}
});

it('held complete Collection order is a root-delete predecessor, not absence authority',async()=>{
 const f=await fixture();try{await f.offline();await f.api.reorderCollections('entry',[f.peer.id,f.parent.id]);const order=(await f.store.list())[0]!;await f.store.update(order.opId,{status:'conflict'});await f.api.deleteCollection(f.parent.id);const pending=await f.store.list();expect(mutationQueuePlan(pending).get(pending[1]!.opId)?.dependencies).toContain(order.opId);f.connect();await f.api.flushOfflineOutbox!();
 expect(f.bodies.some(body=>JSON.parse(body).operationKind==='collection.delete')).toBe(false);expect(f.db.prepare('SELECT id FROM collections WHERE id=?').get(f.parent.id)).toBeDefined();
 await f.store.update(order.opId,{status:'pending'});await f.api.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
 }finally{f.close();}
});

it.each(['offlineMutations','offlineCollectionManagement','offlineCollectionDelete'])('original queued Collection delete requires explicit current %s after a cold downgrade',async flag=>{
 for(const absent of [false,true]){const f=await fixture();try{await f.offline();await f.api.deleteCollection(f.parent.id);const originals=(await f.store.list()).map(originalMutationEnvelope);if(absent)await f.removeMeta('capability.'+flag);else await f.store.writeMeta('capability.'+flag,'0');const cold=f.cold();f.connect();await cold.flushOfflineOutbox!();expect(f.bodies).toEqual([]);expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);expect(f.db.prepare('SELECT id FROM collections WHERE id=?').get(f.parent.id)).toBeDefined();}finally{f.close();}}
});
it('canonical scope is strict and only the exact UUID receipt proves an absent Collection',async()=>{
 const f=await fixture();try{await f.offline();await f.api.deleteCollection(f.parent.id);const original=originalMutationEnvelope((await f.store.list())[0]!);expect(syncReplayRequestSchema.safeParse({...original,baseValues:{kind:'entry',parentUid:null}}).success).toBe(false);
 if(original.operationKind!=='collection.delete')throw new Error('fixture');expect(syncReplayRequestSchema.safeParse({...original,baseValues:{...original.baseValues,children:[...original.baseValues.children,...original.baseValues.children]}}).success).toBe(false);
 f.connect();const applied=await f.online.replaySyncOperation!(original);expect(applied.status).toBe('applied');expect(await f.online.replaySyncOperation!(original)).toEqual(applied);expect(await f.online.replaySyncOperation!({...original,opId:randomUUID()})).toMatchObject({status:'failed',errorCode:'entity-not-found'});expect(await f.online.replaySyncOperation!({...original,baseVersion:original.baseVersion+1})).toMatchObject({status:'failed',errorCode:'operation-id-collision'});
 }finally{f.close();}
});

it('origin local root double-confirm deletes offline and settles actual SQL response and ACK loss with exact cold originals',async()=>{
 const f=await fixture();setLocale('en');showNsfw.value=true;vi.stubGlobal('scrollTo',vi.fn());let wrapper:ReturnType<typeof mount>|undefined;
 try{await f.offline();const root=await f.api.createCollection({kind:'entry',title:'Local origin',galleryType:'Comic'});expect(root.id).toBeLessThan(0);
 wrapper=mount(CollectionsPage,{props:{api:f.api}});await settle();await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');f.calls.length=0;
 await wrapper.get(`[data-testid="delete-collection-${root.id}"]`).trigger('click');expect((await f.store.list()).length).toBe(1);
 await wrapper.get(`[data-testid="delete-collection-${root.id}"]`).trigger('click');await settle();
 expect((await f.store.list()).map(row=>row.operationKind)).toEqual(['collection.create','collection.delete']);expect(f.calls).toEqual([]);
 wrapper.unmount();wrapper=undefined;const originals=(await f.store.list()).map(originalMutationEnvelope);const cold=f.cold();await cold.preferOfflineSnapshot!();expect((await cold.listCollections('entry',true)).some(row=>row.id===root.id)).toBe(false);
 f.connect();f.loseReplay();await cold.flushOfflineOutbox!();expect(f.db.prepare('SELECT count(*) FROM collections WHERE title=?').pluck().get('Local origin')).toBe(1);
 f.loseAck();await f.cold().flushOfflineOutbox!();expect(f.db.prepare('SELECT count(*) FROM collections WHERE title=?').pluck().get('Local origin')).toBe(0);expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);
 await f.cold().flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
 for(const op of originals){const bodies=f.bodies.filter(body=>JSON.parse(body).opId===op.opId);expect(bodies.length).toBeGreaterThan(1);expect(new Set(bodies).size).toBe(1);}
 }finally{wrapper?.unmount();f.close();vi.unstubAllGlobals();}
});

it('origin existing root freezes pending child identity and held create blocks deletion before exact SQL settlement',async()=>{
 const f=await fixture();try{await f.offline();const child=await f.api.createCollection({kind:'entry',title:'Local child',parentId:f.parent.id});const create=(await f.store.list())[0]!;await f.store.update(create.opId,{status:'conflict'});await f.api.deleteCollection(f.parent.id);const rows=await f.store.list();const deletion=originalMutationEnvelope(rows[1]!);if(deletion.operationKind!=='collection.delete')throw new Error('fixture');expect(deletion.baseValues.children).toContainEqual({syncUid:create.entityUid,syncVersion:1});expect(mutationQueuePlan(rows).get(deletion.opId)?.dependencies).toContain(create.opId);f.connect();await f.cold().flushOfflineOutbox!();expect(f.bodies).toEqual([]);expect(f.db.prepare('SELECT id FROM collections WHERE id=?').get(f.parent.id)).toBeDefined();await f.store.update(create.opId,{status:'pending'});f.loseAck();await f.cold().flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(rows.map(originalMutationEnvelope));await f.cold().flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);expect(f.db.prepare('SELECT id FROM collections WHERE title=?').get('Local child')).toBeUndefined();expect(child.id).toBeLessThan(0);
 }finally{f.close();}
});
it('origin local root and child cold delete survives actual SQL response and ACK loss without cascading subjects or peer tags',async()=>{
 const f=await fixture();try{await f.online.addCollectionTag(f.parent.id,'Winter');await f.online.addCollectionTag(f.peer.id,'Winter');await f.offline();const root=await f.api.createCollection({kind:'entry',title:'Origin cascade',galleryType:'Comic'});const child=await f.api.createCollection({kind:'entry',title:'Origin child',parentId:root.id});const creates=await f.store.list();await f.api.deleteCollection(root.id);const originals=(await f.store.list()).map(originalMutationEnvelope);const deletion=originals[2]!;if(deletion.operationKind!=='collection.delete')throw new Error('fixture');expect(deletion.entityUid).toBe(creates[0]!.entityUid);expect(deletion.baseVersion).toBe(1);expect(deletion.baseValues.children).toEqual([{syncUid:creates[1]!.entityUid,syncVersion:1}]);const cold=f.cold();await cold.preferOfflineSnapshot!();expect((await cold.listCollections('entry',true)).some(row=>row.id===root.id || row.children.some(c=>c.id===child.id))).toBe(false);f.connect();f.loseReplay();await cold.flushOfflineOutbox!();expect(f.db.prepare('SELECT count(*) FROM collections WHERE title=?').pluck().get('Origin cascade')).toBe(1);f.loseAck();await f.cold().flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);expect(f.db.prepare('SELECT count(*) FROM collections WHERE title LIKE ?').pluck().get('Origin %')).toBe(0);await f.cold().flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);for(const op of originals){const bodies=f.bodies.filter(body=>JSON.parse(body).opId===op.opId);expect(new Set(bodies).size).toBe(1);expect(bodies.length).toBeGreaterThan(1);}expect(f.db.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(3);expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(1);expect(f.db.prepare('SELECT count(*) FROM entry_producers').pluck().get()).toBe(1);expect(f.db.prepare('SELECT count(*) FROM entry_tags').pluck().get()).toBe(2);expect(f.db.prepare('SELECT count(*) FROM collection_entries WHERE collection_id=?').pluck().get(f.peer.id)).toBe(1);
 }finally{f.close();}
});
it('origin attempted create delete export restores atomically with original metadata and rejects a schema-valid deleted-child write',async()=>{
 const f=await fixture();try{await f.offline();const root=await f.api.createCollection({kind:'entry',title:'Restored origin',galleryType:'Comic'});await f.api.createCollection({kind:'entry',title:'Restored child',parentId:root.id});await f.api.deleteCollection(root.id);f.connect();f.loseReplay();await f.api.flushOfflineOutbox!();const saved=await f.store.list();expect(saved[0]!.lastAttemptAt).not.toBeNull();const text=JSON.stringify(await buildPendingWorkExport(f.store));await preparePendingWork(text);await f.store.removeMany(saved.map(row=>row.opId));const cold=f.cold();await cold.restorePendingWork!(text);expect(await f.store.list()).toEqual(saved);const value=JSON.parse(text);const deletion=value.operations[2];const later={...deletion,opId:randomUUID(),entityUid:deletion.baseValues.children[0].syncUid,operationKind:'collection.update',baseVersion:2,clientCreatedAt:new Date(Date.parse(deletion.clientCreatedAt)+1000).toISOString(),baseValues:{title:'Restored child'},payload:{title:'Invalid later'},status:'pending',lastAttemptAt:null,lastError:null};const {status,lastAttemptAt,lastError,...envelope}=later;void status;void lastAttemptAt;void lastError;expect(syncReplayRequestSchema.safeParse(envelope).success).toBe(true);value.operations.push(later);expect(pendingWorkFileSchema.safeParse(value).success).toBe(true);await preparePendingWork(JSON.stringify(value));await expect(cold.restorePendingWork!(JSON.stringify(value))).rejects.toThrow('deleted Collection child');expect(await f.store.list()).toEqual(saved);const replay=f.online.replaySyncOperation!.bind(f.online);const target=f.online as typeof f.online & {replaySyncOperation:NonNullable<typeof f.online.replaySyncOperation>};const corrupt=vi.spyOn(target,'replaySyncOperation').mockImplementation(async operation=>{const result=await replay(operation);return operation.operationKind==='collection.create' && result.status==='applied'?{...result,entityId:f.peer.id}:result;});f.calls.length=0;await cold.flushOfflineOutbox!();corrupt.mockRestore();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(saved.map(originalMutationEnvelope));expect(f.calls.some(call=>call.includes('/ack'))).toBe(false);f.loseAck();await cold.flushOfflineOutbox!();const attempted=await f.store.list();expect(attempted.every(row=>row.lastAttemptAt!==null)).toBe(true);const afterAck=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany(attempted.map(row=>row.opId));const final=f.cold();await final.restorePendingWork!(afterAck);expect(await f.store.list()).toEqual(attempted);await final.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);for(const op of saved){expect(new Set(f.bodies.filter(body=>JSON.parse(body).opId===op.opId)).size).toBe(1);}
 }finally{f.close();}
});
