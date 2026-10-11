import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexedDB } from 'fake-indexeddb';
import { mount, flushPromises } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import GalleryApp from '../src/GalleryApp.vue';
import AuthorPage from '../src/AuthorPage.vue';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { setLocale } from '../src/i18n.js';
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
async function setup(offline = true) {
  setLocale('en'); vi.stubGlobal('scrollTo', vi.fn());
  const { createMigratedMemoryDatabase } = await serverModule('database/testing');
  const { createEntry } = await serverModule('repositories/entry-repository');
  const { createProducer, linkEntryProducer } = await serverModule('repositories/producer-repository');
  const { createProducerRatingSlot } = await serverModule('repositories/rating-repository');
  const { createApiApp } = await serverModule('http/app');
  const { buildSyncSnapshot } = await serverModule('sync/sync-service');
  const db = createMigratedMemoryDatabase(), root = mkdtempSync(join(tmpdir(), 't3-quick-ui-'));
  createEntry(db, {title:'Film seed',type:'film'});
  const entry = createEntry(db, {title:'Seed',type:'comic'});
  const author = createProducer(db,{name:'Author'}); linkEntryProducer(db,entry.id,author.id);
  const self = createProducerRatingSlot(db,{producerId:author.id,name:'Fresh',kind:'author_self'});
  const app = createApiApp(db,{assetRoot:root}); let lose = true; let available = true; const bodies:string[]=[];
  const online = createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
    if(!available) throw new TypeError("isolated offline"); const url=new URL(String(input)); const response=await app.request(url.pathname+url.search,init);
    if(url.pathname==='/api/sync/replay'){bodies.push(String(init?.body));if(lose&&response.ok){lose=false;available=false;throw new TypeError('committed response lost');}}
    return response;
  }}));
  const name=`quick-ui-${randomUUID()}`;
  let store=createIndexedDbOfflineStore({indexedDB,databaseName:name});
  await store.writeGeneration(1,JSON.stringify(buildSyncSnapshot(db))); await store.writeMeta('activeGeneration','1');
  let api=createOfflineAwareGalleryApi(online,store,{clientId:'quick-phone',randomUUID});
  await api.getSyncCapabilities({replay:false}); if(offline) {await api.preferOfflineSnapshot!();available=false;}
  return {db,root,self,author,bodies,reconnect(){available=true;},get api(){return api;},get store(){return store;},async reopen(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName:name});api=createOfflineAwareGalleryApi(online,store,{clientId:'quick-phone',randomUUID});await api.preferOfflineSnapshot!();},close(){store.close();db.close();rmSync(root,{recursive:true,force:true});vi.unstubAllGlobals();}};
}

it.each([['13:25',805,true],['0',0,true],['',null,true],['13:25',805,false]] as const)('Quick import shell input %s reaches cold pending, exact retry SQL and ACK',async(text,seconds,offline)=>{
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
