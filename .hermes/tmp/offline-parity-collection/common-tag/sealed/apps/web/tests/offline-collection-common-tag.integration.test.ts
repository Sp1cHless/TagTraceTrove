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
  const online = createGalleryApi(createApiClient({ baseUrl: 'http://isolated/api', fetchImplementation: async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (disconnected) throw new TypeError('Known offline');
    return app.request(url.pathname + url.search, init);
  } }));
  const store = createIndexedDbOfflineStore({ indexedDB: new IDBFactory(), databaseName: randomUUID() });
  const api = createOfflineAwareGalleryApi(online, store, { clientId: 'collection-parity-phone', randomUUID });
  return { db, section, work, other, skipped, author, parent, child, peer, online, api, calls, store,
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
