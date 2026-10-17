// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { GalleryApi } from '../src/api/gallery.js';
import { createMemorySnapshotStore } from '../src/offline/snapshot-store.js';
import type { OfflineApiState } from '../src/offline/offline-api.js';
import { createAutomaticOfflineSync } from '../src/offline/automatic-sync.js';
import OfflineLibrarySettings from '../src/components/OfflineLibrarySettings.vue';
const download = vi.hoisted(() => vi.fn());
vi.mock('../src/offline/offline-sync.js', () => ({ downloadOfflineSnapshot: download, clearOfflineSnapshot: vi.fn() }));
const snapshot = { header: { libraryId:'library',syncEpoch:'epoch',snapshotSeq:1,changeSeq:0,generatedAt:'2026-10-12',sqliteSchemaVersion:41,snapshotFormatVersion:2,counts:{entries:0,producers:0,entryContents:0,entryTags:0,collections:0},checksum:'stored' },
  payload:{entries:[],producers:[],entryProducers:[],tags:[],tagGroups:[],entryTags:[],producerTags:[],producerTagAssignments:[],entryContents:[],ratingSlots:[],entryRatingValues:[],producerRatingValues:[],collections:[],collectionMembers:[],authorDirectories:[],authorDirectoryEntries:[],entryUsage:[],viewLaterEntries:[],viewLaterProducers:[],gallerySettings:[],mediaRefs:[]} };
async function fixture(saved = true) {
  const store=createMemorySnapshotStore();
  if(saved){await store.writeGeneration(1,JSON.stringify(snapshot));await store.writeMeta('activeGeneration','1');}
  const state:OfflineApiState={mode:'online',lastFallbackAt:null,pendingCount:0};
  const api={flushOfflineOutbox:vi.fn(async()=>{state.pendingCount=0;}),getSyncCapabilities:vi.fn(async()=>({})),assetUrl:(ref:string)=>ref} as unknown as GalleryApi;
  download.mockResolvedValue({ok:true,active:{generationId:2,revision:'2',snapshot}});
  return {store,state,api,sync:createAutomaticOfflineSync({store,state,api})};
}
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();});
it('automatic offline UX syncs before refreshing even without queued edits, and stays silent on idle heartbeats',async()=>{
  const f=await fixture();const phases:string[]=[];
  f.api.flushOfflineOutbox=vi.fn(async()=>{phases.push(f.state.automaticSyncPhase!);});
  download.mockImplementationOnce(async()=>{phases.push(f.state.automaticSyncPhase!);return {ok:true,active:{generationId:2,revision:'2',snapshot}};});
  await f.sync(true);expect(phases).toEqual(['syncing','updating']);expect(f.state.offlineCopyRevision).toBe('2');expect(f.state.automaticSyncPhase).toBeNull();
  await f.sync(false);expect(download).toHaveBeenCalledOnce();expect(f.api.flushOfflineOutbox).toHaveBeenCalledOnce();
});
it('automatic offline UX retains a failed refresh for the next verified heartbeat without stacking work',async()=>{
  const f=await fixture();let finish!:(value:unknown)=>void;
  download.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const first=f.sync(true);await flushPromises();const second=f.sync(true);expect(first).toBe(second);
  finish({ok:false,reason:'network',detail:'Disconnected'});await first;
  expect(f.state.lastAutomaticSyncError).toBe('Disconnected');expect(f.state.automaticSyncPhase).toBeNull();
  await f.sync(false);expect(download).toHaveBeenCalledTimes(2);expect(f.state.lastAutomaticSyncError).toBeNull();
});
it('automatic offline UX preserves first download choice and does not replace a copy with unresolved edits',async()=>{
  const empty=await fixture(false);await empty.sync(true);expect(download).not.toHaveBeenCalled();
  const f=await fixture();f.state.lastReplayError='Conflict';await f.sync(true);
  expect(download).not.toHaveBeenCalled();expect(f.state.lastAutomaticSyncError).toBe('Conflict');
});
it('automatic offline UX checks support and storage automatically and removes the obsolete manual tools',async()=>{
  const f=await fixture();await f.store.writeMeta('capability.offlineEntryContents','1');
  const persist=vi.fn(async()=>true),estimate=vi.fn(async()=>({usage:1048576,quota:10485760}));
  vi.stubGlobal('navigator',{storage:{persist,estimate}});
  const wrapper=mount(OfflineLibrarySettings,{props:{api:f.api,store:f.store,online:true},slots:{diagnostics:'<button data-testid="copy-report">Copy report</button>'}});
  await flushPromises();expect(f.api.getSyncCapabilities).toHaveBeenCalledOnce();expect(persist).toHaveBeenCalledOnce();
  expect(wrapper.get('[data-testid="offline-download"]').text()).toContain('Update');
  for(const id of ['offline-sync-now','offline-export-pending','offline-restore-file','offline-check-support','offline-request-persistence','native-transfer-resume'])expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false);
  expect(wrapper.get('[data-testid="offline-system-information"]').text()).toContain('Persistence granted');
  expect(wrapper.find('[data-testid="copy-report"]').exists()).toBe(true);
  await wrapper.setProps({online:false});await flushPromises();expect(f.api.getSyncCapabilities).toHaveBeenCalledOnce();wrapper.unmount();
});
