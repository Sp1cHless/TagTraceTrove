// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { it, expect, vi } from 'vitest';
import OfflineLibrarySettings from '../src/components/OfflineLibrarySettings.vue';
import { createMemorySnapshotStore } from '../src/offline/snapshot-store.js';
it('declared Android API 24 handoff does not reference API-26-only java.nio.file',()=>{
 const source=readFileSync('spikes/001-android-webview-shell/android/app/src/main/java/com/speechless666/t3/spike/BackgroundTransferPlugin.java','utf8');
 expect(source).not.toContain('java.nio.file');
});
it('automatically probes support without manually resuming native transfers', async()=>{
 const resume=vi.fn(),probe=vi.fn();
 const wrapper=mount(OfflineLibrarySettings,{props:{store:createMemorySnapshotStore(),api:{assetUrl:(p:string)=>p,getSyncCapabilities:probe,fetchSyncSnapshot:vi.fn(),resumeNativeTransfers:resume} as never}});
 try {
  await flushPromises();expect(probe).toHaveBeenCalledExactlyOnceWith({replay:false});
  expect(wrapper.find('[data-testid="native-transfer-resume"]').exists()).toBe(false);
  expect(resume).not.toHaveBeenCalled();
 } finally {wrapper.unmount();}
});
it('shows saved editing support offline without scheduling or probing the native queue',async()=>{
 const store=createMemorySnapshotStore();
 await store.writeMeta('offlineCapabilityReport',JSON.stringify({featureFlags:{offlineMutations:true,offlineEntryUpdate:true,offlineEntryContents:true,offlineProducerProfile:false}}));
 const probe=vi.fn(),resume=vi.fn();
 const wrapper=mount(OfflineLibrarySettings,{props:{store,online:false,api:{assetUrl:(p:string)=>p,getSyncCapabilities:probe,fetchSyncSnapshot:vi.fn(),resumeNativeTransfers:resume} as never}});
 try {
  await flushPromises();expect(wrapper.get('[data-testid="offline-edit-support"]').text()).toMatch(/2.*3/u);
  expect(probe).not.toHaveBeenCalled();expect(resume).not.toHaveBeenCalled();
  expect(wrapper.get('[data-testid="offline-download"]').attributes('disabled')).toBeDefined();
 } finally {wrapper.unmount();}
});
it('keeps the diagnostic export slot reachable when the server capability probe fails',async()=>{
 const resume=vi.fn();
 const wrapper=mount(OfflineLibrarySettings,{props:{store:createMemorySnapshotStore(),api:{assetUrl:(p:string)=>p,getSyncCapabilities:vi.fn().mockRejectedValue(new Error('Server unavailable')),fetchSyncSnapshot:vi.fn(),resumeNativeTransfers:resume} as never},slots:{diagnostics:'<button data-testid="local-report">Copy local report</button>'}});
 try {
  await flushPromises();expect(wrapper.get('[data-testid="offline-status"]').text()).toContain('Server unavailable');
  expect(wrapper.get('[data-testid="offline-system-information"] button').text()).toBe('Copy local report');
  expect(resume).not.toHaveBeenCalled();
 } finally {wrapper.unmount();}
});
