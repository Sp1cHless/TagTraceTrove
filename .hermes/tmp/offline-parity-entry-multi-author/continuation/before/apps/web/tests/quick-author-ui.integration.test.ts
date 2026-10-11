import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexedDB } from 'fake-indexeddb';
import { mount, flushPromises } from '@vue/test-utils';
import { expect, it, vi, type MockInstance } from 'vitest';
import type { GalleryApi } from '../src/api/gallery.js';
import GalleryApp from '../src/GalleryApp.vue';
import AuthorPage from '../src/AuthorPage.vue';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { setLocale } from '../src/i18n.js';
import { createNavigationMemory, navigationMemoryKey } from '../src/navigation-memory.js';
vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const window = new JSDOM('<!doctype html><html><body></body></html>', {url:'http://isolated/'}).window;
  for (const key of ['window','document','Element','HTMLElement','SVGElement','Node','localStorage','sessionStorage','MutationObserver','navigator','getComputedStyle'])
    Object.defineProperty(globalThis,key,{value: key === 'window' ? window : window[key as keyof typeof window], configurable:true});
});
globalThis.addEventListener = window.addEventListener.bind(window);
globalThis.removeEventListener = window.removeEventListener.bind(window);
const settle = async () => { for (let i=0;i<15;i++) { await flushPromises(); await new Promise(resolve=>setTimeout(resolve,5)); } };
const serverModule = async (path: string) => { const target = `../../server/src/${path}.js`; return import(/* @vite-ignore */ target); };
async function setup(offline = true, loss: 'replay' | 'snapshot' | 'ack' = 'replay') {
  setLocale('en'); vi.stubGlobal('scrollTo', vi.fn());
  const { createMigratedMemoryDatabase } = await serverModule('database/testing');
  const { createEntry } = await serverModule('repositories/entry-repository');
  const { createProducer, linkEntryProducer } = await serverModule('repositories/producer-repository');
  const { createProducerRatingSlot } = await serverModule('repositories/rating-repository');
  const { createApiApp } = await serverModule('http/app');
  const db = createMigratedMemoryDatabase(), root = mkdtempSync(join(tmpdir(), 't3-quick-ui-'));
  createEntry(db, {title:'Film seed',type:'film'});
  const entry = createEntry(db, {title:'Seed',type:'comic'});
  const author = createProducer(db,{name:'Author'}); linkEntryProducer(db,entry.id,author.id);
  const self = createProducerRatingSlot(db,{producerId:author.id,name:'Fresh',kind:'author_self'});
  const app = createApiApp(db,{assetRoot:root}); let lose = true; let available = true; const bodies:string[]=[];
  const online = createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    if(!available) throw new TypeError("isolated offline"); const url=new URL(String(input)); const response=await app.request(url.pathname+url.search,init);
    if(url.pathname==='/api/sync/replay') bodies.push(String(init?.body));
    const loseHere = loss === 'replay' ? url.pathname === '/api/sync/replay' : loss === 'ack' ? url.pathname.includes('/ack') : bodies.length > 0 && (url.pathname.includes('/snapshot') || url.pathname.includes('/delta'));
    if(lose && loseHere && response.ok){lose=false;available=false;throw new TypeError(`${loss} response lost`);}
    return response;
  }}));
  const name=`quick-ui-${randomUUID()}`;
  let store=createIndexedDbOfflineStore({indexedDB,databaseName:name});
  await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot())); await store.writeMeta('activeGeneration','1');
  let api=createOfflineAwareGalleryApi(online,store,{clientId:'quick-phone',randomUUID});
  await api.getSyncCapabilities({replay:false}); if(offline) {await api.preferOfflineSnapshot!();available=false;}
  return {db,root,self,author,bodies,online,reconnect(){available=true;},get api(){return api;},get store(){return store;},async reopen(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName:name});api=createOfflineAwareGalleryApi(online,store,{clientId:'quick-phone',randomUUID});await api.preferOfflineSnapshot!();},close(){store.close();db.close();rmSync(root,{recursive:true,force:true});vi.unstubAllGlobals();}};
}

