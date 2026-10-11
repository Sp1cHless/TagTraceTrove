from safe_edit import edit
edit('apps/web/tests/offline-entry-delete.integration.test.ts',"import { expect, it } from 'vitest';", """import { expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import GalleryApp from '../src/GalleryApp.vue';
import { setLocale } from '../src/i18n.js';
vi.hoisted(async () => {
 const {JSDOM}=await import('jsdom');const window=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://isolated/'}).window;
 for(const key of ['window','document','Element','HTMLElement','SVGElement','Node','localStorage','sessionStorage','MutationObserver','navigator','getComputedStyle'])Object.defineProperty(globalThis,key,{value:key==='window'?window:window[key as keyof typeof window],configurable:true});
});
globalThis.addEventListener=window.addEventListener.bind(window);globalThis.removeEventListener=window.removeEventListener.bind(window);
const settle=async()=>{for(let i=0;i<15;i++){await flushPromises();await new Promise(resolve=>setTimeout(resolve,5));}};""")
edit('apps/web/tests/offline-entry-delete.integration.test.ts',"  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe(1);\n }finally{f.close();}\n});", """  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe(1);
 }finally{f.close();}
});
it('actual GalleryApp double-confirm uses durable offline deletion and returns to the correct Gallery with cold absence',async()=>{
 const f=await fixture();setLocale('en');vi.stubGlobal('scrollTo',vi.fn());const wrapper=mount(GalleryApp,{props:{api:f.current}});
 try{
  await settle();await wrapper.get('[data-gallery-type="comic"]').trigger('click');await settle();
  await wrapper.get(`[data-entry-id="${f.entry.id}"] .entry-card-main`).trigger('click');await settle();
  await wrapper.get('[data-testid="start-entry-editing"]').trigger('click');
  const button=wrapper.get('[data-testid="delete-entry"]');await button.trigger('click');expect(await f.store.list()).toEqual([]);
  await button.trigger('click');await settle();expect(await f.store.list()).toHaveLength(1);
  expect(wrapper.find('[data-testid="gallery-main"]').exists()).toBe(true);
  expect(wrapper.find(`[data-entry-id="${f.entry.id}"]`).exists()).toBe(false);expect(f.business).toEqual([]);
  const cold=f.cold();await cold.preferOfflineSnapshot!();expect((await cold.queryEntryPage(entryPageQueryRequestSchema.parse({entryType:'comic'}))).total).toBe(1);
 }finally{wrapper.unmount();f.close();vi.unstubAllGlobals();}
});""")
