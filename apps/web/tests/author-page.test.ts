// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AuthorPage from '../src/AuthorPage.vue';
import type { GalleryApi } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';

function createAuthorApi() {
  const works = Array.from({ length: 34 }, (_, index) => ({
    id: index + 1,
    title: `Work ${index + 1}`,
    type: 'manga',
    coverRef: index < 4 ? `cover-${index + 1}.webp` : null,
    viewCount: index === 4 ? 12 : 0,
    likeCount: 0,
    lastViewedAt: index === 4 ? '2026-09-03T12:00:00.000Z' : null,
  }));
  let directory = {
    id: 5,
    producerId: 3,
    title: 'Early work',
    description: 'First period',
    sortOrder: 0,
    entries: works.slice(0, 4),
  };
  let looseEntries = works.slice(4);
  let authorRatings: Array<{ slotId: number; name: string; stars: number | null }> = [];
  const getAuthor = vi.fn(async () => ({
    id: 3,
    name: 'Example Author',
    occupation: 'Artist',
    artworkRef: 'author.webp',
    content: 'Important author note',
    tags: [{ tagId: 8, name: 'Illustrator', normalizedName: 'illustrator' }],
    looseEntries,
    directories: [directory],
    ratings: authorRatings,
    usage: { viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
  }));
  const createAuthorRatingSlot = vi.fn(async (_authorId: number, name: string) => {
    const slot = { id: 70, name: name.trim(), sortOrder: 0 };
    authorRatings = [...authorRatings, { slotId: slot.id, name: slot.name, stars: null }];
    return slot;
  });
  const setAuthorRating = vi.fn(async (_authorId: number, slotId: number, stars: number | null) => {
    authorRatings = authorRatings.map((row) => (row.slotId === slotId ? { ...row, stars } : row));
    return { slotId, name: 'Overall', stars };
  });
  const createAuthorDirectory = vi.fn(async (_authorId: number, input: {
    title: string;
    description?: string;
    entryIds?: number[];
  }) => ({
    id: 6,
    producerId: 3,
    title: input.title,
    description: input.description ?? '',
    sortOrder: 1,
    entries: [],
  }));
  const moveEntryToAuthorDirectory = vi.fn(async () => directory);
  const removeEntryFromAuthorDirectory = vi.fn(async (_authorId: number, _directoryId: number, entryId: number) => {
    const removed = directory.entries.find((work) => work.id === entryId);
    directory = { ...directory, entries: directory.entries.filter((work) => work.id !== entryId) };
    if (removed) looseEntries = [...looseEntries, removed];
    return directory;
  });
  const updateAuthorDirectory = vi.fn(async (_directoryId: number, input: {
    title?: string;
    description?: string;
  }) => {
    directory = { ...directory, ...input };
    return directory;
  });
  const api = {
    assetUrl: (path: string) => path,
    getAuthor,
    createAuthorDirectory,
    moveEntryToAuthorDirectory,
    removeEntryFromAuthorDirectory,
    updateAuthorDirectory,
    updateAuthor: vi.fn(async () => ({
      id: 3,
      name: 'Example Author',
      occupation: 'Artist',
      artworkRef: 'author.webp',
      content: 'Important author note',
    })),
    assignAuthorTag: vi.fn(async () => undefined),
    renameAuthorTag: vi.fn(async () => undefined),
    removeAuthorTag: vi.fn(async () => undefined),
    createAuthorRatingSlot,
    setAuthorRating,
    listCollections: vi.fn(async () => []),
    listCollectionsForProducer: vi.fn(async () => []),
    listTaxonomyAliases: vi.fn(async () => []),
    listAuthorFilterOptions: vi.fn(async () => ({ authorTags: [], workTags: [] })),
    filterAuthors: vi.fn(async () => []),
    listFacetFilterOptions: vi.fn(async (type: string) => ({
      entryType: type,
      facets: [],
      allTags: [],
      authors: [],
      ratingSlots: [],
    })),
    filterEntriesByFacets: vi.fn(async () => []),
  } as unknown as GalleryApi;
  return {
    api,
    createAuthorDirectory,
    moveEntryToAuthorDirectory,
    removeEntryFromAuthorDirectory,
    updateAuthorDirectory,
    createAuthorRatingSlot,
    setAuthorRating,
  };
}

async function openAuthor(api: GalleryApi) {
  const wrapper = mount(AuthorPage, {
    props: { api, authors: [{ id: 3, name: 'Example Author', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false }] },
  });
  await wrapper.get('[data-author-id="3"]').trigger('click');
  await flushPromises();
  return wrapper;
}

describe('AuthorPage', () => {
  beforeEach(() => setLocale('en'));

  it('shows uniform colored usage mode buttons with a clear pressed state', async () => {
    const { api } = createAuthorApi();
    const wrapper = mount(AuthorPage, {
      props: { api, authors: [{ id: 3, name: 'Example Author', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false }] },
    });

    const star = wrapper.get('[data-testid="author-mode-last-viewed"]');
    const heart = wrapper.get('[data-testid="author-mode-most-viewed"]');
    const like = wrapper.get('[data-testid="author-mode-most-liked"]');
    expect(star.classes()).toContain('author-mode-star');
    expect(heart.classes()).toContain('author-mode-heart');
    expect(like.classes()).toContain('author-mode-like');
    expect([star.classes(), heart.classes(), like.classes()]
      .every((classes) => classes.includes('recent-mode-button'))).toBe(true);
    expect(star.attributes('aria-pressed')).toBe('false');

    await star.trigger('click');
    expect(star.attributes('aria-pressed')).toBe('true');
    expect(star.classes()).toContain('recent-mode-active');
    expect(heart.attributes('aria-pressed')).toBe('false');

    await heart.trigger('click');
    expect(star.attributes('aria-pressed')).toBe('false');
    expect(heart.attributes('aria-pressed')).toBe('true');
    expect(heart.classes()).toContain('recent-mode-active');
  });

  it('filters the Author list with separate Author Tags and Works contain Tags controls', async () => {
    const { api } = createAuthorApi();
    api.listAuthorFilterOptions = vi.fn(async () => ({
      authorTags: [{ tagId: 2, name: 'Circle' }],
      workTags: [{ tagId: 5, name: 'Action' }],
    }));
    const matchingAuthor = {
      id: 4,
      name: 'Matching Author',
      covers: [],
      galleryType: 'game',
      viewCount: 0,
      likeCount: 0,
      lastViewedAt: null,
      nsfw: false,
    };
    api.filterAuthors = vi.fn(async () => [matchingAuthor]);
    const wrapper = mount(AuthorPage, {
      props: {
        api,
        authors: [
          { id: 3, name: 'Example Author', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
          matchingAuthor,
        ],
      },
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="add-author-tag-filter"]').text()).toContain('Author tags');
    expect(wrapper.get('[data-testid="add-work-tag-filter"]').text()).toContain('Works contain tags');

    await wrapper.get('[data-testid="add-author-tag-filter"]').trigger('click');
    // The tag picker is a type-to-filter combobox, not a plain select.
    await wrapper.get('[data-testid="author-tag-combobox-toggle"]').trigger('click');
    const authorTagInput = wrapper.get('[data-testid="author-tag-combobox-input"]');
    // Near-match: a partial query ('circl' for 'Circle') still finds the tag.
    await authorTagInput.setValue('circl');
    await wrapper.get('[data-testid="author-tag-combobox-option"]').trigger('click');
    await flushPromises();
    expect(api.filterAuthors).toHaveBeenLastCalledWith([2], []);
    expect(wrapper.get('[data-testid="author-tag-combobox-toggle"]').text()).toContain('Circle');

    await wrapper.get('[data-testid="add-work-tag-filter"]').trigger('click');
    await wrapper.get('[data-testid="work-tag-combobox-toggle"]').trigger('click');
    await wrapper.get('[data-testid="work-tag-combobox-input"]').setValue('action');
    await wrapper.get('[data-testid="work-tag-combobox-option"]').trigger('click');
    await flushPromises();
    expect(api.filterAuthors).toHaveBeenLastCalledWith([2], [5]);
    expect(wrapper.findAll('[data-author-id]').map((card) => card.attributes('data-author-id')))
      .toEqual(['4']);

    // The ★/♥/👍 switches are toggles: clicking the active one exits the mode.
    expect(wrapper.find('[data-testid="author-mode-last-viewed"]').exists()).toBe(true);
    await wrapper.get('[data-testid="author-mode-last-viewed"]').trigger('click');
    expect(wrapper.get('[data-testid="author-mode-last-viewed"]').classes()).toContain('recent-mode-active');
    await wrapper.get('[data-testid="author-mode-last-viewed"]').trigger('click');
    expect(wrapper.get('[data-testid="author-mode-last-viewed"]').classes()).not.toContain('recent-mode-active');
    await wrapper.get('[data-testid="author-mode-most-liked"]').trigger('click');
    expect(wrapper.get('[data-testid="author-mode-most-liked"]').classes()).toContain('recent-mode-active');
  });

  it('keeps Author information, Tags, and Content in one board and paginates works by 26', async () => {
    const { api } = createAuthorApi();
    const wrapper = await openAuthor(api);

    const board = wrapper.get('[data-testid="author-information-board"]');
    expect(board.text()).toContain('Example Author');
    expect(board.text()).toContain('Artist');
    expect(board.text()).toContain('Illustrator');
    expect(board.text()).toContain('Important author note');
    expect(board.find('[data-section-id]').exists()).toBe(false);
    expect(board.text()).not.toContain('Facet');
    // 1 always-visible Directory card + 26 loose works on page one.
    expect(wrapper.findAll('[data-author-card]').length).toBe(27);
    expect(wrapper.findAll('[data-author-work-id]').length).toBe(26);

    await wrapper.get('[data-testid="author-next-page"]').trigger('click');
    expect(wrapper.findAll('[data-author-card]').length).toBe(5);
    expect(wrapper.findAll('[data-author-work-id]').length).toBe(4);
    // The Directory stays visible on every page.
    expect(wrapper.findAll('[data-author-directory-id]').length).toBe(1);
  });

  it('creates a Directory by dropping one work on another and moves work onto a Directory', async () => {
    const { api, createAuthorDirectory, moveEntryToAuthorDirectory } = createAuthorApi();
    const wrapper = await openAuthor(api);
    // Works sort newest-first by default; these fixtures target low ids, so
    // restore oldest-first to keep them on the first page.
    await wrapper.get('[data-testid="author-sort"]').setValue('date-asc');
    await flushPromises();
    await wrapper.get('[data-testid="start-author-editing"]').trigger('click');

    await wrapper.get('[data-author-work-id="5"]').trigger('dragstart');
    await wrapper.get('[data-author-work-id="6"]').trigger('dragenter');
    expect(wrapper.get('[data-author-work-id="6"]').classes()).toContain('drop-target');
    await wrapper.get('[data-author-work-id="6"]').trigger('drop');
    await flushPromises();
    expect(wrapper.get('[data-author-work-id="6"]').classes()).not.toContain('drop-target');
    expect(createAuthorDirectory).toHaveBeenCalledWith(3, {
      title: 'New Directory',
      entryIds: [5, 6],
    });

    await wrapper.get('[data-author-work-id="7"]').trigger('dragstart');
    await wrapper.get('[data-author-directory-id="5"]').trigger('drop');
    await flushPromises();
    expect(moveEntryToAuthorDirectory).toHaveBeenCalledWith(3, 5, 7);
    await wrapper.get('[data-testid="add-author-directory"]').trigger('click');
    await flushPromises();
    expect(createAuthorDirectory).toHaveBeenLastCalledWith(3, { title: 'New Directory' });
  });

  it('uses Done to save Directory metadata and removes a dropped work without a Save button', async () => {
    const { api, removeEntryFromAuthorDirectory, updateAuthorDirectory } = createAuthorApi();
    const wrapper = await openAuthor(api);
    // Keep the fixture's low-id directory/work cards on the first page
    // (default sort is newest-first now).
    await wrapper.get('[data-testid="author-sort"]').setValue('date-asc');
    await flushPromises();

    const directoryCard = wrapper.get('[data-author-directory-id="5"]');
    expect(directoryCard.findAll('img')).toHaveLength(3);
    await directoryCard.get('[data-directory-open]').trigger('click');
    await wrapper.get('[data-testid="start-directory-editing"]').trigger('click');
    await wrapper.get('[name="directoryTitle"]').setValue('Selected works');
    await wrapper.get('[name="directoryDescription"]').setValue('A curated period');
    expect(wrapper.find('[data-testid="directory-save"]').exists()).toBe(false);
    await wrapper.get('[data-directory-work-id="1"]').trigger('dragstart');
    await wrapper.get('[data-testid="directory-remove-target"]').trigger('drop');
    await flushPromises();
    expect(removeEntryFromAuthorDirectory).toHaveBeenCalledWith(3, 5, 1);

    await wrapper.get('[data-testid="finish-directory-editing"]').trigger('click');
    await flushPromises();

    expect(updateAuthorDirectory).toHaveBeenCalledWith(5, {
      title: 'Selected works',
      description: 'A curated period',
    });
  });

  it('shows faded other-language spellings under author names from the dictionary', async () => {
    const { api } = createAuthorApi();
    api.listTaxonomyAliases = vi.fn(async (vocabulary) => vocabulary === 'producer'
      ? [
        {
          id: 1,
          vocabulary: 'producer' as const,
          partition: '',
          alias: 'bob',
          normalizedAlias: 'bob',
          canonicalName: '鲍勃',
          normalizedCanonical: '鲍勃',
        },
        {
          id: 2,
          vocabulary: 'producer' as const,
          partition: '',
          alias: '鮑勃',
          normalizedAlias: '鮑勃',
          canonicalName: '鲍勃',
          normalizedCanonical: '鲍勃',
        },
      ]
      : []);
    const wrapper = mount(AuthorPage, {
      props: {
        api,
        authors: [
          { id: 3, name: '鲍勃', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
          { id: 4, name: 'Hypergryph', covers: [], galleryType: 'manga', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
        ],
      },
    });
    await flushPromises();

    const bobCard = wrapper.get('[data-author-id="3"]');
    expect(bobCard.get('strong').text()).toBe('鲍勃');
    expect(bobCard.get('.author-name-alternates').text()).toBe('bob / 鮑勃');
    const plainCard = wrapper.get('[data-author-id="4"]');
    expect(plainCard.find('.author-name-alternates').exists()).toBe(false);
  });

  it('shows faded alias spellings next to the name on the author detail board', async () => {
    const { api } = createAuthorApi();
    api.listTaxonomyAliases = vi.fn(async (vocabulary) => vocabulary === 'producer'
      ? [
        {
          id: 1,
          vocabulary: 'producer' as const,
          partition: '',
          alias: 'pirate cat',
          normalizedAlias: 'pirate cat',
          canonicalName: 'Example Author',
          normalizedCanonical: 'example author',
        },
      ]
      : []);
    const wrapper = await openAuthor(api);

    const alternates = wrapper.get('[data-testid="author-detail-alternates"]');
    expect(alternates.text()).toBe('pirate cat');
    expect(alternates.classes()).toContain('author-name-alternates');
  });

  it('filters the Author works with the facet bar (no Authors row)', async () => {
    const { api } = createAuthorApi();
    api.listFacetFilterOptions = vi.fn(async (type: string) => ({
      entryType: type,
      facets: [{
        facetId: 11,
        facetName: 'Genre',
        sectionName: 'Tags',
        tags: [
          { tagId: 1, name: 'Action' },
          { tagId: 2, name: 'Romance' },
        ],
      }],
      allTags: [
        { tagId: 1, name: 'Action' },
        { tagId: 2, name: 'Romance' },
      ],
      authors: [],
      ratingSlots: [],
    }));
    const filterWorks = vi.fn(async (
      _type: string,
      conditions: Array<{ facetId: number | null; tagIds: number[] }>,
      authorIds: number[],
    ) => {
      expect(authorIds).toEqual([3]); // the author is fixed server-side
      return Array.from({ length: 34 }, (_, index) => index + 1)
        .filter((id) => id <= 5)
        .map((id) => ({
          id,
          title: `Work ${id}`,
          type: 'manga',
          coverRef: null,
          previewRef: null,
          previewRefs: [],
          uploadDate: null,
          pageCount: null,
          viewCount: 0,
          likeCount: 0,
          lastViewedAt: null,
        }));
    });
    api.filterEntriesByFacets = filterWorks;

    const wrapper = await openAuthor(api);
    expect(wrapper.find('[data-testid="facet-filter-bar"]').exists()).toBe(true);
    // The Authors row is hidden in the Author page mode.
    await wrapper.get('[data-testid="facet-picker-button"]').trigger('click');
    await flushPromises();
    const facetOptions = wrapper.findAll('[data-testid="facet-dropdown"] .filter-option')
      .map((option) => option.text());
    expect(facetOptions).toContain('Genre');
    expect(facetOptions.some((label) => label.includes('Authors'))).toBe(false);
    expect(wrapper.find('[data-testid="add-author-filter"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="add-usage-filter"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="usage-sort-select"]').exists()).toBe(true);

    const genre = wrapper.findAll('[data-testid="facet-dropdown"] .filter-option')
      .find((option) => option.text().includes('Genre'))!;
    await genre.trigger('click');
    await flushPromises();
    const action = wrapper.findAll('[data-testid="tag-dropdown"] .filter-option')
      .find((option) => option.text() === 'Action')!;
    await action.trigger('click');
    await flushPromises();

    expect(filterWorks).toHaveBeenCalledWith(
      'manga',
      [{ facetId: 11, tagIds: [1] }],
      [3],
      { ratingConditions: [], ratingSort: null, usageConditions: [], usageSort: null },
    );

    // The filter UNFOLDS directories: no pinned row — loose works and
    // Directory members that match are shown as ONE flat set of work cards.
    expect(wrapper.find('[data-testid="author-directory-row"]').exists()).toBe(false);
    const workIds = wrapper.findAll('[data-author-work-id]')
      .map((card) => Number(card.attributes('data-author-work-id')))
      .sort((a, b) => a - b);
    expect(workIds).toEqual([1, 2, 3, 4, 5]); // directory members 1-4 + loose 5
    const grid = wrapper.get('.author-works');
    expect(grid.text()).not.toContain('Work 6');

    await wrapper.get('[data-testid="clear-facet-filters"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="filter-tag-chip"]').exists()).toBe(false);
    // Clearing the filter restores the two-tier Directory structure.
    expect(wrapper.find('[data-testid="author-directory-row"]').exists()).toBe(true);
  });

  it('sorts Author works by usage and annotates each work card', async () => {
    const { api } = createAuthorApi();
    api.listFacetFilterOptions = vi.fn(async (type: string) => ({
      entryType: type,
      facets: [{ facetId: 11, facetName: 'Genre', sectionName: 'Tags', tags: [] }],
      allTags: [],
      authors: [],
      ratingSlots: [],
    }));
    const sortedIds = [
      5,
      ...Array.from({ length: 33 }, (_, index) => (index < 4 ? index + 1 : index + 2)),
    ];
    const filterWorks = vi.fn(async () => sortedIds.map((id) => ({
      id,
      title: `Work ${id}`,
      type: 'manga',
      coverRef: null,
      previewRef: null,
      previewRefs: [],
      uploadDate: null,
      pageCount: null,
      viewCount: id === 5 ? 12 : 0,
      likeCount: 0,
      lastViewedAt: id === 5 ? '2026-09-03T12:00:00.000Z' : null,
    })));
    api.filterEntriesByFacets = filterWorks;

    const wrapper = await openAuthor(api);
    await wrapper.get('[data-testid="usage-sort-select"]').setValue('views');
    await flushPromises();

    expect(filterWorks).toHaveBeenCalled();
    expect(wrapper.findAll('[data-author-work-id]')[0]!.attributes('data-author-work-id')).toBe('5');
    expect(wrapper.get('[data-author-work-id="5"] [data-testid="author-work-usage-note"]').text())
      .toContain('12 views');

    await wrapper.get('[data-testid="usage-sort-select"]').setValue('lastViewed');
    await flushPromises();
    expect(wrapper.get('[data-author-work-id="5"] [data-testid="author-work-usage-note"]').text())
      .toContain('2026-09-03');
  });

  it('adds a rating row in Author edit mode and stores half-step stars', async () => {
    const { api, createAuthorRatingSlot, setAuthorRating } = createAuthorApi();
    const wrapper = await openAuthor(api);

    // Read mode with no slots shows nothing; edit mode reveals the + Rating row.
    expect(wrapper.find('[data-testid="author-ratings"]').exists()).toBe(false);
    await wrapper.get('[data-testid="start-author-editing"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="add-author-rating-button"]').trigger('click');
    await wrapper.get('[data-testid="create-author-rating-form"] input').setValue('Overall');
    await wrapper.get('[data-testid="create-author-rating-form"]').trigger('submit');
    await flushPromises();

    expect(createAuthorRatingSlot).toHaveBeenCalledWith(3, 'Overall');
    const row = wrapper.get('[data-testid="author-ratings"] [data-rating-slot-id="70"]');
    expect(row.text()).toContain('Overall');
    expect(row.get('.star-display-fill').attributes('style')).toContain('0%');

    await row.get('[data-set-stars="4.5"]').trigger('click');
    await flushPromises();
    expect(setAuthorRating).toHaveBeenCalledWith(3, 70, 4.5);
    expect(wrapper.get('[data-testid="author-ratings"] [data-rating-slot-id="70"] .star-display-fill')
      .attributes('style')).toContain('90%');
  });
});
