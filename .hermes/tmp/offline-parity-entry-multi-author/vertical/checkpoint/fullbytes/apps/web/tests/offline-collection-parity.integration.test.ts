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

it('ordinary common-tag caller counts each parent/child Work once and reports new, existing and skipped names accurately', async () => {
  const f = await fixture();
  setLocale('en'); showNsfw.value = true;
  vi.stubGlobal('scrollTo', vi.fn());
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
    expect(wrapper.get('[data-testid="collection-common-tag-result"]').text()).toBe('Tagged 2 works (0 already had it, 1 skipped).');
    expect(f.db.prepare('SELECT count(*) FROM entry_tags').pluck().get()).toBe(2);
    expect(await f.online.addCollectionTag(f.parent.id, 'Winter')).toMatchObject({ entriesAffected: 0, alreadyPresent: 2, skipped: 1 });
    expect(await f.online.addCollectionTag(f.child.id, 'winter')).toMatchObject({ entriesAffected: 0, alreadyPresent: 2, skipped: 1 });
  } finally { wrapper.unmount(); f.close(); vi.unstubAllGlobals(); }
});

it('ordinary Collection delete confirms twice, cascades folders/members only, and retains Entries, Author, tags and peer memberships', async () => {
  const f = await fixture();
  setLocale('en'); showNsfw.value = true;
  vi.stubGlobal('scrollTo', vi.fn());
  await f.online.addCollectionTag(f.parent.id, 'Winter');
  const wrapper = mount(CollectionsPage, { props: { api: f.api } });
  try {
    await settle();
    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');
    f.calls.length = 0;
    await wrapper.get(`[data-testid="delete-collection-${f.parent.id}"]`).trigger('click');
    expect(f.calls).toEqual([]);
    await wrapper.get(`[data-testid="delete-collection-${f.parent.id}"]`).trigger('click');
    await settle();
    expect(f.calls).toContain('POST /api/sync/replay');
    expect(f.calls).not.toContain(`DELETE /api/collections/${f.parent.id}`);
    expect(f.db.prepare('SELECT id FROM collections ORDER BY id').pluck().all()).toEqual([f.peer.id]);
    expect(f.db.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(3);
    expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM entry_producers').pluck().get()).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM entry_tags').pluck().get()).toBe(2);
    expect(f.db.prepare('SELECT collection_id,entry_id FROM collection_entries').all()).toEqual([{ collection_id: f.peer.id, entry_id: f.work.id }]);
  } finally { wrapper.unmount(); f.close(); vi.unstubAllGlobals(); }
});

// Explicit expected REDs: blocked protocol/identity lane, NOT implemented parity.
// Keep assertions on the real facade/HTTP boundary rather than inventing receipts.
it.each(['common-tag'] as const)('known-offline %s atomically stages one bulk without business HTTP', async () => {
  const f = await fixture();
  try {
    await f.offline();
    const action = f.api.addCollectionTag(f.parent.id, 'Winter');
    await expect(action).resolves.toMatchObject({entriesAffected:2,alreadyPresent:0,skipped:1});
    const rows=await f.store.list();expect(rows).toHaveLength(1);expect(rows[0]?.operationKind).toBe('collection.common-tag.add');
    expect(f.calls).toEqual([]);
  } finally { f.close(); }
});
