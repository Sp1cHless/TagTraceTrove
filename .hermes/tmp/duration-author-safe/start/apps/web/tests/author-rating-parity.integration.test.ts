import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createOfflineLibrary } from '../src/offline/offline-library.js';
import { entryPageQueryRequestSchema, producerPageQueryRequestSchema, type SyncSnapshot } from '@t3/shared';
const serverModule = async (path: string) => { const target = `../../server/src/${path}.js`; return import(/* @vite-ignore */ target); };
it('offline filter options, unrated and sort match real SQL for work summary and author-self without class leakage', async () => {
 const { createMigratedMemoryDatabase } = await serverModule('database/testing');
 const { createEntry } = await serverModule('repositories/entry-repository');
 const { createProducer, linkEntryProducer } = await serverModule('repositories/producer-repository');
 const { createEntryRatingSlot, createProducerRatingSlot, setEntryRating, setProducerRating } = await serverModule('repositories/rating-repository');
 const { buildSyncSnapshot } = await serverModule('sync/sync-service'); const { createApiApp } = await serverModule('http/app');
 const db = createMigratedMemoryDatabase(); const root = mkdtempSync(join(tmpdir(), `t3-rating-parity-${randomUUID()}-`));
 try {
  const authors = [0,1,2,3].map(i => createProducer(db, { name: `Author ${i}` }));
  const entries = ['Own', 'Inherited', 'Four', 'No author'].map(title => createEntry(db, { title, type: 'comic' }));
  for (const index of [0,1]) linkEntryProducer(db, entries[index].id, authors[0].id);
  for (const author of authors) linkEntryProducer(db, entries[2].id, author.id);
  const own = createEntryRatingSlot(db, { entryId: entries[0].id, name: 'Quality' });
  const summary = createProducerRatingSlot(db, { producerId: authors[0].id, name: 'Quality' });
  const self = createProducerRatingSlot(db, { producerId: authors[0].id, name: 'Quality', kind: 'author_self' });
  setEntryRating(db, { entryId: entries[0].id, slotId: own.id, stars: 4 });
  setProducerRating(db, { producerId: authors[0].id, slotId: summary.id, stars: 3 });
  setProducerRating(db, { producerId: authors[0].id, slotId: self.id, stars: 4.5 });
  const snapshot: SyncSnapshot = buildSyncSnapshot(db); const library = createOfflineLibrary(snapshot); const app = createApiApp(db, { assetRoot: root });
  const options = await (await app.request('/api/galleries/comic/filter-options')).json();
  expect(library.listFacetFilterOptions('comic').ratingSlots).toEqual(options.ratingSlots);
  for (const slotId of [own.id, summary.id, self.id]) {
   for (const operator of ['eq','gt','lt','unrated'] as const) {
    const request = entryPageQueryRequestSchema.parse({ entryType: 'comic', ratingConditions: [{slotId, operator, stars: operator === 'unrated' ? null : 3}], ratingSort: {slotId, applyAuthorRating: false} });
    const response = await app.request('/api/entries/query', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(request) });
    expect(response.status).toBe(200); const actual = await response.json();
    expect(library.queryEntryPage(request).items.map(row => row.id)).toEqual(actual.items.map((row: { id: number }) => row.id));
   }
  }
  const producerRequest = producerPageQueryRequestSchema.parse({ entryType:'comic', ratingConditions:[{slotId:self.id,operator:'gt',stars:4}], ratingSort:{slotId:self.id} });
  const response = await app.request('/api/producers/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(producerRequest)});
  expect(response.status).toBe(200); const actual = await response.json();
  expect(library.queryProducerPage(producerRequest).items.map(row=>row.id)).toEqual(actual.items.map((row:{id:number})=>row.id));
 } finally { db.close(); rmSync(root,{recursive:true,force:true}); }
});
