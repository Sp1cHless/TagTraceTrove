// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SearchPage from '../src/SearchPage.vue';
import type { GalleryApi } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';
enableAutoUnmount(afterEach);
beforeEach(() => setLocale('en'));
const localKey = 'local:22222222-2222-4222-8222-222222222222';
const contentUid = '33333333-3333-4333-8333-333333333333';
const laterUid = '44444444-4444-4444-8444-444444444444';
type Row = { syncUid: string; contentType: string; content: string; sortOrder: number };
function fixture() {
  let contents: Row[] = [
    { syncUid: contentUid, contentType: 'Notes', content: 'initial', sortOrder: 0 },
    { syncUid: laterUid, contentType: 'Notes', content: 'later appended', sortOrder: 1 },
  ];
  const api = {
    listTaxonomyAliases: vi.fn().mockResolvedValue([]),
    queryEntryPage: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 }),
    listPendingOfflineEntryCreates: vi.fn().mockImplementation(async () => [{ localKey, title: 'Draft content', type: 'game',
      uploadDate: null, pageCount: null, status: 'pending', canEditContents: true, canEditMetadata: true, canAppendContent: true, contents: structuredClone(contents) }]),
    enqueueOfflinePendingEntryMetadata: vi.fn().mockResolvedValue(undefined),
    enqueueOfflinePendingEntryContent: vi.fn().mockResolvedValue(undefined),
    getPendingOfflineEntryContentOptions: vi.fn().mockImplementation(async () => ({ contents: structuredClone(contents) })),
    enqueueOfflinePendingEntryContents: vi.fn().mockImplementation(async (_key: string, rows: Row[]) => { contents = structuredClone(rows); }),
  };
  const wrapper = mount(SearchPage, { props: { api: api as unknown as GalleryApi, initialQuery: 'Draft',
    initialScope: 'entries', nsfwEntryTypes: [] }, global: { stubs: { PagedCardGrid: true } } });
  return { wrapper, api };
}
it('edits initial Content and removes an appended Content row through the pending Search card', async () => {
  const { wrapper, api } = fixture();
  await flushPromises();
  expect(wrapper.find('[data-testid="pending-edit-contents"]').exists()).toBe(true);
  await wrapper.get('[data-testid="pending-edit-contents"]').trigger('click');
  await flushPromises();
  await wrapper.get(`[data-testid="pending-content-text-${contentUid}"]`).setValue('edited initial');
  await wrapper.get(`[data-testid="pending-content-remove-${laterUid}"]`).trigger('click');
  expect(wrapper.get(`[data-testid="pending-content-text-${laterUid}"]`).element).toHaveProperty('value', 'later appended');
  await wrapper.get('[data-testid="pending-content-confirm-remove"]').trigger('click');
  await wrapper.get('[data-testid="pending-contents-form"]').trigger('submit');
  await flushPromises();
  expect(api.enqueueOfflinePendingEntryContents).toHaveBeenCalledWith(localKey,
    [{ syncUid: contentUid, contentType: 'Notes', content: 'edited initial', sortOrder: 0 }]);
  expect(wrapper.text()).toContain('edited initial');
  expect(wrapper.text()).not.toContain('later appended');
  expect(wrapper.find('[data-testid="pending-contents-form"]').exists()).toBe(false);
  expect(wrapper.emitted('open-entry')).toBeUndefined();
});

it('keeps committed Content changes visible if only projection refresh fails', async () => {
  const { wrapper, api } = fixture(); await flushPromises();
  await wrapper.get('[data-testid="pending-edit-contents"]').trigger('click'); await flushPromises();
  await wrapper.get(`[data-testid="pending-content-text-${contentUid}"]`).setValue('committed edit');
  api.listPendingOfflineEntryCreates.mockRejectedValueOnce(new Error('read failed'));
  await wrapper.get('[data-testid="pending-contents-form"]').trigger('submit'); await flushPromises();
  expect(wrapper.find('[data-testid="pending-contents-form"]').exists()).toBe(false);
  expect(wrapper.text()).toContain('committed edit');
  expect(wrapper.get('[role="alert"]').text()).toContain('Content saved offline');
  expect(api.enqueueOfflinePendingEntryContents).toHaveBeenCalledTimes(1);
});

it.each(['pending-edit-metadata', 'pending-add-content'])('closes the Content editor when switching to %s', async control => {
  const { wrapper } = fixture(); await flushPromises();
  await wrapper.get('[data-testid="pending-edit-contents"]').trigger('click'); await flushPromises();
  expect(wrapper.find('[data-testid="pending-contents-form"]').exists()).toBe(true);
  await wrapper.get(`[data-testid="${control}"]`).trigger('click'); await flushPromises();
  expect(wrapper.find('[data-testid="pending-contents-form"]').exists()).toBe(false);
});

it('retains the page-level Content write lock after Search unmount', async () => {
  const { wrapper, api } = fixture(); await flushPromises();
  let finish!: () => void;
  api.enqueueOfflinePendingEntryContents.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await wrapper.get('[data-testid="pending-edit-contents"]').trigger('click'); await flushPromises();
  await wrapper.get(`[data-testid="pending-content-text-${contentUid}"]`).setValue('changed');
  await wrapper.get('[data-testid="pending-contents-form"]').trigger('submit');
  expect(wrapper.get('[data-testid="pending-edit-metadata"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="pending-add-content"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-testid="search-main-input"]').setValue('');
  await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
  expect(wrapper.find('[data-testid="pending-contents-form"]').exists()).toBe(false);
  await wrapper.get('[data-testid="search-main-input"]').setValue('Draft');
  await wrapper.get('[data-testid="search-main-form"]').trigger('submit'); await flushPromises();
  expect(wrapper.get('[data-testid="pending-edit-contents"]').attributes('disabled')).toBeDefined();
  finish(); await flushPromises();
  expect(wrapper.get('[data-testid="pending-edit-contents"]').attributes('disabled')).toBeUndefined();
});
