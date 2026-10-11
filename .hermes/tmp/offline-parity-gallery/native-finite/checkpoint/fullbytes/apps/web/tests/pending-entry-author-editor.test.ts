// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PendingEntryAuthorEditor from '../src/components/PendingEntryAuthorEditor.vue';
import type { GalleryApi, PendingOfflineEntryCreate } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';

enableAutoUnmount(afterEach);
beforeEach(() => setLocale('en'));
const uid = '33333333-3333-4333-8333-333333333333';
function fixture(options: { empty?: boolean; blocked?: boolean; absentGate?: boolean; newGate?: boolean } = {}) {
  const api = { getPendingOfflineEntryAuthorOptions: vi.fn().mockResolvedValue({
    authors: options.empty ? [] : [{ producerUid: uid, name: 'Alice' }], canCreateAuthor: options.newGate === true,
  }) };
  const saveAuthors = vi.fn().mockResolvedValue(undefined);
  const createAuthor = vi.fn().mockResolvedValue({ producerUid: uid, name: 'New Author' });
  const entry: PendingOfflineEntryCreate = { localKey: 'local:22222222-2222-4222-8222-222222222222',
    title: 'Draft', type: 'game', uploadDate: null, pageCount: null,
    status: options.blocked ? 'conflict' : 'pending', canEditAuthors: !options.absentGate,
    authors: [{ producerUid: uid, name: 'Alice' }] };
  const wrapper = mount(PendingEntryAuthorEditor, { props: { api: api as unknown as GalleryApi, entry, saveAuthors, createAuthor } });
  return { wrapper, api, saveAuthors, createAuthor, entry };
}

it('requires saving changed links before creating an Author without discarding the selection draft', async () => {
  const { wrapper, createAuthor, saveAuthors } = fixture({ newGate: true });
  await flushPromises();
  await wrapper.get('[data-testid="pending-author-new-name"]').setValue('New Author');
  await wrapper.get('[data-testid="pending-author-remove"]').trigger('click');
  expect(wrapper.get('[data-testid="pending-author-create"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-testid="pending-author-create"]').trigger('click');
  expect(createAuthor).not.toHaveBeenCalled();
  expect(wrapper.findAll('[data-testid="pending-author-remove"]')).toHaveLength(0);
  await wrapper.get('[data-testid="pending-author-form"]').trigger('submit');
  await flushPromises();
  expect(saveAuthors).toHaveBeenCalledWith('local:22222222-2222-4222-8222-222222222222', []);
});

it('blocks a loaded new-Author form when the parent becomes conflicted', async () => {
  const { wrapper, createAuthor, entry } = fixture({ newGate: true });
  await flushPromises();
  await wrapper.get('[data-testid="pending-author-new-name"]').setValue('New Author');
  await wrapper.setProps({ entry: { ...entry, status: 'conflict', canEditAuthors: false } });
  await wrapper.get('[data-testid="pending-author-create"]').trigger('click');
  expect(createAuthor).not.toHaveBeenCalled();
});

it('keeps a rejected removal editable even when the cached options list is empty', async () => {
  const { wrapper, saveAuthors } = fixture({ empty: true });
  saveAuthors.mockRejectedValueOnce(new Error('Outbox write failed'));
  await flushPromises();
  await wrapper.get('[data-testid="pending-author-remove"]').trigger('click');
  await wrapper.get('[data-testid="pending-author-form"]').trigger('submit');
  await flushPromises();
  expect(wrapper.get('[data-testid="pending-author-error"]').text()).toContain('Outbox write failed');
  expect(wrapper.find('[data-testid="pending-author-form"]').exists()).toBe(true);
  await wrapper.get('[data-testid="pending-author-form"]').trigger('submit');
  await flushPromises();
  expect(saveAuthors).toHaveBeenCalledTimes(2);
  expect(saveAuthors).toHaveBeenLastCalledWith('local:22222222-2222-4222-8222-222222222222', []);
});

it('does not enqueue unchanged links or resubmit after a committed write', async () => {
  const { wrapper, saveAuthors } = fixture();
  await flushPromises();
  await wrapper.get('[data-testid="pending-author-form"]').trigger('submit');
  expect(saveAuthors).not.toHaveBeenCalled();
  await wrapper.get('[data-testid="pending-author-remove"]').trigger('click');
  await wrapper.get('[data-testid="pending-author-form"]').trigger('submit');
  await flushPromises();
  await wrapper.get('[data-testid="pending-author-form"]').trigger('submit');
  expect(saveAuthors).toHaveBeenCalledTimes(1);
});

it.each([{ blocked: true }, { absentGate: true }])('fails closed with blocked parent or missing gate %j', async options => {
  const { wrapper, api, saveAuthors } = fixture(options);
  await flushPromises();
  expect(api.getPendingOfflineEntryAuthorOptions).not.toHaveBeenCalled();
  expect(wrapper.find('[data-testid="pending-author-form"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="pending-author-error"]').text()).toContain('unavailable');
  expect(saveAuthors).not.toHaveBeenCalled();
});

it('filters only saved canonical names and excludes already selected identities', async () => {
  const { wrapper } = fixture();
  await flushPromises();
  await wrapper.get('[data-testid="pending-author-query"]').setValue('Ali');
  expect(wrapper.find('[data-testid="pending-author-option"]').exists()).toBe(false);
  await wrapper.get('[data-testid="pending-author-remove"]').trigger('click');
  await wrapper.get('[data-testid="pending-author-query"]').setValue('ALi');
  expect(wrapper.get('[data-testid="pending-author-option"]').text()).toBe('Alice');
  await wrapper.get('[data-testid="pending-author-option"]').trigger('click');
  expect(wrapper.findAll('[data-testid="pending-author-remove"]')).toHaveLength(1);
  await wrapper.get('[data-testid="pending-author-query"]').setValue('unknown');
  expect(wrapper.find('[data-testid="pending-author-option"]').exists()).toBe(false);
});
