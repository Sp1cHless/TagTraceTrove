// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PendingEntryContentEditor from '../src/components/PendingEntryContentEditor.vue';
import type { GalleryApi, PendingOfflineEntryCreate } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';
enableAutoUnmount(afterEach);
beforeEach(() => setLocale('en'));
const uid = '33333333-3333-4333-8333-333333333333';
const row = { syncUid: uid, contentType: 'Notes', content: 'initial', sortOrder: 0 };
function fixture(overrides: Partial<PendingOfflineEntryCreate> = {}, options?: Promise<{ contents: Array<typeof row> }>) {
  const entry = { localKey: 'local:22222222-2222-4222-8222-222222222222', title: 'Draft', type: 'game',
    uploadDate: null, pageCount: null, status: 'pending', canEditContents: true, ...overrides } as PendingOfflineEntryCreate;
  const api = { getPendingOfflineEntryContentOptions: vi.fn().mockImplementation(() => options ?? Promise.resolve({ contents: [{ ...row }] })) };
  const saveContents = vi.fn().mockResolvedValue(undefined);
  const wrapper = mount(PendingEntryContentEditor, { props: { api: api as unknown as GalleryApi, entry, saveContents } });
  return { wrapper, saveContents, api };
}
it('keeps failed edited Content and permits an explicit retry', async () => {
  const { wrapper, saveContents } = fixture(); await flushPromises();
  saveContents.mockRejectedValueOnce(new Error('Outbox failed'));
  await wrapper.get(`[data-testid="pending-content-text-${uid}"]`).setValue('edited');
  await wrapper.get('[data-testid="pending-contents-form"]').trigger('submit'); await flushPromises();
  expect(wrapper.get('[data-testid="pending-contents-error"]').text()).toContain('Outbox failed');
  expect(wrapper.get(`[data-testid="pending-content-text-${uid}"]`).element).toHaveProperty('value', 'edited');
  expect(wrapper.emitted('saved')).toBeUndefined();
  await wrapper.get('[data-testid="pending-contents-form"]').trigger('submit'); await flushPromises();
  expect(saveContents).toHaveBeenCalledTimes(2);
  expect(wrapper.emitted('saved')).toEqual([[[{ ...row, content: 'edited' }]]]);
});
it('confirms all-row deletion and allows an empty desired set', async () => {
  const { wrapper, saveContents } = fixture(); await flushPromises();
  await wrapper.get(`[data-testid="pending-content-remove-${uid}"]`).trigger('click');
  await wrapper.get('[data-testid="pending-content-cancel-remove"]').trigger('click');
  expect(wrapper.find(`[data-testid="pending-content-text-${uid}"]`).exists()).toBe(true);
  await wrapper.get(`[data-testid="pending-content-remove-${uid}"]`).trigger('click');
  await wrapper.get('[data-testid="pending-contents-form"]').trigger('submit');
  expect(saveContents).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="pending-content-confirm-remove"]').trigger('click');
  expect(wrapper.get('[data-testid="pending-contents-empty"]').text()).toContain('All Content will be removed');
  await wrapper.get('[data-testid="pending-contents-form"]').trigger('submit'); await flushPromises();
  expect(saveContents).toHaveBeenCalledWith('local:22222222-2222-4222-8222-222222222222', []);
});
it('does not enqueue unchanged Content or repeat a committed save', async () => {
  const { wrapper, saveContents } = fixture(); await flushPromises();
  await wrapper.get('[data-testid="pending-contents-form"]').trigger('submit'); expect(saveContents).not.toHaveBeenCalled();
  await wrapper.get(`[data-testid="pending-content-type-${uid}"]`).setValue('Review');
  await wrapper.get('[data-testid="pending-contents-form"]').trigger('submit'); await flushPromises();
  await wrapper.get('[data-testid="pending-contents-form"]').trigger('submit'); expect(saveContents).toHaveBeenCalledTimes(1);
});
it.each(['type', 'text'])('rejects whitespace-only Content %s', async field => {
  const { wrapper, saveContents } = fixture(); await flushPromises();
  await wrapper.get(`[data-testid="pending-content-${field}-${uid}"]`).setValue('   ');
  await wrapper.get('[data-testid="pending-contents-form"]').trigger('submit'); expect(saveContents).not.toHaveBeenCalled();
});
it('does not emit a saved event from an editor unmounted while loading', async () => {
  let finish!: (value: { contents: Array<typeof row> }) => void;
  const options = new Promise<{ contents: Array<typeof row> }>(resolve => { finish = resolve; });
  const { wrapper, api } = fixture({}, options);
  expect(api.getPendingOfflineEntryContentOptions).toHaveBeenCalledTimes(1);
  expect(wrapper.find('[data-testid="pending-contents-form"]').exists()).toBe(false);
  wrapper.unmount();
  finish({ contents: [{ ...row }] }); await flushPromises();
  expect(wrapper.emitted('saved')).toBeUndefined();
});
it.each([{ status: 'failed' as const }, { status: 'conflict' as const }, { canEditContents: false }])('fails closed for %j', async overrides => {
  const { wrapper, api, saveContents } = fixture(overrides); await flushPromises();
  expect(wrapper.find('[data-testid="pending-contents-form"]').exists()).toBe(false);
  expect(api.getPendingOfflineEntryContentOptions).not.toHaveBeenCalled(); expect(saveContents).not.toHaveBeenCalled();
});
