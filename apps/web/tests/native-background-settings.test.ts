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
it('native-only Settings resume reads bounded native status and does not promise all-operation background coverage', async()=>{
 const resume=vi.fn(async()=>({active:1,completed:0,held:0,remainingOperations:2}));
 const wrapper=mount(OfflineLibrarySettings,{props:{store:createMemorySnapshotStore(), api:{assetUrl:(path:string)=>path,getSyncCapabilities:vi.fn(),fetchSyncSnapshot:vi.fn(),resumeNativeTransfers:resume} as never}});
 await flushPromises();expect(wrapper.find('[data-testid="native-transfer-resume"]').exists()).toBe(true);
 expect(wrapper.get('[data-testid="native-transfer-resume"]').text()).toBe('Resume supported queued edits and images');
 await wrapper.get('[data-testid="native-transfer-resume"]').trigger('click');await flushPromises();
 expect(resume).toHaveBeenCalledTimes(1);expect(wrapper.text()).toContain('2 foreground-only');wrapper.unmount();
});

it('Settings distinguishes dependency waiting from scheduled and names current capability/protocol fallback',async()=>{
 const resume=vi.fn(async()=>({active:1,completed:0,held:1,dependencyHeld:2,capabilityHeld:1,remainingOperations:1,foregroundReason:'Current required capability unavailable; original work retained'}));
 const wrapper=mount(OfflineLibrarySettings,{props:{store:createMemorySnapshotStore(),api:{assetUrl:(path:string)=>path,getSyncCapabilities:vi.fn(),fetchSyncSnapshot:vi.fn(),resumeNativeTransfers:resume} as never}});
 await flushPromises();await wrapper.get('[data-testid="native-transfer-resume"]').trigger('click');await flushPromises();
 expect(wrapper.text()).toContain('2 waiting for dependencies');expect(wrapper.text()).toContain('1 current-capability held');expect(wrapper.text()).toContain('Current required capability unavailable');wrapper.unmount();
});
it('native status includes standalone images and actionable oversize foreground fallback',async()=>{
 const resume=vi.fn(async()=>({active:0,completed:0,held:1,remainingOperations:0,standaloneMedia:3,foregroundMedia:1}));
 const wrapper=mount(OfflineLibrarySettings,{props:{store:createMemorySnapshotStore(),api:{assetUrl:(path:string)=>path,getSyncCapabilities:vi.fn(),fetchSyncSnapshot:vi.fn(),resumeNativeTransfers:resume} as never}});
 await flushPromises();await wrapper.get('[data-testid="native-transfer-resume"]').trigger('click');await flushPromises();
 expect(wrapper.text()).toContain('3 existing-Entry images');expect(wrapper.text()).toContain('1 images require foreground Update');expect(wrapper.text()).toContain('20 MiB');wrapper.unmount();
});
