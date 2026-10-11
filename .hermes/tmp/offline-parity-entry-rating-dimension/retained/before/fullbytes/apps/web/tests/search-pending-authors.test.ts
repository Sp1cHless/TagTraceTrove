// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SearchPage from '../src/SearchPage.vue';
import type { GalleryApi, PendingOfflineEntryCreate } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';

enableAutoUnmount(afterEach);
beforeEach(() => setLocale('en'));
const key = 'local:22222222-2222-4222-8222-222222222222';
const uid = '33333333-3333-4333-8333-333333333333';
const newUid = '44444444-4444-4444-8444-444444444444';
function fixture(overrides: Partial<PendingOfflineEntryCreate> = {}, canCreate = false) {
  const entry: PendingOfflineEntryCreate = { localKey: key, title: 'Draft work', type: 'game', uploadDate: null, pageCount: null,
    status: 'pending', canEditAuthors: true, canAppendContent: true, authors: [], ...overrides };
  const api = {
    enqueueOfflinePendingEntryContent: vi.fn().mockResolvedValue(undefined),
    listTaxonomyAliases: vi.fn().mockResolvedValue([]),
    queryEntryPage: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 }),
    listPendingOfflineEntryCreates: vi.fn().mockImplementation(async () => [{ ...entry }]),
    getPendingOfflineEntryAuthorOptions: vi.fn().mockResolvedValue({ canCreateAuthor: canCreate, authors: [{ producerUid: uid, name: 'Alice' }] }),
    enqueueOfflinePendingEntryAuthorCreate: vi.fn().mockImplementation(async (_key: string, name: string) => {
      const author = { producerUid: newUid, name };
      entry.authors = [...(entry.authors ?? []), author];
      return author;
    }),
    enqueueOfflinePendingEntryAuthors: vi.fn().mockImplementation(async (_key: string, values: string[]) => {
      entry.authors = values.map(producerUid => ({ producerUid, name: 'Alice' }));
    }),
  };
  const wrapper = mount(SearchPage, { props: { api: api as unknown as GalleryApi,
    initialQuery: 'Draft', initialScope: 'entries', nsfwEntryTypes: [] }, global: { stubs: { PagedCardGrid: true } } });
  return { wrapper, api, entry };
}

it('creates a new Author through the actual pending Search editor callback', async () => {
  const { wrapper, api } = fixture({}, true);
  await flushPromises();
  await wrapper.get('[data-testid="pending-edit-authors"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="pending-author-new-name"]').setValue('  New Author  ');
  await wrapper.get('[data-testid="pending-author-create"]').trigger('click');
  await flushPromises();
  expect(api.enqueueOfflinePendingEntryAuthorCreate).toHaveBeenCalledWith(key, 'New Author');
  expect(wrapper.get('[data-testid="pending-author-summary"]').text()).toContain('New Author');
  expect(wrapper.find('[data-testid="pending-author-form"]').exists()).toBe(false);
  expect(wrapper.emitted('open-entry')).toBeUndefined();
});

it('retains a rejected new-Author name for retry without calling the link-set path', async () => {
  const { wrapper, api } = fixture({}, true);
  api.enqueueOfflinePendingEntryAuthorCreate.mockRejectedValueOnce(new Error('Author name already exists'));
  await flushPromises();
  await wrapper.get('[data-testid="pending-edit-authors"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="pending-author-new-name"]').setValue('New Author');
  await wrapper.get('[data-testid="pending-author-create"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-testid="pending-author-error"]').text()).toContain('Author name already exists');
  expect((wrapper.get('[data-testid="pending-author-new-name"]').element as HTMLInputElement).value).toBe('New Author');
  expect(api.enqueueOfflinePendingEntryAuthors).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="pending-author-create"]').trigger('click');
  await flushPromises();
  expect(api.enqueueOfflinePendingEntryAuthorCreate).toHaveBeenCalledTimes(2);
});

it('shows a committed new Author with a warning when projection refresh fails', async () => {
  const { wrapper, api } = fixture({}, true);
  await flushPromises();
  await wrapper.get('[data-testid="pending-edit-authors"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="pending-author-new-name"]').setValue('New Author');
  api.listPendingOfflineEntryCreates.mockRejectedValueOnce(new Error('read failed'));
  await wrapper.get('[data-testid="pending-author-create"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-testid="pending-author-form"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="pending-author-summary"]').text()).toContain('New Author');
  expect(wrapper.get('[role="alert"]').text()).toContain('Authors saved offline');
  expect(api.enqueueOfflinePendingEntryAuthorCreate).toHaveBeenCalledTimes(1);
});

it('retains the page-owned create lock across Search unmount and rejects repeated clicks', async () => {
  const { wrapper, api } = fixture({}, true);
  let finish!: (value: { producerUid: string; name: string }) => void;
  api.enqueueOfflinePendingEntryAuthorCreate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await flushPromises();
  await wrapper.get('[data-testid="pending-edit-authors"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="pending-author-new-name"]').setValue('New Author');
  await wrapper.get('[data-testid="pending-author-create"]').trigger('click');
  await wrapper.get('[data-testid="pending-author-create"]').trigger('click');
  expect(api.enqueueOfflinePendingEntryAuthorCreate).toHaveBeenCalledTimes(1);
  expect(wrapper.get('[data-testid="pending-add-content"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-testid="search-main-input"]').setValue('');
  await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
  expect(wrapper.find('[data-testid="pending-author-form"]').exists()).toBe(false);
  finish({ producerUid: uid, name: 'New Author' });
  await flushPromises();
  await wrapper.get('[data-testid="search-main-input"]').setValue('Draft');
  await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
  await flushPromises();
  expect(wrapper.get('[data-testid="pending-edit-authors"]').attributes('disabled')).toBeUndefined();
});

it('hides new-Author creation when the persisted gate is missing', async () => {
  const { wrapper } = fixture();
  await flushPromises();
  await wrapper.get('[data-testid="pending-edit-authors"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-testid="pending-author-create"]').exists()).toBe(false);
});

