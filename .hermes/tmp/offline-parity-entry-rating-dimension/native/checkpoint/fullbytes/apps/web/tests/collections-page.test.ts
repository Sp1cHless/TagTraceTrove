// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import type { CollectionRecordDto, GallerySummary } from '@t3/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CollectionsPage from '../src/CollectionsPage.vue';
import type { GalleryApi } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';
import { showNsfw } from '../src/stores/preferences.js';

const reconciliation = vi.hoisted(() => ({ listener: null as null | ((ids: ReadonlyMap<number, number>) => void) }));
vi.mock('../src/offline/offline-api.js', () => ({
  subscribeCollectionReconciliation: vi.fn((_api, listener) => {
    reconciliation.listener = listener;
    return () => { reconciliation.listener = null; };
  }),
}));

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
    galleryType: null,
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

  it('keeps an open local Collection selected and reloads its authoritative members after replay', async () => {
    let online = false;
    const queryEntryPage = vi.fn(async (input) => ({
      items: [], total: 0, page: input.page, pageSize: input.pageSize,
    }));
    const api = {
      assetUrl: (path: string) => path,
      listCollections: vi.fn(async () => [collection(online ? 72 : -1, 'Local shelf')]),
      listGalleries: vi.fn(async () => []),
      queryEntryPage,
    } as unknown as GalleryApi;
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-collection-id="-1"]').trigger('click');
    await flushPromises();
    expect(queryEntryPage).toHaveBeenLastCalledWith(expect.objectContaining({ collectionId: -1 }));

    online = true;
    expect(reconciliation.listener).not.toBeNull();
    reconciliation.listener?.(new Map([[-1, 72]]));
    await flushPromises();
    expect(wrapper.get('[data-testid="collections-panel"]').text()).toContain('Local shelf');
    expect(queryEntryPage).toHaveBeenLastCalledWith(expect.objectContaining({ collectionId: 72 }));
    wrapper.unmount();
    expect(reconciliation.listener).toBeNull();
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
    expect(addCollectionEntry.mock.invocationCallOrder[0]!).toBeLessThan(removeCollectionEntry.mock.invocationCallOrder[0]!);
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
    expect(addCollectionEntry.mock.invocationCallOrder[0]!).toBeLessThan(removeCollectionEntry.mock.invocationCallOrder[0]!);
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

  it('keeps hidden NSFW siblings in the full reorder vector while showing only SFW cards', async () => {
    showNsfw.value = false;
    const records = [
      collection(1, 'First safe'),
      { ...collection(2, 'Hidden'), nsfw: true },
      collection(3, 'Second safe'),
    ];
    const reorderCollections = vi.fn(async () => undefined);
    const api = {
      assetUrl: (path: string) => path,
      listCollections: vi.fn(async (kind: 'entry' | 'producer', includeNsfw?: boolean) => (
        kind !== 'entry' ? [] : records.filter((row) => includeNsfw || !row.nsfw)
      )),
      listGalleries: vi.fn(async () => []),
      reorderCollections,
    } as unknown as GalleryApi;
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();
    expect(wrapper.find('[data-collection-id="2"]').exists()).toBe(false);
    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');
    await wrapper.get('[data-testid="move-collection-down-1"]').trigger('click');
    await flushPromises();
    expect(api.listCollections).toHaveBeenCalledWith('entry', true);
    expect(reorderCollections).toHaveBeenCalledWith('entry', [2, 3, 1]);
    wrapper.unmount();
  });

  it('does not apply a late NSFW-inclusive child summary after SFW mode reloads', async () => {
    showNsfw.value = true;
    let resolveInclusive!: (records: CollectionRecordDto[]) => void;
    const inclusiveRecords = new Promise<CollectionRecordDto[]>((resolve) => {
      resolveInclusive = resolve;
    });
    const safeRecords = [{
      ...collection(1, 'Library', [], [collection(2, 'Sensitive folder')]),
      galleryType: 'game',
    }];
    const inclusiveMember = {
      ...entry(204, 'Sensitive work'),
      coverRef: 'entries/204/cover.webp',
    };
    const inclusiveParent = {
      ...collection(1, 'Library', [], [
        { ...collection(2, 'Sensitive folder', [inclusiveMember]), entryCount: 1 },
      ]),
      galleryType: 'game',
    };
    let inclusiveRequestCount = 0;
    const api = {
      assetUrl: (path: string) => path,
      listCollections: vi.fn(async (kind: 'entry' | 'producer', includeNsfw: boolean) => {
        if (kind === 'producer') return [];
        if (includeNsfw && inclusiveRequestCount++ === 0) return inclusiveRecords;
        return includeNsfw ? [inclusiveParent] : safeRecords;
      }),
      listGalleries: vi.fn(async () => [gallery('game', false)]),
      queryEntryPage: vi.fn(async (input) => ({
        items: [], total: 0, page: input.page, pageSize: input.pageSize,
      })),
    } as unknown as GalleryApi;
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();
    showNsfw.value = false;
    await flushPromises();
    await wrapper.get('[data-collection-id="1"]').trigger('click');
    await flushPromises();

    const childCard = wrapper.get('[data-collection-id="2"]');
    expect(childCard.text()).toContain('0 works');
    resolveInclusive([inclusiveParent]);
    await flushPromises();
    expect(childCard.text()).toContain('0 works');
    expect(childCard.find('img').exists()).toBe(false);
    wrapper.unmount();
  });

  it('hides cached NSFW child previews while SFW list and child-summary reads are pending', async () => {
    showNsfw.value = true;
    const privateMember = {
      ...entry(205, 'Sensitive cached work'),
      coverRef: 'entries/205/private-cover.webp',
    };
    let resolveSensitiveChild!: (page: {
      items: typeof privateMember[];
      total: number;
      page: number;
      pageSize: number;
    }) => void;
    const delayedSensitiveChild = new Promise<{ items: typeof privateMember[]; total: number; page: number; pageSize: number }>(
      (resolve) => { resolveSensitiveChild = resolve; },
    );
    let resolveSafeRecords!: (records: CollectionRecordDto[]) => void;
    const delayedSafeRecords = new Promise<CollectionRecordDto[]>((resolve) => {
      resolveSafeRecords = resolve;
    });
    const safeParent = {
      ...collection(1, 'Library', [], [collection(2, 'Sensitive folder')]),
      galleryType: 'game',
    };
    const inclusiveParent = {
      ...collection(1, 'Library', [], [
        { ...collection(2, 'Sensitive folder', [privateMember]), entryCount: 2 },
      ]),
      galleryType: 'game',
    };
    const api = {
      assetUrl: (path: string) => path,
      listCollections: vi.fn(async (kind: 'entry' | 'producer', includeNsfw: boolean) => {
        if (kind === 'producer') return [];
        return includeNsfw ? [inclusiveParent] : delayedSafeRecords;
      }),
      listGalleries: vi.fn(async () => [gallery('game', false)]),
      queryEntryPage: vi.fn(async (input) => {
        if (input.collectionId === 2 && input.includeNsfw) return delayedSensitiveChild;
        return { items: [], total: 0, page: input.page, pageSize: input.pageSize };
      }),
    } as unknown as GalleryApi;
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();
    const opening = wrapper.get('[data-collection-id="1"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-collection-id="2"] img').attributes('src')).toContain('private-cover.webp');

    showNsfw.value = false;
    await flushPromises();
    expect(api.queryEntryPage).toHaveBeenCalledWith(expect.objectContaining({
      collectionId: 2,
      includeNsfw: true,
    }));
    expect(wrapper.find('[data-collection-id="2"]').exists()).toBe(false);

    resolveSafeRecords([safeParent]);
    await flushPromises();
    expect(api.queryEntryPage).toHaveBeenCalledWith(expect.objectContaining({
      collectionId: 2,
      includeNsfw: false,
    }));
    resolveSensitiveChild({
      items: [privateMember], total: 1, page: 1, pageSize: 3,
    });
    await opening;
    await flushPromises();
    const safeChildCard = wrapper.get('[data-collection-id="2"]');
    expect(safeChildCard.text()).toContain('0 works');
    expect(safeChildCard.find('img').exists()).toBe(false);
    wrapper.unmount();
  });

  it.each([0, 1])('repairs child-folder previews when the compact summary is stale (count %i)', async (reportedCount) => {
    showNsfw.value = true;
    const member = {
      ...entry(202, 'Child work'),
      coverRef: null,
      previewRefs: ['entries/202/preview.webp'],
    };
    const child = {
      ...collection(2, 'Favorites', []),
      entryCount: reportedCount,
    };
    const api = {
      assetUrl: (path: string) => path,
      listCollections: vi.fn(async (kind: 'entry' | 'producer') => (
        kind === 'entry' ? [collection(1, 'Library', [], [child])] : []
      )),
      listGalleries: vi.fn(async () => []),
      queryEntryPage: vi.fn(async (input) => ({
        items: input.collectionId === 2 ? [member] : [],
        total: input.collectionId === 2 ? 1 : 0,
        page: input.page,
        pageSize: input.pageSize,
      })),
    } as unknown as GalleryApi;
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-collection-id="1"]').trigger('click');
    await flushPromises();

    const childCard = wrapper.get('[data-collection-id="2"]');
    expect(childCard.text()).toContain('1 works');
    expect(childCard.get('.directory-cover').attributes('data-cover-count')).toBe('1');
    expect(childCard.get('.directory-cover img').attributes('src')).toContain('entries/202/preview.webp');
    wrapper.unmount();
  });

  it('does not render zero when child member previews outnumber the stale summary count', async () => {
    showNsfw.value = true;
    const member = {
      ...entry(203, 'Preview-only work'),
      coverRef: null,
      previewRefs: ['entries/203/preview.webp'],
    };
    const child = { ...collection(2, 'Preview folder', [member]), entryCount: 0 };
    const api = {
      assetUrl: (path: string) => path,
      listCollections: vi.fn(async (kind: 'entry' | 'producer') => (
        kind === 'entry' ? [collection(1, 'Library', [], [child])] : []
      )),
      listGalleries: vi.fn(async () => []),
      queryEntryPage: vi.fn(async (input) => {
        if (input.collectionId === 2) throw new Error('summary refresh unavailable');
        return { items: [], total: 0, page: input.page, pageSize: input.pageSize };
      }),
    } as unknown as GalleryApi;
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-collection-id="1"]').trigger('click');
    await flushPromises();

    const childCard = wrapper.get('[data-collection-id="2"]');
    expect(childCard.text()).toContain('1 works');
    expect(childCard.get('.directory-cover img').attributes('src')).toContain('entries/203/preview.webp');
    wrapper.unmount();
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
      galleryType: null,
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

function gallery(type: string, nsfw: boolean): GallerySummary {
  return { type, entryCount: 1, nsfw };
}

function scopedCollection(id: number, title: string, galleryType: string | null): CollectionRecordDto {
  return { ...collection(id, title), galleryType };
}

function createScopedApi(galleryList: GallerySummary[]) {
  const records = [
    scopedCollection(1, 'Comic shelf', 'Comic'),
    scopedCollection(2, 'Hentai shelf', 'Hentai'),
    scopedCollection(3, 'Loose shelf', null),
  ];
  const authorRecords = [{ ...collection(9, 'Author shelf'), kind: 'producer' as const }];
  const createCollection = vi.fn(async (input: { kind: 'entry' | 'producer'; title: string; galleryType?: string }) => ({
    ...collection(90, input.title),
    kind: input.kind,
    galleryType: input.galleryType ?? null,
  }));
  const api = {
    assetUrl: (path: string) => path,
    listCollections: vi.fn(async (kind: 'entry' | 'producer') => (kind === 'entry' ? records : authorRecords)),
    listGalleries: vi.fn(async () => galleryList),
    listAuthors: vi.fn(async () => []),
    queryEntryPage: vi.fn(async (input) => ({ items: [], total: 0, page: input.page, pageSize: input.pageSize })),
    queryProducerPage: vi.fn(async (input) => ({ items: [], total: 0, page: input.page, pageSize: input.pageSize })),
    createCollection,
    addCollectionEntry: vi.fn(async () => undefined),
    removeCollectionEntry: vi.fn(async () => undefined),
    deleteEntry: vi.fn(async () => undefined),
    reorderCollections: vi.fn(async () => undefined),
  } as unknown as GalleryApi;
  return { api, createCollection };
}

function listedTitles(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('[data-collection-id] strong').map((title) => title.text());
}

describe('CollectionsPage Gallery pages', () => {
  beforeEach(() => {
    window.localStorage.clear();
    showNsfw.value = false;
    setLocale('en');
  });

  it('lists only the folders curated into the active Gallery page', async () => {
    showNsfw.value = true;
    const { api } = createScopedApi([gallery('Comic', true), gallery('Hentai', true)]);
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();

    // One flat row: every Gallery page plus Authors, and no Works level.
    expect(wrapper.findAll('[data-testid="collections-page-tabs"] .recent-tab').map((tab) => tab.text()))
      .toEqual(['Comic', 'Hentai', 'Unfiled', 'Authors']);
    expect(wrapper.find('[data-testid="collections-page-tabs"] [data-testid="collections-kind-producer"]').exists())
      .toBe(true);
    expect(wrapper.get('[data-collection-gallery-tab="Comic"]').attributes('aria-selected')).toBe('true');
    expect(listedTitles(wrapper)).toEqual(['Comic shelf']);

    await wrapper.get('[data-collection-gallery-tab="Hentai"]').trigger('click');
    await flushPromises();
    expect(listedTitles(wrapper)).toEqual(['Hentai shelf']);

    // Folders that were never filed live on their own page, not on a Gallery's.
    await wrapper.get('[data-collection-gallery-tab="__unfiled__"]').trigger('click');
    await flushPromises();
    expect(listedTitles(wrapper)).toEqual(['Loose shelf']);
  });

  it('drops an NSFW Gallery page and its folders in SFW mode', async () => {
    const { api } = createScopedApi([gallery('Comic', true), gallery('Hentai', true)]);
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();

    expect(wrapper.find('[data-collection-gallery-tab="Comic"]').exists()).toBe(false);
    expect(wrapper.find('[data-collection-gallery-tab="Hentai"]').exists()).toBe(false);
    expect(wrapper.get('[data-collection-gallery-tab="__unfiled__"]').attributes('aria-selected')).toBe('true');
    expect(listedTitles(wrapper)).toEqual(['Loose shelf']);

    // Turning NSFW back on offers the Gallery pages again without moving the
    // folder list the user was already looking at.
    showNsfw.value = true;
    await flushPromises();
    expect(wrapper.find('[data-collection-gallery-tab="Comic"]').exists()).toBe(true);
    expect(listedTitles(wrapper)).toEqual(['Loose shelf']);

    await wrapper.get('[data-collection-gallery-tab="Comic"]').trigger('click');
    await flushPromises();
    expect(listedTitles(wrapper)).toEqual(['Comic shelf']);
  });

  it('falls back to the Authors page when every Gallery page is hidden', async () => {
    const records = [
      scopedCollection(1, 'Comic shelf', 'Comic'),
      scopedCollection(2, 'Hentai shelf', 'Hentai'),
    ];
    const authorFolder = { ...collection(9, 'Author shelf'), kind: 'producer' as const };
    const api = {
      assetUrl: (path: string) => path,
      listCollections: vi.fn(async (kind: 'entry' | 'producer') => (kind === 'entry' ? records : [authorFolder])),
      listGalleries: vi.fn(async () => [gallery('Comic', true), gallery('Hentai', true)]),
      queryEntryPage: vi.fn(async (input) => ({ items: [], total: 0, page: input.page, pageSize: input.pageSize })),
      queryProducerPage: vi.fn(async (input) => ({ items: [], total: 0, page: input.page, pageSize: input.pageSize })),
    } as unknown as GalleryApi;
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();

    // With no entry page left to show, Authors is the only reachable page — the
    // NSFW folders are gone rather than listed on a page nobody can see.
    expect(wrapper.get('[data-testid="collections-page-tabs"] [data-testid="collections-kind-producer"]')
      .attributes('aria-selected')).toBe('true');
    expect(wrapper.find('[data-collection-gallery-tab="Comic"]').exists()).toBe(false);
    expect(listedTitles(wrapper)).toEqual(['Author shelf']);
  });

  it('adds one tag to every work of the open folder from the edit toolbar', async () => {
    showNsfw.value = true;
    const addCollectionTag = vi.fn(async () => ({
      tagId: 7, entriesAffected: 3, alreadyPresent: 1, skipped: 0,
    }));
    const api = {
      assetUrl: (path: string) => path,
      listCollections: vi.fn(async (kind: 'entry' | 'producer') => (kind === 'entry' ? [
        { ...collection(1, 'Shelf', [entry(101, 'Work')]), galleryType: 'Comic' },
      ] : [])),
      listGalleries: vi.fn(async () => [gallery('Comic', true)]),
      queryEntryPage: vi.fn(async (input) => ({ items: [], total: 0, page: input.page, pageSize: input.pageSize })),
      queryProducerPage: vi.fn(async (input) => ({ items: [], total: 0, page: input.page, pageSize: input.pageSize })),
      addCollectionTag,
    } as unknown as GalleryApi;
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-collection-id="1"]').trigger('click');
    await flushPromises();

    // The control belongs to edit mode and sits next to the SFW switch.
    expect(wrapper.find('[data-testid="collection-common-tag-toggle"]').exists()).toBe(false);
    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');
    await flushPromises();
    const toggle = wrapper.get('[data-testid="collection-common-tag-toggle"]');
    expect(toggle.text()).toBe('Add common tag');
    expect(toggle.element.nextElementSibling?.getAttribute('data-testid'))
      .toBe('collection-nsfw-toggle');

    await toggle.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="collection-common-tag-submit"]').attributes('disabled'))
      .toBeDefined();
    await wrapper.get('[data-testid="collection-common-tag-input"]').setValue('Winter');
    // The form submits on Enter as well; the confirm button is its submit.
    await wrapper.get('[data-testid="collection-common-tag-form"]').trigger('submit');
    await flushPromises();

    expect(addCollectionTag).toHaveBeenCalledWith(1, 'Winter');
    expect(wrapper.get('[data-testid="collection-common-tag-result"]').text())
      .toBe('Tagged 3 works (1 already had it, 0 skipped).');
    expect(wrapper.find('[data-testid="collection-common-tag-form"]').exists()).toBe(false);
  });

  it('asks twice before deleting a folder that holds something, once when it is empty', async () => {
    showNsfw.value = true;
    const deleteCollection = vi.fn(async () => undefined);
    const api = {
      assetUrl: (path: string) => path,
      listCollections: vi.fn(async (kind: 'entry' | 'producer') => (kind === 'entry' ? [
        { ...collection(1, 'Full shelf', [entry(101, 'Work')]), galleryType: 'Comic' },
        { ...collection(2, 'Empty shelf'), galleryType: 'Comic' },
      ] : [])),
      listGalleries: vi.fn(async () => [gallery('Comic', true)]),
      queryEntryPage: vi.fn(async (input) => ({ items: [], total: 0, page: input.page, pageSize: input.pageSize })),
      queryProducerPage: vi.fn(async (input) => ({ items: [], total: 0, page: input.page, pageSize: input.pageSize })),
      deleteCollection,
    } as unknown as GalleryApi;
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();
    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');
    await flushPromises();

    // A folder with a work in it arms first and says so.
    const full = wrapper.get('[data-testid="delete-collection-1"]');
    await full.trigger('click');
    expect(deleteCollection).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="delete-collection-1"]').text()).toBe('Confirm');
    expect(wrapper.get('[data-testid="delete-collection-1"]').attributes('aria-label'))
      .toBe('Delete “Full shelf” and everything in it?');

    await wrapper.get('[data-testid="delete-collection-1"]').trigger('click');
    await flushPromises();
    expect(deleteCollection).toHaveBeenCalledWith(1);

    // An empty folder has nothing to protect and goes on the first tap.
    await wrapper.get('[data-testid="delete-collection-2"]').trigger('click');
    await flushPromises();
    expect(deleteCollection).toHaveBeenCalledWith(2);
  });

  it('never flashes the other kind of folder, or a fabricated Unfiled page, while switching', async () => {
    showNsfw.value = true;
    const { api } = createScopedApi([gallery('Comic', true), gallery('Hentai', true)]);
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();

    await wrapper.get('[data-testid="collections-kind-producer"]').trigger('click');
    await flushPromises();
    // Author folders carry no Gallery, so they must not conjure an Unfiled page.
    expect(wrapper.find('[data-collection-gallery-tab="__unfiled__"]').exists()).toBe(false);
    expect(listedTitles(wrapper)).toEqual(['Author shelf']);

    await wrapper.get('[data-collection-gallery-tab="Comic"]').trigger('click');
    // The panel must not keep rendering Author folders while the entry list loads.
    expect(wrapper.get('[data-testid="collections-panel"]').text()).not.toContain('Author shelf');
    await flushPromises();
    expect(listedTitles(wrapper)).toEqual(['Comic shelf']);
  });

  it('creates a folder on the Gallery page it was started from', async () => {
    showNsfw.value = true;
    const { api, createCollection } = createScopedApi([gallery('Comic', true), gallery('Hentai', true)]);
    const wrapper = mount(CollectionsPage, { props: { api } });
    await flushPromises();

    // Switching pages leaves edit mode, so the create row is re-entered each time.
    const createOn = async (tab: string | null, title: string) => {
      if (tab !== null) {
        await wrapper.get(`[data-collection-gallery-tab="${tab}"]`).trigger('click');
        await flushPromises();
      }
      if (!wrapper.find('[data-testid="new-collection-title"]').exists()) {
        await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');
        await flushPromises();
      }
      await wrapper.get('[data-testid="new-collection-title"]').setValue(title);
      await wrapper.get('[data-testid="create-collection"]').trigger('click');
      await flushPromises();
    };

    await createOn('Comic', 'New comic shelf');
    expect(createCollection).toHaveBeenCalledWith({
      kind: 'entry', title: 'New comic shelf', galleryType: 'Comic',
    });

    await createOn('Hentai', 'New hentai shelf');
    expect(createCollection).toHaveBeenCalledWith({
      kind: 'entry', title: 'New hentai shelf', galleryType: 'Hentai',
    });

    // The unfiled page keeps its folders Gallery-less.
    await createOn('__unfiled__', 'New loose shelf');
    expect(createCollection).toHaveBeenCalledWith({ kind: 'entry', title: 'New loose shelf' });
  });
});
