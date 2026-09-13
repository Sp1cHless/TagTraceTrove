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
  const deleteEntry = vi.fn(async () => undefined);
  const reorderCollections = vi.fn(async () => undefined);
  const api = {
    assetUrl: (path: string) => path,
    listCollections: vi.fn(async (kind: 'entry' | 'producer') => (
      kind === 'entry' ? records : []
    )),
    listGalleries: vi.fn(async () => []),
    listAuthors: vi.fn(async () => []),
    queryEntryPage: vi.fn(async (input) => {
      const find = (items: CollectionRecordDto[]): CollectionRecordDto | undefined => {
        for (const item of items) {
          if (item.id === input.collectionId) return item;
          const nested = find(item.children);
          if (nested) return nested;
        }
        return undefined;
      };
      const items = find(records)?.entries ?? [];
      return { items, total: items.length, page: input.page, pageSize: input.pageSize };
    }),
    queryProducerPage: vi.fn(async (input) => ({ items: [], total: 0, page: input.page, pageSize: input.pageSize })),
    addCollectionEntry,
    removeCollectionEntry,
    deleteEntry,
    reorderCollections,
  } as unknown as GalleryApi;
  return { api, addCollectionEntry, removeCollectionEntry, deleteEntry, reorderCollections };
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

  it('opens a Collection member Entry in normal browsing mode', async () => {
    const { api } = createCollectionsApi();
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-collection-id="1"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-collection-entry-id="101"] .entry-card-main').trigger('click');

    expect(wrapper.emitted('open-entry')).toEqual([[101]]);
  });

  it('keeps folder Edit mode active and selects an Entry instead of opening it', async () => {
    const { api } = createCollectionsApi();
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');
    await wrapper.get('[data-collection-id="1"]').trigger('click');
    await flushPromises();
    const source = wrapper.get('[data-collection-entry-id="101"]');
    await source.get('.entry-card-main').trigger('click');

    expect(wrapper.emitted('open-entry')).toBeUndefined();
    expect(source.attributes('aria-pressed')).toBe('true');
    expect(wrapper.find('[data-remove-collection-entry-id="101"]').exists()).toBe(true);
  });

  it('removes only the active Collection membership and refreshes its members', async () => {
    const { api, deleteEntry } = createCollectionsApi();
    const originalQuery = api.queryEntryPage;
    let removed = false;
    const removeCollectionEntry = vi.fn(async () => {
      removed = true;
    });
    api.removeCollectionEntry = removeCollectionEntry;
    api.queryEntryPage = vi.fn(async (input) => (
      removed && input.collectionId === 1
        ? { items: [], total: 0, page: input.page, pageSize: input.pageSize }
        : originalQuery(input)
    ));
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');
    await wrapper.get('[data-collection-id="1"]').trigger('click');
    await flushPromises();
    const removeButton = wrapper.get('[data-remove-collection-entry-id="101"]');
    expect(removeButton.classes()).toContain('view-later-remove');
    await removeButton.trigger('click');
    await flushPromises();

    expect(removeCollectionEntry).toHaveBeenCalledTimes(1);
    expect(removeCollectionEntry).toHaveBeenCalledWith(1, 101);
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(wrapper.find('[data-collection-entry-id="101"]').exists()).toBe(false);
    expect(wrapper.emitted('open-entry')).toBeUndefined();
  });

  it('keeps the member visible and reports a failed membership removal', async () => {
    const { api, deleteEntry } = createCollectionsApi();
    const removeCollectionEntry = vi.fn(async () => {
      throw new Error('Membership removal failed');
    });
    api.removeCollectionEntry = removeCollectionEntry;
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');
    await wrapper.get('[data-collection-id="1"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-remove-collection-entry-id="101"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('Membership removal failed');
    expect(wrapper.find('[data-collection-entry-id="101"]').exists()).toBe(true);
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(wrapper.emitted('open-entry')).toBeUndefined();
  });

  it('deduplicates repeated remove clicks while the membership request is pending', async () => {
    const { api } = createCollectionsApi();
    let finishRemoval!: () => void;
    const removeCollectionEntry = vi.fn(() => new Promise<void>((resolve) => {
      finishRemoval = resolve;
    }));
    api.removeCollectionEntry = removeCollectionEntry;
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');
    await wrapper.get('[data-collection-id="1"]').trigger('click');
    await flushPromises();
    const removeButton = wrapper.get('[data-remove-collection-entry-id="101"]');
    await removeButton.trigger('click');
    await Promise.resolve();

    expect(removeCollectionEntry).toHaveBeenCalledTimes(1);
    expect(removeButton.attributes('disabled')).toBeDefined();
    await removeButton.trigger('click');
    expect(removeCollectionEntry).toHaveBeenCalledTimes(1);

    finishRemoval();
    await flushPromises();
  });

  it('removes a nested-folder membership from that folder only', async () => {
    const { api, deleteEntry } = createCollectionsApi();
    const originalQuery = api.queryEntryPage;
    let removed = false;
    const removeCollectionEntry = vi.fn(async () => {
      removed = true;
    });
    api.removeCollectionEntry = removeCollectionEntry;
    api.queryEntryPage = vi.fn(async (input) => (
      removed && input.collectionId === 2
        ? { items: [], total: 0, page: input.page, pageSize: input.pageSize }
        : originalQuery(input)
    ));
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');
    await wrapper.get('[data-collection-id="1"]').trigger('click');
    await wrapper.get('[data-collection-id="2"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-remove-collection-entry-id="202"]').trigger('click');
    await flushPromises();

    expect(removeCollectionEntry).toHaveBeenCalledTimes(1);
    expect(removeCollectionEntry).toHaveBeenCalledWith(2, 202);
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(wrapper.find('[data-collection-entry-id="202"]').exists()).toBe(false);
    expect(wrapper.emitted('open-entry')).toBeUndefined();
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

  it('splits Collection covers equally across one, two, or three displayed works', async () => {
    const { api } = createCollectionsApi();
    const coveredEntry = (id: number) => ({
      ...entry(id, `Work ${id}`),
      coverRef: `/api/assets/entries/${id}/cover.webp`,
    });
    const records = [
      collection(11, 'One work', [coveredEntry(1)]),
      collection(12, 'Two works', [coveredEntry(2), coveredEntry(3)]),
      collection(13, 'Three works', [coveredEntry(4), coveredEntry(5), coveredEntry(6)]),
    ];
    api.listCollections = vi.fn(async (nextKind) => (nextKind === 'entry' ? records : []));

    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();

    for (const [collectionId, expectedCount] of [[11, 1], [12, 2], [13, 3]] as const) {
      const cover = wrapper.get(`[data-collection-id="${collectionId}"] .directory-cover`);
      expect(cover.findAll('img')).toHaveLength(expectedCount);
      expect(cover.findAll('.mini-placeholder')).toHaveLength(0);
      expect(cover.attributes('data-cover-count')).toBe(String(expectedCount));
      expect((cover.element as HTMLElement).style.gridTemplateColumns)
        .toBe(`repeat(${expectedCount}, minmax(0, 1fr))`);
    }
  });

  it('bounds Author cover mosaics inside a Collection folder card', async () => {
    const { api } = createCollectionsApi();
    const authorCollection: CollectionRecordDto = {
      id: 9,
      kind: 'producer',
      title: 'Favorite Authors',
      description: '',
      nsfw: false,
      sortOrder: 0,
      children: [],
      entries: [],
      producers: [],
    };
    api.listCollections = vi.fn(async (nextKind) => (
      nextKind === 'producer' ? [authorCollection] : []
    ));
    api.queryProducerPage = vi.fn(async (input) => ({
      items: [{
        id: 7,
        name: 'Example Author',
        covers: ['/api/assets/entries/1/cover.webp', '/api/assets/entries/2/cover.webp'],
        galleryType: 'Comic',
        viewCount: 0,
        likeCount: 0,
        lastViewedAt: null,
        nsfw: false,
      }],
      total: 1,
      page: input.page,
      pageSize: input.pageSize,
    }));

    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="collections-kind-producer"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-collection-id="9"]').trigger('click');
    await flushPromises();

    const card = wrapper.get('[data-author-id="7"]');
    const cover = card.get('.author-list-cover');
    expect(cover.findAll('img')).toHaveLength(2);
    expect(cover.attributes('data-cover-count')).toBe('2');
    expect((cover.element as HTMLElement).style.gridTemplateColumns)
      .toBe('repeat(2, minmax(0, 1fr))');
  });
});
