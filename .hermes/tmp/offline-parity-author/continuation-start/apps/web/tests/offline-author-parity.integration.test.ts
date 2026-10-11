import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import GalleryApp from '../src/GalleryApp.vue';
import { setLocale } from '../src/i18n.js';
vi.hoisted(async () => {
 const {JSDOM}=await import('jsdom');const window=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://isolated/'}).window;
 for(const key of ['window','document','Element','HTMLElement','SVGElement','Node','localStorage','sessionStorage','MutationObserver','navigator','getComputedStyle'])Object.defineProperty(globalThis,key,{value:key==='window'?window:window[key as keyof typeof window],configurable:true});
});
globalThis.addEventListener=window.addEventListener.bind(window);globalThis.removeEventListener=window.removeEventListener.bind(window);
const settle=async()=>{for(let i=0;i<15;i++){await flushPromises();await new Promise(resolve=>setTimeout(resolve,5));}};
import { entryPageQueryRequestSchema, producerPageQueryRequestSchema } from '@t3/shared';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createGalleryApi } from '../src/api/gallery.js';
import { createApiClient } from '../src/api/client.js';
import { originalMutationEnvelope } from '../src/offline/sync-mutation-plan.js';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';
const serverModule = async (path: string) => { const target = `../../server/src/${path}.js`; return import(/* @vite-ignore */ target); };
async function fixture(install = true) {
 const { createMigratedMemoryDatabase } = await serverModule('database/testing');
 const { createEntry } = await serverModule('repositories/entry-repository');
 const { createProducer, linkEntryProducer } = await serverModule('repositories/producer-repository');
 const { createApiApp } = await serverModule('http/app');
 const db=createMigratedMemoryDatabase(), root=mkdtempSync(join(tmpdir(),'t3-entry-delete-'));
 const entry=createEntry(db,{title:'Delete this',type:'comic'}), survivor=createEntry(db,{title:'Keep this',type:'comic'});
 const author=createProducer(db,{name:'Retained workless Author'});linkEntryProducer(db,entry.id,author.id);
 const {createSection}=await serverModule('repositories/layout-repository');createSection(db,{entryType:'comic',name:'Tags'});
 const app=createApiApp(db,{assetRoot:root});const indexedDB=new IDBFactory(),name=randomUUID();
 let store=createIndexedDbOfflineStore({indexedDB,databaseName:name});let disconnected=false,loseReplay=false,loseAck=false;
 const bodies:string[]=[], business:string[]=[];
 const online=createGalleryApi(createApiClient({baseUrl:'http://isolated/api',fetchImplementation:async(input,init)=>{
  const url=new URL(String(input));business.push(url.pathname);
  if(disconnected)throw new TypeError('Known offline');
  if(url.pathname==='/api/sync/replay')bodies.push(String(init?.body));
  const response=await app.request(url.pathname+url.search,init);
  if(url.pathname==='/api/sync/replay' && loseReplay && response.ok){loseReplay=false;throw new TypeError('Replay response lost');}
  if(url.pathname.includes('/ack') && loseAck && response.ok){loseAck=false;throw new TypeError('ACK response lost');}
  return response;
 }}));
 if (install) { await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1'); }
 const api=(state?: import('../src/offline/offline-api.js').OfflineApiState)=>createOfflineAwareGalleryApi(online,store,{clientId:'delete-phone',randomUUID,...(state ? {state} : {})});const current=api();
 await current.getSyncCapabilities({replay:false});if (install) await current.preferOfflineSnapshot!();business.length=0;disconnected=install;
 return {db,root,entry,survivor,author,online,current,bodies,business,get store(){return store;},
  connect(){disconnected=false;},disconnect(){disconnected=true;},loseReplay(){loseReplay=true;},loseAck(){loseAck=true;},
  cold(state?: import('../src/offline/offline-api.js').OfflineApiState){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName:name});return api(state);},
  close(){store.close();db.close();rmSync(root,{recursive:true,force:true});}};
}

it('standalone Author actual form creates a durable workless detail, cold edits and links an existing work with exact replay retry',async()=>{
 const f=await fixture();try{
  const {default:AddAuthorPage}=await import('../src/AddAuthorPage.vue');
  let created:Awaited<ReturnType<typeof f.current.createAuthor>>|undefined;
  const page=mount(AddAuthorPage,{props:{submitting:false,onSubmit:async draft=>{created=await f.current.createAuthor(draft);}}});
  await page.get('input[name="name"]').setValue('Standalone');await page.get('input[name="occupation"]').setValue('Artist');
  await page.get('textarea').setValue('Profile');await page.get('form').trigger('submit');await settle();page.unmount();
  expect(created?.name).toBe('Standalone');expect(f.business).toEqual([]);
  const id=created!.id;expect(id).toBeLessThan(0);expect((await f.store.list())[0]?.operationKind).toBe('producer.create');
  const backup=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany((await f.store.list()).map(row=>row.opId));
  const cold=f.cold();await cold.restorePendingWork!(backup);await cold.preferOfflineSnapshot!();
  expect((await cold.getAuthor(id)).occupation).toBe('Artist');expect((await cold.queryProducerPage(producerPageQueryRequestSchema.parse({}))).items).toEqual([expect.objectContaining({id:f.author.id})]);
  await cold.updateAuthor(id,{content:'Edited profile'});await cold.linkEntryAuthor(f.survivor.id,id);
  const originals=(await f.store.list()).map(originalMutationEnvelope);f.connect();f.loseReplay();await cold.flushOfflineOutbox!();
  expect(f.db.prepare("SELECT count(*) FROM producers WHERE name='Standalone'").pluck().get()).toBe(1);
  const retry=f.cold();f.loseAck();await retry.flushOfflineOutbox!();expect((await f.store.list()).length).toBeGreaterThan(0);
  await retry.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  const numeric=Number(f.db.prepare("SELECT id FROM producers WHERE name='Standalone'").pluck().get());
  expect(numeric).toBeGreaterThan(0);expect((await f.online.getAuthor(numeric)).content).toBe('Edited profile');
  expect(f.db.prepare('SELECT count(*) FROM entry_producers WHERE entry_id=? AND producer_id=?').pluck().get(f.survivor.id,numeric)).toBe(1);
  expect(f.bodies.map(body=>JSON.parse(body)).filter(body=>body.opId===originals[0]!.opId)).toEqual([originals[0],originals[0],originals[0]]);
 }finally{f.close();}
});
