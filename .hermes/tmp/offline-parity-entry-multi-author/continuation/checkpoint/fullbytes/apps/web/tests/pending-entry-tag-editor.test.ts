// @vitest-environment jsdom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PendingEntryTagEditor from '../src/components/PendingEntryTagEditor.vue';
import type { GalleryApi, PendingOfflineEntryCreate } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';

enableAutoUnmount(afterEach);
beforeEach(() => setLocale('en'));
const key = 'local:22222222-2222-4222-8222-222222222222' as const;
function entry(): PendingOfflineEntryCreate {
  return { localKey: key, title: 'Draft', type: 'game', uploadDate: null,
    pageCount: null, status: 'pending', canEditTags: true };
}
function api() {
  const getPendingOfflineEntryTagOptions = vi.fn().mockResolvedValue({
    facets: [{ id: 1, name: 'Genre' }, { id: 2, name: 'Theme' }],
    tags: [{ name: 'RPG', facetId: 1 }], availableTags: [{ id: 10, name: 'RPG' }],
  });
  const enqueueOfflinePendingEntryTags = vi.fn().mockResolvedValue(undefined);
  const suggestTags = vi.fn().mockResolvedValue([]);
  return { getPendingOfflineEntryTagOptions, enqueueOfflinePendingEntryTags, suggestTags };
}

describe('pending Entry Tag editor UI', () => {
  it('keeps a rejected draft editable and permits a deliberate retry without changing the options', async () => {
    const methods = api();
    methods.enqueueOfflinePendingEntryTags.mockRejectedValueOnce(new Error('Outbox write failed'));
    const wrapper = mount(PendingEntryTagEditor, { props: { api: methods as unknown as GalleryApi, entry: entry() } });
    await flushPromises();
    await wrapper.get('[data-testid="pending-tag-row-facet"]').setValue('2');
    await wrapper.get('[data-testid="pending-tag-form"]').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[data-testid="pending-tag-error"]').text()).toContain('Outbox write failed');
    expect(wrapper.get('[data-testid="pending-tag-row-facet"]').element).toHaveProperty('value', '2');
    expect(wrapper.emitted('saved')).toBeUndefined();
    await expect(methods.getPendingOfflineEntryTagOptions.mock.results[0]?.value).resolves.toMatchObject({ tags: [{ name: 'RPG', facetId: 1 }] });
    await wrapper.get('[data-testid="pending-tag-form"]').trigger('submit');
    await flushPromises();
    expect(methods.enqueueOfflinePendingEntryTags).toHaveBeenCalledTimes(2);
    expect(wrapper.emitted('saved')).toEqual([[[{ name: 'RPG', facetId: 2 }]]]);
  });

  it('does not resubmit after a confirmed enqueue even if the parent has not unmounted it yet', async () => {
    const methods = api();
    const wrapper = mount(PendingEntryTagEditor, { props: { api: methods as unknown as GalleryApi, entry: entry() } });
    await flushPromises();
    await wrapper.get('[data-testid="pending-tag-row-facet"]').setValue('2');
    await wrapper.get('[data-testid="pending-tag-form"]').trigger('submit');
    await flushPromises();
    await wrapper.get('[data-testid="pending-tag-form"]').trigger('submit');
    expect(methods.enqueueOfflinePendingEntryTags).toHaveBeenCalledTimes(1);
    expect(methods.enqueueOfflinePendingEntryTags).toHaveBeenCalledWith(key, [{ name: 'RPG', facetId: 2 }]);
    expect(wrapper.emitted('saved')).toHaveLength(1);
  });

  it('does not enqueue an unchanged desired set', async () => {
    const methods = api();
    const wrapper = mount(PendingEntryTagEditor, { props: { api: methods as unknown as GalleryApi, entry: entry() } });
    await flushPromises();
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="pending-tag-form"]').trigger('submit');
    expect(methods.enqueueOfflinePendingEntryTags).not.toHaveBeenCalled();
  });

  it.each(['failed', 'conflict'] as const)('does not load or write a blocked %s parent', async (status) => {
    const methods = api();
    const wrapper = mount(PendingEntryTagEditor, { props: { api: methods as unknown as GalleryApi,
      entry: { ...entry(), status, canEditTags: true } } });
    await flushPromises();
    expect(wrapper.find('[data-testid="pending-tag-form"]').exists()).toBe(false);
    expect(methods.getPendingOfflineEntryTagOptions).not.toHaveBeenCalled();
    expect(methods.enqueueOfflinePendingEntryTags).not.toHaveBeenCalled();
  });

  it('fails closed without the persisted writable capability', async () => {
    const methods = api();
    const wrapper = mount(PendingEntryTagEditor, { props: { api: methods as unknown as GalleryApi,
      entry: { ...entry(), canEditTags: false } } });
    await flushPromises();
    expect(wrapper.get('[data-testid="pending-tag-error"]').text()).toContain('unavailable');
    expect(methods.getPendingOfflineEntryTagOptions).not.toHaveBeenCalled();
  });

  it('does not leak a late options result into a newly mounted Entry editor', async () => {
    const methods = api();
    let complete!: (value: unknown) => void;
    methods.getPendingOfflineEntryTagOptions.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const old = mount(PendingEntryTagEditor, { props: { api: methods as unknown as GalleryApi, entry: entry() } });
    await flushPromises();
    old.unmount();
    methods.getPendingOfflineEntryTagOptions.mockResolvedValue({ facets: [{ id: 1, name: 'Genre' }], tags: [], availableTags: [] });
    const fresh = mount(PendingEntryTagEditor, { props: { api: methods as unknown as GalleryApi,
      entry: { ...entry(), localKey: 'local:33333333-3333-4333-8333-333333333333' } } });
    await flushPromises();
    complete({ facets: [{ id: 1, name: 'Genre' }], tags: [{ name: 'Old Tag', facetId: 1 }], availableTags: [] });
    await flushPromises();
    expect(fresh.text()).not.toContain('Old Tag');
    expect(fresh.find('[data-testid="pending-tag-row-facet"]').exists()).toBe(false);
    expect(methods.enqueueOfflinePendingEntryTags).not.toHaveBeenCalled();
  });
});

it('awaits new Tag creation, keeps a failed name and emits saved only after durable assignment', async () => {
  const methods = { ...api(), enqueueOfflinePendingEntryTagCreate: vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined) };
  methods.getPendingOfflineEntryTagOptions.mockResolvedValue({ facets: [{ id: 1, name: 'Genre' }], tags: [], availableTags: [], canCreateTag: true });
  const createTag = vi.fn(async (key: string, name: string, facet: number) => methods.enqueueOfflinePendingEntryTagCreate(key, name, facet));
  const wrapper = mount(PendingEntryTagEditor, { props: { api: methods as unknown as GalleryApi, entry: entry(), createTag } });
  await flushPromises();
  await wrapper.get('[data-testid="pending-new-tag-name"]').setValue('School Life');
  await wrapper.get('[data-testid="pending-new-tag-create"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[data-testid="pending-new-tag-name"]').element).toHaveProperty('value', 'School Life');
  expect(wrapper.emitted('saved')).toBeUndefined();
  await wrapper.get('[data-testid="pending-new-tag-create"]').trigger('click'); await flushPromises();
  expect(createTag).toHaveBeenCalledWith(key, 'School Life', 1);
  expect(wrapper.emitted('saved')).toEqual([[[{ name: 'School Life', facetId: 1 }]]]);
  await wrapper.get('[data-testid="pending-new-tag-create"]').trigger('click');
  expect(createTag).toHaveBeenCalledTimes(2);
});