it('hides new-Author creation when the facade has no create method', async () => {
  const { wrapper, api } = fixture({}, true);
  await wrapper.setProps({ api: { ...api, enqueueOfflinePendingEntryAuthorCreate: undefined } as unknown as GalleryApi });
  await flushPromises();
  await wrapper.get('[data-testid="pending-edit-authors"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-testid="pending-author-create"]').exists()).toBe(false);
});

it('links and removes a cached Author through the pending Search card without opening an Entry route', async () => {
  const { wrapper, api } = fixture();
  await flushPromises();
  expect(wrapper.find('[data-testid="pending-edit-authors"]').exists()).toBe(true);
  await wrapper.get('[data-testid="pending-edit-authors"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="pending-author-query"]').setValue('Ali');
  await wrapper.get('[data-testid="pending-author-option"]').trigger('click');
  await wrapper.get('[data-testid="pending-author-form"]').trigger('submit');
  await flushPromises();
  expect(api.enqueueOfflinePendingEntryAuthors).toHaveBeenCalledWith(key, [uid]);
  expect(wrapper.get('[data-testid="pending-author-summary"]').text()).toContain('Alice');
  expect(wrapper.emitted('open-entry')).toBeUndefined();
  await wrapper.get('[data-testid="pending-edit-authors"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="pending-author-remove"]').trigger('click');
  await wrapper.get('[data-testid="pending-author-form"]').trigger('submit');
  await flushPromises();
  expect(api.enqueueOfflinePendingEntryAuthors).toHaveBeenLastCalledWith(key, []);
  expect(api.enqueueOfflinePendingEntryAuthors).toHaveBeenCalledTimes(2);
});

it('switches from Author editing to Content without retaining a second editor', async () => {
  const { wrapper } = fixture();
  await flushPromises();
  await wrapper.get('[data-testid="pending-edit-authors"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-testid="pending-author-form"]').exists()).toBe(true);
  await wrapper.get('[data-testid="pending-add-content"]').trigger('click');
  expect(wrapper.find('[data-testid="pending-author-form"]').exists()).toBe(false);
  expect(wrapper.find('[data-testid="pending-content-submit"]').exists()).toBe(true);
});

it.each(['failed', 'conflict'] as const)('shows child %s independently and hides blocked editing', async status => {
  const { wrapper } = fixture({ authorStatus: status, authorLastError: '<blocked child>', canEditAuthors: false });
  await flushPromises();
  expect(wrapper.get('[data-testid="pending-author-status"]').text()).toContain(status === 'failed' ? 'Sync failed' : 'Sync conflict');
  expect(wrapper.get('[data-testid="pending-author-status-error"]').text()).toBe('<blocked child>');
  expect(wrapper.find('[data-testid="pending-edit-authors"]').exists()).toBe(false);
  expect(wrapper.html()).toContain('&lt;blocked child&gt;');
});

it('does not reopen a committed editor when only the projection refresh fails', async () => {
  const { wrapper, api } = fixture();
  await flushPromises();
  await wrapper.get('[data-testid="pending-edit-authors"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="pending-author-query"]').setValue('Ali');
  await wrapper.get('[data-testid="pending-author-option"]').trigger('click');
  api.listPendingOfflineEntryCreates.mockRejectedValueOnce(new Error('read failed'));
  await wrapper.get('[data-testid="pending-author-form"]').trigger('submit');
  await flushPromises();
  expect(wrapper.find('[data-testid="pending-author-form"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="pending-author-summary"]').text()).toContain('Alice');
  expect(wrapper.get('[role="alert"]').text()).toContain('Authors saved offline');
  expect(api.enqueueOfflinePendingEntryAuthors).toHaveBeenCalledTimes(1);
});

it('releases the page-owned write lock after Search unmounts the old editor', async () => {
  const { wrapper, api } = fixture();
  await flushPromises();
  let finish!: () => void;
  api.enqueueOfflinePendingEntryAuthors.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await wrapper.get('[data-testid="pending-edit-authors"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="pending-author-query"]').setValue('Ali');
  await wrapper.get('[data-testid="pending-author-option"]').trigger('click');
  await wrapper.get('[data-testid="pending-author-form"]').trigger('submit');
  await wrapper.get('[data-testid="search-main-input"]').setValue('');
  await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
  expect(wrapper.find('[data-testid="pending-author-form"]').exists()).toBe(false);
  finish();
  await flushPromises();
  await wrapper.get('[data-testid="search-main-input"]').setValue('Draft');
  await wrapper.get('[data-testid="search-main-form"]').trigger('submit');
  await flushPromises();
  expect(wrapper.get('[data-testid="pending-edit-authors"]').attributes('disabled')).toBeUndefined();
  await wrapper.get('[data-testid="pending-edit-authors"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-testid="pending-author-form"]').exists()).toBe(true);
});
