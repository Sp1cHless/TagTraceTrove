import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexedDB } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
const serverModule = async (path: string) => { const target = `../../server/src/${path}.js`; return import(/* @vite-ignore */ target); };
it('empty author-self partition can add, half-star, cold-read, reorder, clear, delete and anchor through actual replay', async () => {
 const { createMigratedMemoryDatabase } = await serverModule('database/testing');
 const { createEntry } = await serverModule('repositories/entry-repository');
 const { createProducer } = await serverModule('repositories/producer-repository');
 const { setProducerGalleryAnchor } = await serverModule('repositories/rating-repository');
 const { buildSyncSnapshot } = await serverModule('sync/sync-service');
 const { createApiApp } = await serverModule('http/app');
 const db = createMigratedMemoryDatabase(); const root = mkdtempSync(join(tmpdir(), 't3-author-self-'));
 const name = `author-self-${randomUUID()}`; let store = createIndexedDbOfflineStore({ indexedDB, databaseName: name });
 try {
  createEntry(db, { title: 'Comic seed', type: 'comic' }); createEntry(db, { title: 'Film seed', type: 'film' });
  const author = createProducer(db, { name: 'Anchored no works' });
  setProducerGalleryAnchor(db, { producerId: author.id, galleryType: 'comic' });
  const app = createApiApp(db, { assetRoot: root }); let lose = true; const bodies: string[] = [];
  const online = createGalleryApi(createApiClient({ baseUrl: 'http://isolated/api', fetchImplementation: async (input, init) => {
   const url = new URL(String(input)); const response = await app.request(url.pathname + url.search, init);
   if (url.pathname === '/api/sync/replay') { bodies.push(String(init?.body)); if (lose && response.ok) { lose = false; throw new TypeError('committed response lost'); } }
   return response;
  } }));
  await store.writeGeneration(1, JSON.stringify(buildSyncSnapshot(db))); await store.writeMeta('activeGeneration', '1');
  let api = createOfflineAwareGalleryApi(online, store, { clientId: 'author-phone', randomUUID });
  await api.getSyncCapabilities({ replay: false }); await api.preferOfflineSnapshot!();
  expect((await api.getAuthor(author.id)).galleryType).toBe('comic');
  const charisma = await api.createAuthorRatingSlot(author.id, 'Charisma', 'author_self');
  const voice = await api.createAuthorRatingSlot(author.id, 'Voice', 'author_self');
  await api.setAuthorRating(author.id, charisma.id, 3.5);
  await api.reorderAuthorRatingSlots(author.id, [voice.id, charisma.id]);
  store.close(); store = createIndexedDbOfflineStore({ indexedDB, databaseName: name });
  api = createOfflineAwareGalleryApi(online, store, { clientId: 'author-phone', randomUUID }); await api.preferOfflineSnapshot!();
  expect((await api.getAuthor(author.id)).authorSelfRatings).toEqual([{ slotId: voice.id, name: 'Voice', stars: null }, { slotId: charisma.id, name: 'Charisma', stars: 3.5 }]);
  const original = await store.list(); await api.flushOfflineOutbox!(); expect(await store.list()).toHaveLength(original.length);
  await api.flushOfflineOutbox!(); expect(await store.list()).toEqual([]); expect(bodies[0]).toBe(bodies[1]);
  const actual = await api.getAuthor(author.id); expect(actual.authorSelfRatings?.find(row => row.name === 'Charisma')?.stars).toBe(3.5);
  const slotId = actual.authorSelfRatings!.find(row => row.name === 'Charisma')!.slotId;
  await api.preferOfflineSnapshot!(); await api.setAuthorRating(author.id, slotId, null); await api.flushOfflineOutbox!();
  await api.preferOfflineSnapshot!(); await api.deleteAuthorRatingSlot(author.id, slotId); await api.flushOfflineOutbox!();
  expect(db.prepare("SELECT count(*) FROM rating_slots WHERE subject_kind='author_self' AND name='Charisma'").pluck().get()).toBe(0);
  await api.preferOfflineSnapshot!(); await api.setAuthorGalleryAnchor(author.id, 'film');
  expect((await api.getAuthor(author.id)).galleryType).toBe('film'); expect((await api.getAuthor(author.id)).authorSelfRatings).toEqual([]);
  await api.flushOfflineOutbox!(); expect(db.prepare('SELECT gallery_anchor FROM producers WHERE id=?').pluck().get(author.id)).toBe('film'); expect(await store.list()).toEqual([]);
 } finally { store.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
