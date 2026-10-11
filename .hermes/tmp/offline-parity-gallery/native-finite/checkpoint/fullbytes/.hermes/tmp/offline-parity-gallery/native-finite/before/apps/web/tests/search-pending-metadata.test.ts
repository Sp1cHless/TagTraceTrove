// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SearchPage from '../src/SearchPage.vue';
import type { GalleryApi, PendingOfflineEntryCreate } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';
enableAutoUnmount(afterEach);
beforeEach(() => setLocale('en'));
const key = 'local:22222222-2222-4222-8222-222222222222';
function fixture(overrides: Partial<PendingOfflineEntryCreate> = {}) {
  const entry: PendingOfflineEntryCreate = { localKey: key, title: 'Draft work', type: 'game', uploadDate: null,
    pageCount: null, status: 'pending', canEditMetadata: true, canEditAuthors: true, canEditTags: true, canAppendContent: true, ...overrides };
  const api = {
    getPendingOfflineEntryAuthorOptions: vi.fn().mockResolvedValue({ authors: [] }),
    enqueueOfflinePendingEntryAuthors: vi.fn().mockResolvedValue(undefined),
    getPendingOfflineEntryTagOptions: vi.fn().mockResolvedValue({ facets: [{ id: 1, name: 'Tags' }], tags: [], availableTags: [] }),
    enqueueOfflinePendingEntryTags: vi.fn().mockResolvedValue(undefined),
    enqueueOfflinePendingEntryContent: vi.fn().mockResolvedValue(undefined),
    listTaxonomyAliases: vi.fn().mockResolvedValue([]),
    queryEntryPage: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 }),
    listPendingOfflineEntryCreates: vi.fn().mockImplementation(async () => [{ ...entry }]),
    enqueueOfflinePendingEntryMetadata: vi.fn().mockImplementation(async (_key: string, values: { title: string; uploadDate: string | null; pageCount: number | null }) => { Object.assign(entry, values); }),
  };
  const wrapper = mount(SearchPage, { props: { api: api as unknown as GalleryApi,
    initialQuery: 'Draft', initialScope: 'entries', nsfwEntryTypes: [] }, global: { stubs: { PagedCardGrid: true } } });
  return { wrapper, api, entry };
}
it('edits title upload date and page count on the pending Search card', async () => {
  const { wrapper, api } = fixture();
  await flushPromises();
  expect(wrapper.find('[data-testid="pending-edit-metadata"]').exists()).toBe(true);
  await wrapper.get('[data-testid="pending-edit-metadata"]').trigger('click');
  await wrapper.get('[data-testid="pending-metadata-title"]').setValue('Draft revised');
  await wrapper.get('[data-testid="pending-metadata-date"]').setValue('2026-10-01');
  await wrapper.get('[data-testid="pending-metadata-pages"]').setValue('0');
  await wrapper.get('[data-testid="pending-metadata-form"]').trigger('submit');
  await flushPromises();
  expect(api.enqueueOfflinePendingEntryMetadata).toHaveBeenCalledWith(key, { title: 'Draft revised', uploadDate: '2026-10-01', pageCount: 0 });
  expect(wrapper.text()).toContain('Draft revised');
  expect(wrapper.find('[data-testid="pending-metadata-form"]').exists()).toBe(false);
  expect(wrapper.emitted('open-entry')).toBeUndefined();
  await wrapper.get('[data-testid="pending-edit-metadata"]').trigger('click');
  await wrapper.get('[data-testid="pending-metadata-date"]').setValue('');
  await wrapper.get('[data-testid="pending-metadata-pages"]').setValue('');
  await wrapper.get('[data-testid="pending-metadata-form"]').trigger('submit');
  await flushPromises();
  expect(api.enqueueOfflinePendingEntryMetadata).toHaveBeenLastCalledWith(key, { title: 'Draft revised', uploadDate: null, pageCount: null });
});

it.each(['pending-add-content', 'pending-edit-tags', 'pending-edit-authors'])('keeps only one editor open when switching from metadata to %s', async control => {
  const { wrapper } = fixture();
  await flushPromises();
  await wrapper.get('[data-testid="pending-edit-metadata"]').trigger('click');
  expect(wrapper.find('[data-testid="pending-metadata-form"]').exists()).toBe(true);
  await wrapper.get(`[data-testid="${control}"]`).trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-testid="pending-metadata-form"]').exists()).toBe(false);
});

it('keeps a committed title visible with a warning if only projection refresh fails', async () => {
  const { wrapper, api } = fixture();
  await flushPromises();
  await wrapper.get('[data-testid="pending-edit-metadata"]').trigger('click');
  await wrapper.get('[data-testid="pending-metadata-title"]').setValue('Revised draft');
  api.listPendingOfflineEntryCreates.mockRejectedValueOnce(new Error('read failed'));
  await wrapper.get('[data-testid="pending-metadata-form"]').trigger('submit');
  await flushPromises();
  expect(wrapper.find('[data-testid="pending-metadata-form"]').exists()).toBe(false);
  expect(wrapper.text()).toContain('Revised draft');
  expect(wrapper.get('[role="alert"]').text()).toContain('Basic information saved offline');
  expect(api.enqueueOfflinePendingEntryMetadata).toHaveBeenCalledTimes(1);
});

it.each(['failed', 'conflict'] as const)('shows metadata child %s without changing the parent state', async status => {
  const { wrapper } = fixture({ metadataEditStatus: status, metadataEditError: '<review>', canEditMetadata: false });
  await flushPromises();
  expect(wrapper.get('[data-testid="pending-metadata-status"]').text()).toContain(status === 'failed' ? 'Sync failed' : 'Sync conflict');
  expect(wrapper.get('[data-testid="pending-metadata-status-error"]').text()).toBe('<review>');
  expect(wrapper.html()).toContain('&lt;review&gt;');
  expect(wrapper.find('[data-testid="pending-edit-metadata"]').exists()).toBe(false);
});

it('retains the page-level write lock across Search unmount and releases it after commitment', async () => {
  const { wrapper, api } = fixture();
  await flushPromises();
  let finish!: () => void;
  api.enqueueOfflinePendingEntryMetadata.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await wrapper.get('[data-testid="pending-edit-metadata"]').trigger('click');
  await wrapper.get('[data-testid="pending-metadata-title"]').setValue('Draft revised');
  await wrapper.get('[data-testid="pending-metadata-form"]').trigger('submit');
  expect(wrapper.get('[data-testid="pending-edit-authors"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="pending-edit-tags"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-testid="pending-add-content"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-testid="search-main-input"]').setValue('');
  await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
  expect(wrapper.find('[data-testid="pending-metadata-form"]').exists()).toBe(false);
  finish(); await flushPromises();
  await wrapper.get('[data-testid="search-main-input"]').setValue('Draft');
  await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
  await flushPromises();
  expect(wrapper.get('[data-testid="pending-edit-metadata"]').attributes('disabled')).toBeUndefined();
});

