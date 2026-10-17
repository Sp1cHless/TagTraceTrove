import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { producerPageQueryRequestSchema } from '@t3/shared';
import { createOfflineLibrary } from '../src/offline/offline-library.js';
const serverModule = async (path: string) => { const target = `../../server/src/${path}.js`; return import(/* @vite-ignore */ target); };

async function fixture() {
  const { createMigratedMemoryDatabase } = await serverModule('database/testing');
  const { createEntry } = await serverModule('repositories/entry-repository');
  const { createProducer, linkEntryProducer } = await serverModule('repositories/producer-repository');
  const ratings = await serverModule('repositories/rating-repository');
  const { buildSyncSnapshot } = await serverModule('sync/sync-service');
  const { createApiApp } = await serverModule('http/app');
  const db = createMigratedMemoryDatabase();
  const root = mkdtempSync(join(tmpdir(), 't3-quick-author-'));
  const authors = ['Zulu', 'Alpha', 'Half', 'Zero', 'Unrated'].map(name => createProducer(db, { name }));
  for (const author of authors) {
    const entry = createEntry(db, { title: author.name, type: 'comic' });
    linkEntryProducer(db, entry.id, author.id);
    ratings.setProducerGalleryAnchor(db, { producerId: author.id, galleryType: 'film' });
  }
  createEntry(db, { title: 'Film partition', type: 'film' });
  const self = ratings.createProducerRatingSlot(db, { producerId: authors[0].id, name: 'Voice', kind: 'author_self' });
  const fresh = ratings.createProducerRatingSlot(db, { producerId: authors[0].id, name: 'Fresh', kind: 'author_self' });
  const summary = ratings.createProducerRatingSlot(db, { producerId: authors[0].id, name: 'Voice' });
  for (const [i, stars] of [5, 5, 3.5, 0.5].entries()) ratings.setProducerRating(db, { producerId: authors[i].id, slotId: self.id, stars });
  const app = createApiApp(db, { assetRoot: root });
  return { db, root, authors, self, fresh, summary, library: createOfflineLibrary(buildSyncSnapshot(db)), app, buildSyncSnapshot };
}

it('Author list options expose unscored self dimensions in the anchor Gallery, matching application HTTP SQL', async () => {
  const f = await fixture();
  try {
    for (const type of [undefined, 'film', 'comic']) {
      const response = await f.app.request(`/api/producers/filter-options${type ? `?entryType=${type}` : ''}`);
      expect(response.status).toBe(200);
      expect(f.library.listAuthorFilterOptions(type)).toEqual(await response.json());
    }
    expect(f.library.listAuthorFilterOptions('film').ratingSlots.map(row => row.id)).toContain(f.fresh.id);
  } finally { f.db.close(); rmSync(f.root, { recursive: true, force: true }); }
});

it('Author query matches SQL anchor filtering, AND conditions, null-last and seeded tie pagination', async () => {
  const f = await fixture();
  try {
    for (const sort of ['name-asc', 'views-desc', 'likes-desc', 'last-viewed-desc', 'random'] as const) {
      for (const operator of ['gt', 'lt', 'eq', 'unrated'] as const) {
        const request = producerPageQueryRequestSchema.parse({ entryType: 'film', sort, randomSeed: 17, pageSize: 2, page: 2,
          ratingConditions: [{ slotId: f.self.id, operator, stars: operator === 'unrated' ? null : 3.5 }],
          ratingSort: { slotId: f.self.id, direction: 'desc' } });
        const response = await f.app.request('/api/producers/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
        expect(response.status).toBe(200);
        const sql = await response.json(); const offline = f.library.queryProducerPage(request);
        expect({ ids: offline.items.map(row => row.id), total: offline.total }).toEqual({ ids: sql.items.map((row: {id: number}) => row.id), total: sql.total });
      }
    }
    const and = producerPageQueryRequestSchema.parse({ratingConditions: [{slotId:f.self.id,operator:'gt',stars:3}, {slotId:f.fresh.id,operator:'unrated',stars:null}], ratingSort:{slotId:f.self.id,direction:'desc'}});
    expect(f.library.queryProducerPage(and).items.map(row=>row.id)).toEqual([f.authors[1].id,f.authors[0].id,f.authors[2].id]);
  } finally { f.db.close(); rmSync(f.root, {recursive:true,force:true}); }
});

it('Author query refuses wrong-class and unknown filter and sort slots instead of treating them as unrated', async () => {
  const f = await fixture();
  try {
    for (const slotId of [f.summary.id, 999999]) for (const field of ['ratingConditions','ratingSort']) {
      const request = producerPageQueryRequestSchema.parse({[field]:field === 'ratingSort' ? {slotId,direction:'desc'} : [{slotId,operator:'unrated',stars:null}]});
      const response = await f.app.request('/api/producers/query', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
      expect(response.status).toBe(409);
      expect(()=>f.library.queryProducerPage(request)).toThrow(/not an Author's own rating dimension/);
    }
  } finally { f.db.close(); rmSync(f.root,{recursive:true,force:true}); }
});

it('Author rating never leaks a stale value from the previous anchor partition in SQL or offline',async()=>{
 const f=await fixture();
 try{
  f.db.prepare('UPDATE producers SET gallery_anchor=? WHERE id=?').run('comic',f.authors[0].id);
  const request=producerPageQueryRequestSchema.parse({producerIds:[f.authors[0].id],ratingConditions:[{slotId:f.self.id,operator:'unrated',stars:null}],ratingSort:{slotId:f.self.id,direction:'desc'}});
  const response=await f.app.request('/api/producers/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
  expect(response.status).toBe(200);expect((await response.json()).total).toBe(1);
  expect(createOfflineLibrary(f.buildSyncSnapshot(f.db)).queryProducerPage(request).total).toBe(1);
 }finally{f.db.close();rmSync(f.root,{recursive:true,force:true});}
});

it('Author options use full-author hideable eligibility and distinguish same-name dimensions across anchor Galleries',async()=>{
 const f=await fixture();
 try{
  const {createProducerRatingSlot}=await serverModule('repositories/rating-repository');
  f.db.prepare('UPDATE producers SET gallery_anchor=? WHERE id=?').run('comic',f.authors[4].id);
  createProducerRatingSlot(f.db,{producerId:f.authors[4].id,name:'Voice',kind:'author_self'});
  f.db.prepare('INSERT INTO gallery_settings(entry_type,nsfw) VALUES (?,1) ON CONFLICT(entry_type) DO UPDATE SET nsfw=1').run('comic');
  const library=createOfflineLibrary(f.buildSyncSnapshot(f.db));
  for(const includeNsfw of [true,false])for(const type of [undefined,'film','comic']){
   const response=await f.app.request('/api/producers/filter-options?includeNsfw='+includeNsfw+(type?'&entryType='+type:''));
   expect(response.status).toBe(200);expect(library.listAuthorFilterOptions(type,includeNsfw)).toEqual(await response.json());
   const request=producerPageQueryRequestSchema.parse({entryType:type,includeNsfw,ratingSort:{slotId:f.self.id,direction:'desc'}});
   const sql=await(await f.app.request('/api/producers/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)})).json();
   const offline=library.queryProducerPage(request);expect(offline.items.map(row=>row.id)).toEqual(sql.items.map((row:{id:number})=>row.id));expect(offline.total).toBe(sql.total);
  }
 }finally{f.db.close();rmSync(f.root,{recursive:true,force:true});}
});
