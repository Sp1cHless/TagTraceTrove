// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import type { CollectionRecordDto } from '@t3/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CollectionsPage from '../src/CollectionsPage.vue';
import type { GalleryApi } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';

function entry(id: number, title: string) {
  return { id, title, type: 'manga', coverRef: null, previewRefs: [] };
}

function collection(
  id: number,
  title: string,
  entries: CollectionRecordDto['entries'] = [],
  children: CollectionRecordDto[] = [],
): CollectionRecordDto {
  return {
    id,
    kind: 'entry',
    title,
    description: '',
    nsfw: false,
    sortOrder: id,
    children,
    entries,
    producers: [],
  };
}

function createCollectionsApi() {
  const child = collection(2, 'Favorites', [entry(202, 'Child work')]);
  const records = [
    collection(1, 'Library', [entry(101, 'Loose work')], [child]),
    collection(3, 'Archive'),
  ];
  const addCollectionEntry = vi.fn(async () => undefined);
  const removeCollectionEntry = vi.fn(async () => undefined);
  const reorderCollections = vi.fn(async () => undefined);
  const api = {
    assetUrl: (path: string) => path,
    listCollections: vi.fn(async (kind: 'entry' | 'producer') => (
      kind === 'entry' ? records : []
    )),
    listGalleries: vi.fn(async () => []),
    listAuthors: vi.fn(async () => []),
    addCollectionEntry,
    removeCollectionEntry,
    reorderCollections,
  } as unknown as GalleryApi;
  return { api, addCollectionEntry, removeCollectionEntry, reorderCollections };
}

async function openCollection(api: GalleryApi, collectionId = 1) {
  const wrapper = mount(CollectionsPage, { props: { api } });
  await flushPromises();
  await wrapper.get(`[data-collection-id="${collectionId}"]`).trigger('click');
  await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');
  return wrapper;
}

describe('CollectionsPage touch organization', () => {
  beforeEach(() => {
    setLocale('en');
    vi.stubGlobal('scrollTo', vi.fn());
  });

  it('opens each folder at the top and restores its parent scroll position', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const scrollY = vi.spyOn(window, 'scrollY', 'get').mockReturnValue(510);
    const { api } = createCollectionsApi();
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-collection-id="1"]').trigger('click');
    await flushPromises();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: 'auto' });

    scrollY.mockReturnValue(0);
    await wrapper.get('.back-button').trigger('click');
    await flushPromises();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 510, left: 0, behavior: 'auto' });
    scrollY.mockRestore();
    scrollTo.mockRestore();
  });

  it('moves a selected parent work into a child folder through named touch targets', async () => {
    const { api, addCollectionEntry, removeCollectionEntry } = createCollectionsApi();
    const wrapper = await openCollection(api);

    const source = wrapper.get('[data-collection-entry-id="101"]');
    await source.get('.entry-card-main').trigger('click');
    expect(source.attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="collection-organize-hint"]').text()).toContain('Tap a work');

    await wrapper.get('[data-move-to-collection-id="2"]').trigger('click');
    await flushPromises();

    expect(removeCollectionEntry).toHaveBeenCalledWith(1, 101);
    expect(addCollectionEntry).toHaveBeenCalledWith(2, 101);
    expect(wrapper.find('[data-move-to-collection-id="2"]').exists()).toBe(false);
  });

  it('moves a selected child-folder work back to its parent through touch', async () => {
    const { api, addCollectionEntry, removeCollectionEntry } = createCollectionsApi();
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-collection-id="1"]').trigger('click');
    await wrapper.get('[data-collection-id="2"]').trigger('click');
    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');

    const source = wrapper.get('[data-collection-entry-id="202"]');
    await source.get('.entry-card-main').trigger('click');
    await wrapper.get('[data-testid="move-entry-to-parent"]').trigger('click');
    await flushPromises();

    expect(removeCollectionEntry).toHaveBeenCalledWith(2, 202);
    expect(addCollectionEntry).toHaveBeenCalledWith(1, 202);
  });

  it('reorders top-level collections with 44px edit-mode controls', async () => {
    const { api, reorderCollections } = createCollectionsApi();
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');

    const moveDown = wrapper.get('[data-testid="move-collection-down-1"]');
    expect(moveDown.attributes('aria-label')).toContain('Library');
    await moveDown.trigger('click');
    await flushPromises();

    expect(reorderCollections).toHaveBeenCalledWith('entry', [3, 1]);
  });
});
