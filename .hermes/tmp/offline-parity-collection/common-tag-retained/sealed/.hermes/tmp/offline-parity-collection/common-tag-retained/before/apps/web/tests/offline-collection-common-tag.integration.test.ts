import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
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
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
import { operationFingerprint } from '../src/offline/outbox-store.js';
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
async function fixture() {
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
  let disconnected = false;
  let loseReplay=false,loseAck=false;const bodies:string[]=[];
  const online = createGalleryApi(createApiClient({ baseUrl: 'http://isolated/api', fetchImplementation: async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (disconnected) throw new TypeError('Known offline');
    if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));
    const response=await app.request(url.pathname + url.search, init);
    if(loseReplay && url.pathname==='/api/sync/replay' && response.ok){loseReplay=false;throw new TypeError('Lost SQL response');}
    if(loseAck && url.pathname.includes('/ack') && response.ok){loseAck=false;throw new TypeError('Lost ACK response');}
    return response;
  } }));
  const indexedDB=new IDBFactory(),databaseName=randomUUID();
  let store = createIndexedDbOfflineStore({ indexedDB, databaseName });
  const api = createOfflineAwareGalleryApi(online, store, { clientId: 'collection-parity-phone', randomUUID });
  return { db, section, work, other, skipped, author, parent, child, peer, online, api, calls, bodies, get store(){return store;},
    reconnect(){disconnected=false;},loseResponse(){loseReplay=true;},loseAcknowledgement(){loseAck=true;},
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

// Finite class 1 tracer: real ordinary caller, not a facade-only rejection test.
it('ordinary common-tag offline caller atomically tags unique current/direct-child Works without business HTTP', async () => {
  const f = await fixture();
  setLocale('en'); showNsfw.value = true;
  vi.stubGlobal('scrollTo', vi.fn());
  await f.offline();
  const wrapper = mount(CollectionsPage, { props: { api: f.api } });
  try {
    await settle();
    await wrapper.get(`[data-collection-id="${f.parent.id}"]`).trigger('click');
    await settle();
    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');
    await wrapper.get('[data-testid="collection-common-tag-toggle"]').trigger('click');
    await wrapper.get('[data-testid="collection-common-tag-input"]').setValue('  Winter  ');
    await wrapper.get('[data-testid="collection-common-tag-form"]').trigger('submit');
    await settle();
    expect(f.calls).toEqual([]);
    expect(wrapper.get('[data-testid="collection-common-tag-result"]').text()).toBe('Tagged 2 works (0 already had it, 1 skipped).');
    const rows = await f.store.list();
    expect(rows).toHaveLength(1);
    // Durable staging is local intent only; real SQL has not yet been replayed.
    expect(f.db.prepare('SELECT count(*) FROM entry_tags').pluck().get()).toBe(0);
    const first = await f.api.getEntry(f.work.id);
    const second = await f.api.getEntry(f.other.id);
    expect(JSON.stringify(first)).toContain('Winter');
    expect(JSON.stringify(second)).toContain('Winter');
  } finally { wrapper.unmount(); f.close(); vi.unstubAllGlobals(); }
});

// Prerequisite evidence only: existing per-Entry envelopes cannot replace atomic bulk replay.
// This first-GREEN test is not an implemented common-tag matrix cell.
it('prerequisite existing Entry inline-tag replay commits one owner before a second-owner conflict', async () => {
  const f = await fixture();
  try {
    const identity = await f.online.getSyncCapabilities();
    const facetId = Number(f.db.prepare("SELECT id FROM tag_groups WHERE entry_type='Comic' AND group_kind='facet' AND name='' ORDER BY id LIMIT 1").pluck().get());
    const operation = (entryId: number, offset = 0) => {
      const row = f.db.prepare('SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM entries WHERE id=?').get(entryId) as {syncUid:string;syncVersion:number};
      return {opId:randomUUID(),clientId:'collection-parity-phone',libraryId:identity.libraryId,syncEpoch:identity.syncEpoch,
        entityKind:'entry' as const,entityUid:row.syncUid,operationKind:'entry.tags.set' as const,
        baseVersion:row.syncVersion+offset,baseValues:{tags:[]},payload:{tags:[{name:'Winter',facetId}]},clientCreatedAt:new Date().toISOString()};
    };
    const first = operation(f.work.id);
    const second = operation(f.other.id, 1);
    expect(await f.online.replaySyncOperation!(first)).toMatchObject({opId:first.opId,status:'applied'});
    expect(await f.online.replaySyncOperation!(second)).toMatchObject({opId:second.opId,status:'conflict'});
    expect(f.db.prepare('SELECT entry_id AS entryId FROM entry_tags ORDER BY entry_id').all()).toEqual([{entryId:f.work.id}]);
    expect(f.db.prepare('SELECT count(*) FROM sync_operation_receipts WHERE op_id IN (?,?)').pluck().get(first.opId,second.opId)).toBe(2);
    expect(await f.online.replaySyncOperation!(first)).toMatchObject({opId:first.opId,status:'applied'});
    expect(f.db.prepare('SELECT count(*) FROM entry_tags').pluck().get()).toBe(1);
  } finally { f.close(); }
});

// Real production SQL, response loss, full cold-IDB reopen and durable ACK boundary.
it('single bulk SQL receipt survives response loss and cold ACK retry with the original UUID/body',async()=>{
 const f=await fixture();try{
  await f.offline();const result=await f.api.addCollectionTag(f.parent.id,' Winter ');
  expect(result).toMatchObject({entriesAffected:2,alreadyPresent:0,skipped:1});
  const original=(await f.store.list())[0]!;const fingerprint=operationFingerprint(original);
  const exported=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany([original.opId]);
  let cold=f.cold();await cold.restorePendingWork!(exported);expect(operationFingerprint((await f.store.list())[0]!)).toBe(fingerprint);
  await cold.preferOfflineSnapshot!();
  expect(JSON.stringify(await cold.getEntry(f.other.id))).toContain('Winter');
  f.reconnect();f.loseResponse();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();
  expect(f.db.prepare('SELECT count(*) FROM entry_tags').pluck().get()).toBe(2);
  expect(f.db.prepare('SELECT count(*) FROM sync_operation_receipts WHERE op_id=?').pluck().get(original.opId)).toBe(1);
  expect(operationFingerprint((await f.store.list())[0]!)).toBe(fingerprint);
  const receipt=f.db.prepare('SELECT result_json FROM sync_operation_receipts WHERE op_id=?').pluck().get(original.opId);
  cold=f.cold();f.loseAcknowledgement();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();
  expect(await f.store.list()).toHaveLength(1);
  expect(f.bodies).toHaveLength(2);expect(f.bodies[1]).toBe(f.bodies[0]);
  cold=f.cold();await cold.getSyncCapabilities({replay:false});await cold.replayOfflineOperations!();
  expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT result_json FROM sync_operation_receipts WHERE op_id=?').pluck().get(original.opId)).toBe(receipt);
  expect(f.bodies.every(body=>body===f.bodies[0])).toBe(true);
  expect(JSON.stringify(await cold.getEntry(f.work.id))).toContain('Winter');
 }finally{f.close();}
});
it('bulk validates every frozen Entry before mutation and rolls back assignments Tag journal and receipt on SQL failure',async()=>{
 const f=await fixture();try{
  await f.offline();await f.api.addCollectionTag(f.parent.id,'Winter');
  const row=(await f.store.list())[0]!;const {status,lastAttemptAt,lastError,...operation}=row;void status;void lastAttemptAt;void lastError;
  const baseline=()=>['tags','entry_tags','sync_changes','sync_operation_receipts'].map(table=>f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get());
  const before=baseline();f.reconnect();
  f.db.exec(`CREATE TEMP TRIGGER reject_second_bulk BEFORE INSERT ON entry_tags WHEN (SELECT count(*) FROM entry_tags)>=1 BEGIN SELECT RAISE(ABORT,'forced second assignment failure'); END;`);
  await expect(f.online.replaySyncOperation!(operation as Parameters<NonNullable<typeof f.online.replaySyncOperation>>[0])).rejects.toThrow();
  expect(baseline()).toEqual(before);f.db.exec('DROP TRIGGER reject_second_bulk');
  f.db.prepare('UPDATE entries SET title=? WHERE id=?').run('Concurrent changed member',f.other.id);
  const changed=baseline();
  expect(await f.online.replaySyncOperation!(operation as Parameters<NonNullable<typeof f.online.replaySyncOperation>>[0])).toMatchObject({status:'conflict'});
  expect(baseline().slice(0,3)).toEqual(changed.slice(0,3));
  expect(f.db.prepare('SELECT count(*) FROM entry_tags').pluck().get()).toBe(0);
 }finally{f.close();}
});
it('a rejected durable enqueue creates neither partial queue nor optimistic Tag projection',async()=>{
 const f=await fixture();try{await f.offline();const spy=vi.spyOn(f.store,'enqueue').mockRejectedValueOnce(new Error('IDB abort'));
  await expect(f.api.addCollectionTag(f.parent.id,'Winter')).rejects.toThrow('IDB abort');spy.mockRestore();
  expect(await f.store.list()).toEqual([]);expect(JSON.stringify(await f.api.getEntry(f.work.id))).not.toContain('Winter');
 }finally{f.close();}
});

it('bulk forecasts its real Entry delta and schedules a later Entry write after the frozen bulk',async()=>{
 const f=await fixture();try{
  await f.offline();await f.api.addCollectionTag(f.parent.id,'Winter');
  await f.api.updateEntry(f.work.id,{title:'After bulk'});
  const rows=await f.store.list();expect(rows).toHaveLength(2);
  const bulk=rows[0]!;const next=rows[1]!;
  const member=(bulk.baseValues.members as Array<{syncUid:string;syncVersion:number}>).find(row=>row.syncUid===next.entityUid)!;
  expect(next.baseVersion).toBe(member.syncVersion+1);
  f.reconnect();await f.api.getSyncCapabilities({replay:false});await f.api.replayOfflineOperations!();
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.work.id)).toBe('After bulk');
  expect(await f.store.list()).toEqual([]);
  expect(f.bodies.map(body=>JSON.parse(body).operationKind)).toEqual(['collection.common-tag.add','entry.update']);
 }finally{f.close();}
});