it.each([['13:25',805,true],['0',0,true],['',null,true],['13:25',805,false],['0',0,false],['',null,false]] as const)('Quick import shell input %s reaches cold pending, exact retry SQL and ACK',async(text,seconds,offline)=>{
  const f=await setup(offline);let wrapper=mount(GalleryApp,{props:{api:f.api}});
  try{
    await settle();await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');await settle();
    const form=wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue(`Created ${text||'blank'}`);
    await form.get('input[name="duration"]').setValue('bad');await form.trigger('submit');await settle();
    expect(await f.store.list()).toEqual([]);expect(form.find('[role="alert"]').exists()).toBe(true);
    await form.get('input[name="duration"]').setValue(text);await form.trigger('submit');await settle();
    const operations=await f.store.list();expect(operations).toHaveLength(1);
    if(seconds===null)expect(operations[0]!.payload).not.toHaveProperty('durationSeconds');else expect(operations[0]!.payload.durationSeconds).toBe(seconds);
    wrapper.unmount();await f.reopen();
    const pending=await f.api.listPendingOfflineEntryCreates!();expect(pending).toHaveLength(1);
    if(seconds!==null)expect(pending[0]!.durationSeconds).toBe(seconds);
    wrapper=mount(GalleryApp,{props:{api:f.api}});await settle();await wrapper.get('[data-gallery-type="comic"]').trigger('click');await settle();expect(wrapper.text()).toContain(`Created ${text||'blank'}`);
    f.reconnect();await f.api.flushOfflineOutbox!();if(offline) expect(await f.store.list()).toHaveLength(1);
    f.reconnect();await f.api.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);expect(f.bodies[0]).toBe(f.bodies[1]);
    expect(f.db.prepare('SELECT duration_seconds FROM entries WHERE title=?').pluck().get(`Created ${text||'blank'}`)).toBe(seconds);
    expect(await f.api.listPendingOfflineEntryCreates!()).toEqual([]);
  }finally{wrapper.unmount();f.close();}
});

it('AuthorPage list unscored option and unrated filter read actual facade; pending layout add/delete/anchor updates options',async()=>{
  const f=await setup(); const wrapper=mount(AuthorPage,{props:{api:f.api,authors:await f.api.listAuthors()}});
  try{
    await settle();await wrapper.get('[data-testid="add-author-rating-filter"]').trigger('click');await settle();
    expect(wrapper.findAll('[data-author-id]')).toHaveLength(1);
    await wrapper.get('[data-testid="author-rating-slot-select"]').setValue(f.self.id);await settle();
    expect(wrapper.findAll('[data-author-id]')).toHaveLength(0);
    await wrapper.get('[data-testid="author-rating-operator-select"]').setValue('unrated');await settle();
    expect(wrapper.find('[data-testid="author-rating-stars-select"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-author-id]')).toHaveLength(1);
    await wrapper.get('[data-testid="remove-author-rating-filter"]').trigger('click');await settle();
    const slot=await f.api.createAuthorRatingSlot(f.author.id,'New pending','author_self');
    expect((await f.api.listAuthorFilterOptions()).ratingSlots.map(row=>row.name)).toContain('New pending');
    await f.api.setAuthorRating(f.author.id,slot.id,3.5);await f.api.setAuthorRating(f.author.id,slot.id,null);
    expect((await f.api.listAuthorFilterOptions()).ratingSlots.map(row=>row.name)).toContain('New pending');
    await f.api.deleteAuthorRatingSlot(f.author.id,slot.id);
    expect((await f.api.listAuthorFilterOptions()).ratingSlots.map(row=>row.name)).not.toContain('New pending');
    await f.api.setAuthorGalleryAnchor(f.author.id,'film');
    expect((await f.api.listAuthorFilterOptions()).ratingSlots).toEqual([]);
  }finally{wrapper.unmount();f.close();}
});

