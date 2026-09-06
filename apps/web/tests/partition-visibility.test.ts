// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import type { CollectionRecordDto, EntryTagUsage, GallerySummary } from '@t3/shared';
import type { GalleryApi, GalleryAuthorSummary, GalleryEntrySummary } from '../src/api/gallery.js';
import CollectionsPage from '../src/CollectionsPage.vue';
import RandomPage from '../src/RandomPage.vue';
import RecentViewPage from '../src/RecentViewPage.vue';
import { showNsfw } from '../src/stores/preferences.js';

const safeGallery: GallerySummary = { type: 'safe', entryCount: 1, nsfw: false };
const adultGallery: GallerySummary = { type: 'adult', entryCount: 1, nsfw: true };

function entry(id: number, title: string, type: string): GalleryEntrySummary {
  return {
    id,
    title,
    type,
    coverRef: null,
    previewRef: null,
    previewRefs: [],
    uploadDate: null,
    pageCount: null,
    viewCount: 1,
    likeCount: 0,
    lastViewedAt: '2026-09-06T01:00:00Z',
  };
}

function apiStub(overrides: Partial<GalleryApi>): GalleryApi {
  return {
    assetUrl: (path: string) => path,
    listGalleries: async () => [safeGallery, adultGallery],
    listEntries: async (type: string) => type === 'safe'
      ? [entry(1, 'Safe Work', 'safe')]
      : [entry(2, 'Adult Work', 'adult')],
    ...overrides,
  } as GalleryApi;
}

beforeEach(() => {
  window.localStorage.clear();
  showNsfw.value = false;
});

describe('whole-Gallery partition visibility outside Gallery pages', () => {
  it('hides NSFW Gallery tabs and entries from Recently viewed', async () => {
    const wrapper = mount(RecentViewPage, { props: { api: apiStub({}) } });
    await flushPromises();

    expect(wrapper.find('[data-recent-tab="safe"]').exists()).toBe(true);
    expect(wrapper.find('[data-recent-tab="adult"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Safe Work');
    expect(wrapper.text()).not.toContain('Adult Work');
  });

  it('hides entries from NSFW Galleries inside an SFW Collection', async () => {
    const collection: CollectionRecordDto = {
      id: 10,
      kind: 'entry',
      title: 'Mixed shelf',
      description: '',
      nsfw: false,
      sortOrder: 0,
      children: [],
      entries: [
        { id: 1, title: 'Safe Work', type: 'safe', coverRef: null, previewRefs: [] },
        { id: 2, title: 'Adult Work', type: 'adult', coverRef: null, previewRefs: [] },
      ],
      producers: [],
    };
    const wrapper = mount(CollectionsPage, {
      props: {
        api: apiStub({ listCollections: async () => [collection] }),
      },
    });
    await flushPromises();
    await wrapper.get('[data-collection-id="10"]').trigger('click');
    await flushPromises();

    const cards = wrapper.findAll('[data-testid="collection-entry-card"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text()).toContain('Safe Work');
    expect(wrapper.text()).not.toContain('Adult Work');
  });

  it('closes an active NSFW Collection when Show NSFW is turned off', async () => {
    showNsfw.value = true;
    const collection: CollectionRecordDto = {
      id: 11,
      kind: 'entry',
      title: 'Private shelf',
      description: '',
      nsfw: true,
      sortOrder: 0,
      children: [],
      entries: [{ id: 2, title: 'Adult Work', type: 'adult', coverRef: null, previewRefs: [] }],
      producers: [],
    };
    const wrapper = mount(CollectionsPage, {
      props: { api: apiStub({ listCollections: async () => [collection] }) },
    });
    await flushPromises();
    await wrapper.get('[data-collection-id="11"]').trigger('click');
    expect(wrapper.find('[data-testid="collection-detail"]').exists()).toBe(true);

    showNsfw.value = false;
    await nextTick();

    expect(wrapper.find('[data-testid="collection-detail"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Private shelf');
  });

  it('clears an already dealt NSFW work when Show NSFW is turned off', async () => {
    showNsfw.value = true;
    const wrapper = mount(RandomPage, { props: { api: apiStub({
      listFacetFilterOptions: async () => ({ entryType: 'safe', facets: [], allTags: [], authors: [], ratingSlots: [] }),
    }) } });
    await flushPromises();
    await wrapper.get('[data-testid="random-type-adult"]').trigger('click');
    await wrapper.get('[data-testid="random-deal-button"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Adult Work');

    showNsfw.value = false;
    await flushPromises();
    expect(wrapper.find('[data-testid="random-type-adult"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Adult Work');
  });

  it('ignores an NSFW random result from an older in-flight deal', async () => {
    showNsfw.value = true;
    let resolveAdult: ((entries: GalleryEntrySummary[]) => void) | undefined;
    const pendingAdult = new Promise<GalleryEntrySummary[]>((resolve) => { resolveAdult = resolve; });
    const wrapper = mount(RandomPage, { props: { api: apiStub({
      listEntries: async (type: string) => type === 'adult'
        ? pendingAdult
        : [entry(1, 'Safe Work', 'safe')],
      listFacetFilterOptions: async () => ({ entryType: 'safe', facets: [], allTags: [], authors: [], ratingSlots: [] }),
    }) } });
    await flushPromises();
    await wrapper.get('[data-testid="random-type-adult"]').trigger('click');
    await wrapper.get('[data-testid="random-deal-button"]').trigger('click');

    showNsfw.value = false;
    await nextTick();
    resolveAdult?.([entry(2, 'Adult Work', 'adult')]);
    await flushPromises();

    expect(wrapper.find('[data-entry-id="2"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Adult Work');
  });

  it('removes NSFW Authors from Random pick', async () => {
    const authors: GalleryAuthorSummary[] = [
      { id: 1, name: 'Safe Author', covers: [], galleryType: 'safe', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
      { id: 2, name: 'Adult Author', covers: [], galleryType: 'adult', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: true },
    ];
    const wrapper = mount(RandomPage, { props: { api: apiStub({
      filterAuthors: async () => authors,
      listFacetFilterOptions: async () => ({ entryType: 'safe', facets: [], allTags: [], authors: [], ratingSlots: [] }),
    }) } });
    await flushPromises();
    await wrapper.get('[data-testid="random-mode-authors"]').trigger('click');
    await wrapper.get('[data-testid="random-deal-button"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Safe Author');
    expect(wrapper.text()).not.toContain('Adult Author');
  });

  it('draws Random Tags only from visible Galleries', async () => {
    const safeTag: EntryTagUsage = { id: 1, name: 'Safe Tag', normalizedName: 'safe tag', entryCount: 1 };
    const adultTag: EntryTagUsage = { id: 2, name: 'Adult Tag', normalizedName: 'adult tag', entryCount: 1 };
    const wrapper = mount(RandomPage, { props: { api: apiStub({
      listGalleryTags: async (type?: string) => type === 'safe' ? [safeTag] : [adultTag],
      listFacetFilterOptions: async () => ({ entryType: 'safe', facets: [], allTags: [], authors: [], ratingSlots: [] }),
    }) } });
    await flushPromises();
    await wrapper.get('[data-testid="random-mode-tags"]').trigger('click');
    await wrapper.get('[data-testid="random-deal-button"]').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Safe Tag');
    expect(wrapper.text()).not.toContain('Adult Tag');
  });
});
