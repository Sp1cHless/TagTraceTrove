// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import EntryStatsRow from '../src/components/EntryStatsRow.vue';
import AuthorPage from '../src/AuthorPage.vue';
import { createOfflineAwareGalleryApi } from '../src/offline/offline-api.js';
import { createMemoryOfflineStore } from '../src/offline/memory-offline-store.js';
import type { GalleryApi } from '../src/api/gallery.js';
import { offlineSnapshot } from './fixtures/pending-entry-tags.js';
import { setLocale } from '../src/i18n.js';
async function setup(){
 setLocale('en');vi.stubGlobal('scrollTo',vi.fn());
 const store=createMemoryOfflineStore(),snapshot=offlineSnapshot(); snapshot.header.sqliteSchemaVersion=41;
 snapshot.payload.entries[0]!.durationSeconds=470;snapshot.payload.producers[0]!.galleryAnchor='game';
 snapshot.payload.ratingLayouts!.push({syncUid:'33333333-3333-4333-8333-333333333333',syncVersion:1,subjectKind:'author_self',entryType:'game'});
 await store.writeGeneration(1,JSON.stringify(snapshot));await store.writeMeta('activeGeneration','1');
 for(const flag of ['offlineMutations','offlineEntryDuration','offlineAuthorSelfRatings','offlineRatingSlotDelete','offlineRatingSlotLayout','offlineProducerRating','offlineProducerProfile','offlineUsageEvents'])await store.writeMeta(`capability.${flag}`,'1');
 const api=createOfflineAwareGalleryApi({assetUrl:(p:string)=>p} as GalleryApi,store,{clientId:'ui-phone'});await api.preferOfflineSnapshot!();return{api,store};
}
it('touch duration actual facade rejects invalid, stores 0/clear and Enter plus blur queues once',async()=>{
 const {api,store}=await setup();vi.stubGlobal('matchMedia',()=>({matches:true}));
 const wrapper=mount(EntryStatsRow,{props:{api,entryId:1,pageCount:12,durationSeconds:470,uploadDate:null,editing:true,showEmpty:true}});
 try {
  await wrapper.get('[data-testid="duration-value"]').trigger('click');await wrapper.get('[data-testid="duration-input"]').setValue('bad');
  await wrapper.get('[data-testid="duration-input"]').trigger('keydown',{key:'Enter'});await flushPromises();expect(await store.list()).toEqual([]);
  await wrapper.get('[data-testid="duration-input"]').setValue('0');
  const editor=wrapper.get('[data-testid="duration-input"]');await editor.trigger('keydown',{key:'Enter'});await editor.trigger('blur');await flushPromises();
  expect(await store.list()).toHaveLength(1);expect((await store.list())[0]!.payload).toEqual({durationSeconds:0});
  await wrapper.setProps({durationSeconds:0});await wrapper.get('[data-testid="duration-value"]').trigger('click');await wrapper.get('[data-testid="duration-input"]').setValue('');await wrapper.get('[data-testid="duration-input"]').trigger('blur');await flushPromises();
  expect((await store.list())[1]!.payload).toEqual({durationSeconds:null});expect(wrapper.emitted('saved')).toHaveLength(2);
  await wrapper.setProps({durationSeconds:null});await wrapper.get('[data-testid="add-duration"]').trigger('click');await wrapper.get('[data-testid="duration-input"]').setValue('7:50');await wrapper.get('[data-testid="duration-input"]').trigger('keydown',{key:'Enter'});await flushPromises();expect((await store.list())[2]!.payload).toEqual({durationSeconds:470});
 }finally{wrapper.unmount();vi.unstubAllGlobals();}
});
it('AuthorPage self group saves half-star through actual facade without writing works-summary partition',async()=>{
 const {api,store}=await setup();const wrapper=mount(AuthorPage,{props:{api,authors:[{id:9,name:'Offline Author',covers:[],galleryType:'game',viewCount:0,likeCount:0,lastViewedAt:null,nsfw:false}]}});
 try {
  await flushPromises();await wrapper.get('[data-author-id="9"]').trigger('click');await flushPromises();await wrapper.get('[data-testid="start-author-editing"]').trigger('click');await flushPromises();
  expect(wrapper.get('.author-ratings-board').findAll('[data-rating-class]').map(row=>row.attributes('data-rating-class'))).toEqual(['producer','author_self']);
  await wrapper.get('[data-testid="add-author-self-rating-button"]').trigger('click');await wrapper.get('[data-testid="create-author-self-rating-form"] input').setValue('Voice');await wrapper.get('[data-testid="create-author-self-rating-form"]').trigger('submit');await flushPromises();
  const row=wrapper.get('[data-testid="author-self-ratings"] [data-rating-slot-id]');await row.get('[data-set-stars="3.5"]').trigger('click');await flushPromises();
  const writes=(await store.list()).filter(row=>row.operationKind!=='producer.usage');expect(writes).toHaveLength(2);expect(writes.map(row=>row.payload.subjectKind)).toEqual(['author_self','author_self']);
  expect((await api.getAuthor(9)).ratings).toEqual([]);expect((await api.getAuthor(9)).authorSelfRatings).toMatchObject([{name:'Voice',stars:3.5}]);
 }finally{wrapper.unmount();vi.unstubAllGlobals();}
});