// Real caller results are checked against application HTTP/SQLite, not a raw API stub.
async function authorFixture() {
  const f = await setup();
  const { createEntry } = await serverModule('repositories/entry-repository');
  const { createProducer, linkEntryProducer } = await serverModule('repositories/producer-repository');
  const { createProducerRatingSlot, setProducerRating } = await serverModule('repositories/rating-repository');
  const { assignProducerTag } = await serverModule('repositories/producer-tag-repository');
  const { assignEntryTag } = await serverModule('repositories/entry-tag-repository');
  const { createSection } = await serverModule('repositories/layout-repository');
  const authors = [f.author, ...['Alpha', 'Beta', 'Null'].map(name => createProducer(f.db, {name}))];
  const section = createSection(f.db, {entryType:'comic', name:'Genre'});
  const second = createProducerRatingSlot(f.db, {producerId:f.author.id, name:'Second', kind:'author_self'});
  let own = 0, work = 0;
  for (const [i, author] of authors.entries()) {
    const entry = createEntry(f.db, {title:`Work ${i}`, type:'comic'});
    linkEntryProducer(f.db, entry.id, author.id);
    if (i < 2) own = assignProducerTag(f.db, {producerId:author.id, name:'Circle'}).tagId;
    if (i === 0 || i === 2) work = assignEntryTag(f.db, {entryId:entry.id, facetId:section.defaultFacetId, name:'Action'}).tagId;
    if (i < 3) {
      setProducerRating(f.db, {producerId:author.id, slotId:f.self.id, stars:[5,4,3.5][i]});
      setProducerRating(f.db, {producerId:author.id, slotId:second.id, stars:[3.5,5,4][i]});
    }
  }
  f.reconnect();
  await f.store.writeGeneration(2, JSON.stringify(await f.online.fetchSyncSnapshot()));
  await f.store.writeMeta('activeGeneration','2');
  await f.reopen();
  return {f, authors, second, own, work};
}
const ids = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('[data-author-id]').map(row=>Number(row.attributes('data-author-id')));
async function checkSql(f: Awaited<ReturnType<typeof setup>>, wrapper: ReturnType<typeof mount>, query: MockInstance<GalleryApi['queryProducerPage']>) {
  await settle();
  const call = query.mock.calls.at(-1)!;
  const sql = await f.online.queryProducerPage(call[0]);
  const actual = await query.mock.results.at(-1)!.value;
  expect(actual.items.map((row:{id:number})=>row.id)).toEqual(sql.items.map(row=>row.id));
  expect(actual.total).toBe(sql.total);
  expect(ids(wrapper)).toEqual(sql.items.map(row=>row.id));
  expect(wrapper.get('[data-testid="author-list-count"]').text()).toContain(String(sql.total));
  return sql;
}
it('actual Author own/work tags AND rating agree with SQL and restore rows/results after navigation unmount', async()=>{
  const {f, authors, second} = await authorFixture();
  const memory = createNavigationMemory();
  const query = vi.spyOn(f.api,'queryProducerPage');
  const options = {props:{api:f.api, authors:await f.api.listAuthors()}, global:{provide:{[navigationMemoryKey as symbol]:memory}}};
  let wrapper = mount(AuthorPage, options);
  try {
    await settle();
    for (const prefix of ['author','work']) {
      await wrapper.get(`[data-testid="add-${prefix}-tag-filter"]`).trigger('click');
      await wrapper.get(`[data-testid="${prefix}-tag-combobox-toggle"]`).trigger('click');
      await wrapper.get(`[data-testid="${prefix}-tag-combobox-option"]`).trigger('click');
      await settle();
      expect((await checkSql(f,wrapper,query)).total).toBe(prefix === 'author' ? 2 : 1);
    }
    await wrapper.get('[data-testid="add-author-rating-filter"]').trigger('click');
    await wrapper.get('[data-testid="author-rating-slot-select"]').setValue(f.self.id);
    expect((await checkSql(f,wrapper,query)).items.map(row=>row.id)).toEqual([authors[0].id]);
    await wrapper.get('[data-testid="add-author-rating-filter"]').trigger('click');
    const secondRow = wrapper.findAll('[data-testid="author-rating-filter-row"]')[1]!;
    await secondRow.get('[data-testid="author-rating-slot-select"]').setValue(second.id);
    await secondRow.get('[data-testid="author-rating-operator-select"]').setValue('eq');
    await secondRow.get('[data-testid="author-rating-stars-select"]').setValue('3.5');
    await checkSql(f,wrapper,query);
    const savedIds = ids(wrapper);
    wrapper.unmount();
    expect(memory.states.get('author-list')).toMatchObject({ratingFilters:[{slotId:f.self.id,operator:'gt',stars:3},{slotId:second.id,operator:'eq',stars:3.5}]});
    wrapper = mount(AuthorPage, options);
    await settle();
    expect(wrapper.findAll('[data-testid="author-rating-filter-row"]')).toHaveLength(2);
    const restoredSecond = wrapper.findAll('[data-testid="author-rating-filter-row"]')[1]!;
    expect((restoredSecond.get('[data-testid="author-rating-slot-select"]').element as HTMLSelectElement).value).toBe(String(second.id));
    expect((restoredSecond.get('[data-testid="author-rating-operator-select"]').element as HTMLSelectElement).value).toBe('eq');
    expect((restoredSecond.get('[data-testid="author-rating-stars-select"]').element as HTMLSelectElement).value).toBe('3.5');
    expect((wrapper.get('[data-testid="author-rating-slot-select"]').element as HTMLSelectElement).value).toBe(String(f.self.id));
    expect((wrapper.get('[data-testid="author-rating-operator-select"]').element as HTMLSelectElement).value).toBe('gt');
    expect((wrapper.get('[data-testid="author-rating-stars-select"]').element as HTMLSelectElement).value).toBe('3');
    expect(wrapper.get('[data-testid="author-tag-combobox-toggle"]').text()).toContain('Circle');
    expect(wrapper.get('[data-testid="work-tag-combobox-toggle"]').text()).toContain('Action');
    await checkSql(f,wrapper,query);expect(ids(wrapper)).toEqual(savedIds);
  } finally {wrapper.unmount();f.close();}
});
it('actual multi-row first selected slot controls order; replacement/deletion/operators/reset preserve SQL totals', async()=>{
  const {f, authors, second} = await authorFixture();
  const query = vi.spyOn(f.api,'queryProducerPage');
  const wrapper = mount(AuthorPage,{props:{api:f.api,authors:await f.api.listAuthors()}});
  const rows = () => wrapper.findAll('[data-testid="author-rating-filter-row"]');
  try {
    await settle();
    // An empty first row must not steal sorting from the first selected row.
    await wrapper.get('[data-testid="add-author-rating-filter"]').trigger('click');
    await wrapper.get('[data-testid="add-author-rating-filter"]').trigger('click');
    await rows()[1]!.get('[data-testid="author-rating-slot-select"]').setValue(second.id);
    expect((await checkSql(f,wrapper,query)).items.map(row=>row.id)).toEqual([authors[1].id,authors[2].id,authors[0].id]);
    await rows()[0]!.get('[data-testid="author-rating-slot-select"]').setValue(f.self.id);
    expect((await checkSql(f,wrapper,query)).items.map(row=>row.id)).toEqual([authors[0].id,authors[1].id,authors[2].id]);
    await rows()[0]!.get('[data-testid="author-rating-slot-select"]').setValue(second.id);
    expect((await checkSql(f,wrapper,query)).items.map(row=>row.id)).toEqual([authors[1].id,authors[2].id,authors[0].id]);
    await rows()[0]!.get('[data-testid="remove-author-rating-filter"]').trigger('click');
    expect((await checkSql(f,wrapper,query)).items.map(row=>row.id)).toEqual([authors[1].id,authors[2].id,authors[0].id]);
    await rows()[0]!.get('[data-testid="author-rating-operator-select"]').setValue('lt');
    expect((await checkSql(f,wrapper,query)).total).toBe(0);
    await rows()[0]!.get('[data-testid="author-rating-operator-select"]').setValue('eq');
    await rows()[0]!.get('[data-testid="author-rating-stars-select"]').setValue('4');
    expect((await checkSql(f,wrapper,query)).items.map(row=>row.id)).toEqual([authors[2].id]);
    await rows()[0]!.get('[data-testid="author-rating-operator-select"]').setValue('unrated');
    expect((await checkSql(f,wrapper,query)).items.map(row=>row.id)).toEqual([authors[3].id]);
    await rows()[0]!.get('[data-testid="remove-author-rating-filter"]').trigger('click');
    const reset = await checkSql(f,wrapper,query);expect(reset.total).toBe(4);
    expect(reset.items.map(row=>row.name)).toEqual(['Alpha','Author','Beta','Null']);
  } finally {wrapper.unmount();f.close();}
});
it.each(['snapshot','ack'] as const)('actual Quick import retains committed create on %s response loss until cold exact retry settles',async loss=>{
  const f=await setup(true,loss);const wrapper=mount(GalleryApp,{props:{api:f.api}});
  try {
    await settle();await wrapper.get('[data-testid="add-entry-navigation"]').trigger('click');await settle();
    const form=wrapper.get('[data-testid="manual-entry-form"]');
    await form.get('input[name="title"]').setValue(`Lost ${loss}`);
    await form.get('input[name="duration"]').setValue('0');await form.trigger('submit');await settle();
    const before=await f.store.list();expect(before).toHaveLength(1);
    f.reconnect();await f.api.flushOfflineOutbox!();
    expect(f.db.prepare('SELECT duration_seconds FROM entries WHERE title=?').pluck().get(`Lost ${loss}`)).toBe(0);
    expect(await f.store.list()).toHaveLength(1);
    await f.reopen();
    const retained=(await f.store.list())[0]!;
    expect({opId:retained.opId,payload:retained.payload}).toEqual({opId:before[0]!.opId,payload:before[0]!.payload});
    expect(await f.api.listPendingOfflineEntryCreates!()).toHaveLength(1);
    f.reconnect();await f.api.flushOfflineOutbox!();expect(f.bodies).toHaveLength(2);expect(f.bodies[0]).toBe(f.bodies[1]);
    expect(await f.store.list()).toEqual([]);expect(await f.api.listPendingOfflineEntryCreates!()).toEqual([]);
    expect(f.db.prepare('SELECT count(*) FROM entries WHERE title=?').pluck().get(`Lost ${loss}`)).toBe(1);
  } finally {wrapper.unmount();f.close();}
});
