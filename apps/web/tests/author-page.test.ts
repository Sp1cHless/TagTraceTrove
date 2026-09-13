// @vitest-environment jsdom

import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AuthorPage from '../src/AuthorPage.vue';
import type { GalleryApi } from '../src/api/gallery.js';
import { setLocale } from '../src/i18n.js';

vi.stubGlobal('scrollTo', vi.fn());

function createAuthorApi() {
  const works = Array.from({ length: 34 }, (_, index) => ({
    id: index + 1,
    title: `Work ${index + 1}`,
    type: 'manga',
    coverRef: index < 5 ? `cover-${index + 1}.webp` : null,
    previewRefs: index === 0 || index === 4 ? [`preview-${index + 1}.webp`] : [],
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
  const listEntrySources = vi.fn(async (entryId: number) => [{
    entryId,
    contentId: entryId + 100,
    sourceKey: entryId === 5 ? 'known:hitomi' : 'known:18comic',
    sourceName: entryId === 5 ? 'Hitomi' : '18comic',
    host: entryId === 5 ? 'hitomi.la' : '18comic.vip',
    url: entryId === 5
      ? 'https://hitomi.la/reader/5.html'
      : `https://18comic.vip/album/${entryId}/`,
  }]);
  const mergeAuthorEntries = vi.fn(async (input: Parameters<GalleryApi['mergeAuthorEntries']>[0]) => {
    looseEntries = looseEntries.filter((work) => work.id !== input.absorbEntryId);
    return {
      keptEntryId: input.keepEntryId,
      absorbedEntryId: input.absorbEntryId,
      copiedTagCount: input.copyTags ? 1 : 0,
      copiedSourceCount: input.sourceUrls.length,
      sources: [],
      mediaCleanupFailed: false,
    };
  });
  const api = {
    assetUrl: (path: string) => path,
    getAuthor,
    createAuthorDirectory,
    moveEntryToAuthorDirectory,
    removeEntryFromAuthorDirectory,
    updateAuthorDirectory,
    listEntrySources,
    mergeAuthorEntries,
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
    queryProducerPage: vi.fn(async (input) => {
      const items = [{ id: 3, name: 'Example Author', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false }];
      return { items, total: items.length, page: input.page, pageSize: input.pageSize };
    }),
    listFacetFilterOptions: vi.fn(async (type: string) => ({
      entryType: type,
      facets: [],
      allTags: [],
      authors: [],
      ratingSlots: [],
    })),
    queryEntryPage: vi.fn(async (input) => {
      const allWorks = [...looseEntries, ...directory.entries];
      const source = input.producerDirectoryId === directory.id
        ? directory.entries
        : input.looseForProducerId !== undefined
          ? looseEntries
          : allWorks;
      const offset = (input.page - 1) * input.pageSize;
      return {
        items: source.slice(offset, offset + input.pageSize),
        total: source.length,
        page: input.page,
        pageSize: input.pageSize,
      };
    }),
  } as unknown as GalleryApi;
  return {
    api,
    createAuthorDirectory,
    moveEntryToAuthorDirectory,
    removeEntryFromAuthorDirectory,
    updateAuthorDirectory,
    listEntrySources,
    mergeAuthorEntries,
    createAuthorRatingSlot,
    setAuthorRating,
  };
}

async function openAuthor(api: GalleryApi) {
  const wrapper = mount(AuthorPage, {
    props: { api, authors: [{ id: 3, name: 'Example Author', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false }] },
  });
  await flushPromises();
  await wrapper.get('[data-author-id="3"]').trigger('click');
  await flushPromises();
  return wrapper;
}

describe('AuthorPage', () => {
  beforeEach(() => setLocale('en'));

  it('lets a single work fill both Author list and detail cover mosaics', async () => {
    const { api } = createAuthorApi();
    const summary = {
      id: 3,
      name: 'Example Author',
      covers: ['only-cover.webp'],
      galleryType: 'manga',
      viewCount: 0,
      likeCount: 0,
      lastViewedAt: null,
      nsfw: false,
    };
    api.queryProducerPage = vi.fn(async (input) => ({
      items: [summary],
      total: 1,
      page: input.page,
      pageSize: input.pageSize,
    }));
    api.getAuthor = vi.fn(async () => ({
      id: 3,
      name: 'Example Author',
      occupation: 'Artist',
      artworkRef: null,
      content: null,
      tags: [],
      looseEntries: [],
      looseEntryCount: 0,
      directories: [],
      ratings: [],
      galleryType: 'manga',
      workTypes: ['manga'],
      workCoverRefs: ['only-cover.webp'],
      usage: { viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
    }));

    const wrapper = mount(AuthorPage, { props: { api, authors: [summary] } });
    await flushPromises();

    const listCover = wrapper.get('[data-author-id="3"] .author-list-cover');
    expect(listCover.attributes('data-cover-count')).toBe('1');
    expect((listCover.element as HTMLElement).style.gridTemplateColumns)
      .toBe('repeat(1, minmax(0, 1fr))');

    await wrapper.get('[data-author-id="3"]').trigger('click');
    await flushPromises();
    const detailCover = wrapper.get('.author-cover-grid');
    expect(detailCover.attributes('data-cover-count')).toBe('1');
    expect((detailCover.element as HTMLElement).style.gridTemplateColumns)
      .toBe('repeat(1, minmax(0, 1fr))');
  });

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

  it('scrolls an Author detail to the top when opened from a scrolled Author gallery', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const scrollY = vi.spyOn(window, 'scrollY', 'get').mockReturnValue(680);
    const { api } = createAuthorApi();
    const wrapper = mount(AuthorPage, {
      props: { api, authors: [{ id: 3, name: 'Example Author', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false }] },
    });

    await flushPromises();
    await wrapper.get('[data-author-id="3"]').trigger('click');
    await flushPromises();

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
    scrollTo.mockClear();
    scrollY.mockReturnValue(0);
    await wrapper.get('[data-testid="author-information-board"] .author-toolbar .text-button').trigger('click');
    await flushPromises();
    expect(scrollTo).toHaveBeenCalledWith({ top: 680, left: 0, behavior: 'auto' });
    scrollY.mockRestore();
    scrollTo.mockRestore();
  });

  it('shows a fixed scroll-to-top control on an Author detail', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const { api } = createAuthorApi();
    const wrapper = await openAuthor(api);

    await wrapper.get('[data-testid="author-scroll-top"]').trigger('click');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: 'smooth' });
    scrollTo.mockRestore();
  });

  it('offers random sorting in both the Author list and Author works controls', async () => {
    const { api } = createAuthorApi();
    const wrapper = mount(AuthorPage, {
      props: { api, authors: [{ id: 3, name: 'Example Author', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false }] },
    });

    const listRandom = wrapper.get('[data-testid="author-mode-random"]');
    expect(listRandom.attributes('aria-label')).toBe('Random');
    await listRandom.trigger('click');
    expect(listRandom.classes()).toContain('recent-mode-active');

    await flushPromises();
    await wrapper.get('[data-author-id="3"]').trigger('click');
    await flushPromises();
    const option = wrapper.get('[data-testid="author-sort"] option[value="random"]');
    expect(option.text()).toBe('Random');
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
    api.queryProducerPage = vi.fn(async (input) => ({
      items: input.ownTagIds.length > 0 ? [matchingAuthor] : [
        { id: 3, name: 'Example Author', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
        matchingAuthor,
      ],
      total: input.ownTagIds.length > 0 ? 1 : 2,
      page: input.page,
      pageSize: input.pageSize,
    }));
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
    expect(api.queryProducerPage).toHaveBeenLastCalledWith(expect.objectContaining({ ownTagIds: [2], relatedEntryTagIds: [] }));
    expect(wrapper.get('[data-testid="author-tag-combobox-toggle"]').text()).toContain('Circle');

    await wrapper.get('[data-testid="add-work-tag-filter"]').trigger('click');
    await wrapper.get('[data-testid="work-tag-combobox-toggle"]').trigger('click');
    await wrapper.get('[data-testid="work-tag-combobox-input"]').setValue('action');
    await wrapper.get('[data-testid="work-tag-combobox-option"]').trigger('click');
    await flushPromises();
    expect(api.queryProducerPage).toHaveBeenLastCalledWith(expect.objectContaining({ ownTagIds: [2], relatedEntryTagIds: [5] }));
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

  it('leaves a collection straight from the Author detail menu when it is already joined', async () => {
    const { api } = createAuthorApi();
    const collection = {
      id: 7,
      kind: 'producer' as const,
      title: 'Favourite authors',
      description: '',
      nsfw: false,
      sortOrder: 0,
      children: [],
      entries: [],
      producers: [],
    };
    let memberIds = [collection.id];
    const addCollectionProducer = vi.fn(async () => undefined);
    const removeCollectionProducer = vi.fn(async () => {
      memberIds = memberIds.filter((id) => id !== collection.id);
    });
    api.listCollections = vi.fn(async () => [collection]);
    api.listCollectionsForProducer = vi.fn(async () => memberIds);
    api.addCollectionProducer = addCollectionProducer;
    api.removeCollectionProducer = removeCollectionProducer;

    const wrapper = await openAuthor(api);
    await wrapper.get('[data-testid="author-add-to-collection"] button').trigger('click');
    await flushPromises();

    const option = wrapper.get('[data-testid="author-add-to-collection"] .add-to-collection-option');
    expect(option.text()).toContain('✓ Favourite authors');
    expect(option.attributes('aria-checked')).toBe('true');
    expect(option.attributes('disabled')).toBeUndefined();

    await option.trigger('click');
    await flushPromises();

    expect(removeCollectionProducer).toHaveBeenCalledWith(collection.id, 3);
    expect(addCollectionProducer).not.toHaveBeenCalled();
    expect(option.text()).not.toContain('✓');
    expect(option.attributes('aria-checked')).toBe('false');
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
    // 1 always-visible Directory card + one screen-fitted page of loose works:
    // 6 grid columns × the rows-per-page preference = 30, so every loose work
    // fits and no page bar appears.
    expect(wrapper.findAll('[data-author-card]').length).toBe(31);
    expect(wrapper.findAll('[data-author-work-id]').length).toBe(30);
    expect(wrapper.find('[data-testid="author-next-page"]').exists()).toBe(false);
    // The Directory stays visible on every page.
    expect(wrapper.findAll('[data-author-directory-id]').length).toBe(1);
  });

  it('requests the page size the Author works grid can actually show', async () => {
    const { api } = createAuthorApi();
    // 40 loose works: two screen-fitted pages of 30 + 10.
    const works = Array.from({ length: 40 }, (_, index) => ({
      id: 100 + index,
      title: `Extra Work ${index + 1}`,
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
    const requestedPageSizes: number[] = [];
    api.queryEntryPage = vi.fn(async (input: Parameters<GalleryApi['queryEntryPage']>[0]) => {
      if (input.looseForProducerId === undefined) {
        return { items: [], total: 0, page: input.page, pageSize: input.pageSize };
      }
      requestedPageSizes.push(input.pageSize);
      const offset = (input.page - 1) * input.pageSize;
      return {
        items: works.slice(offset, offset + input.pageSize),
        total: works.length,
        page: input.page,
        pageSize: input.pageSize,
      };
    });
    const wrapper = await openAuthor(api);

    // 30 = 6 columns × 5 rows, not a fixed 26.
    expect(requestedPageSizes).toContain(30);
    expect(wrapper.findAll('[data-author-work-id]').length).toBe(30);

    await wrapper.get('[data-testid="author-next-page"]').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-author-work-id]').length).toBe(10);
  });

  it('renders loose Author works with the shared Gallery cover and Preview stack', async () => {
    const { api } = createAuthorApi();
    const wrapper = await openAuthor(api);

    const work = wrapper.get('[data-author-work-id="5"]');
    expect(work.attributes('data-testid')).toBe('shared-entry-card');
    expect(work.findAll('.entry-stack-image')).toHaveLength(2);
  });

  it('renders works inside an Author Directory with the shared Gallery media stack', async () => {
    const { api } = createAuthorApi();
    const wrapper = await openAuthor(api);

    await wrapper.get('[data-author-directory-id="5"] [data-directory-open]').trigger('click');
    await flushPromises();

    const work = wrapper.get('[data-directory-work-id="1"]');
    expect(work.attributes('data-testid')).toBe('shared-entry-card');
    expect(work.findAll('.entry-stack-image')).toHaveLength(2);
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

  it('organizes loose works through touch selection targets while keeping drag support', async () => {
    const { api, createAuthorDirectory, moveEntryToAuthorDirectory } = createAuthorApi();
    const wrapper = await openAuthor(api);
    await wrapper.get('[data-testid="author-sort"]').setValue('date-asc');
    await wrapper.get('[data-testid="start-author-editing"]').trigger('click');

    expect(wrapper.get('[data-testid="author-work-move-hint"]').text()).toContain('Tap a work');
    const source = wrapper.get('[data-author-work-id="5"]');
    await source.get('.author-card-main').trigger('click');
    expect(source.get('.author-card-main').attributes('aria-pressed')).toBe('true');
    expect(source.classes()).toContain('selected-work');

    await wrapper.get('[data-group-with-work-id="6"]').trigger('click');
    await flushPromises();
    expect(createAuthorDirectory).toHaveBeenCalledWith(3, {
      title: 'New Directory',
      entryIds: [5, 6],
    });

    await wrapper.get('[data-author-work-id="7"] .author-card-main').trigger('click');
    await wrapper.get('[data-move-work-to-directory-id="5"]').trigger('click');
    await flushPromises();
    expect(moveEntryToAuthorDirectory).toHaveBeenCalledWith(3, 5, 7);

    await wrapper.get('[data-author-work-id="8"] .author-card-main').trigger('click');
    await wrapper.get('[data-testid="finish-author-editing"]').trigger('click');
    await wrapper.get('[data-testid="start-author-editing"]').trigger('click');
    expect(wrapper.find('[data-move-work-to-directory-id]').exists()).toBe(false);
    expect(wrapper.get('[data-author-work-id="8"] .author-card-main').attributes('aria-pressed')).toBe('false');
  });

  it('keeps work merging separate from Directory editing and confirms the title, Tags, and Sources', async () => {
    const { api, createAuthorDirectory, listEntrySources, mergeAuthorEntries } = createAuthorApi();
    const wrapper = await openAuthor(api);
    await wrapper.get('[data-testid="author-sort"]').setValue('date-asc');
    await flushPromises();

    expect(wrapper.find('[data-testid="start-entry-merge"]').exists()).toBe(false);
    await wrapper.get('[data-testid="start-author-editing"]').trigger('click');
    expect(wrapper.get('[data-testid="start-entry-merge"]').text()).toContain('Merge works');
    await wrapper.get('[data-testid="start-entry-merge"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="entry-merge-hint"]').text()).toContain('Select two works');
    await wrapper.get('[data-author-work-id="5"] .author-card-main').trigger('click');
    await wrapper.get('[data-author-work-id="6"] .author-card-main').trigger('click');
    await flushPromises();

    expect(createAuthorDirectory).not.toHaveBeenCalled();
    expect(wrapper.find('[data-group-with-work-id]').exists()).toBe(false);
    expect(listEntrySources).toHaveBeenCalledWith(5);
    expect(listEntrySources).toHaveBeenCalledWith(6);
    const dialog = wrapper.get('[data-testid="entry-merge-confirmation"]');
    expect(dialog.text()).toContain('Work 5');
    expect(dialog.text()).toContain('Work 6');
    expect(dialog.text()).toContain('Merge Tags');
    // 主体按来源网址区分，并标出哪一条会被删除
    const keeperOptions = dialog.findAll('[data-merge-keeper-entry-id]');
    expect(keeperOptions).toHaveLength(2);
    expect(keeperOptions[0]!.text()).toContain('https://hitomi.la/reader/5.html');
    expect(keeperOptions[1]!.text()).toContain('https://18comic.vip/album/6/');
    expect(keeperOptions[0]!.text()).toContain('Will be kept');
    expect(keeperOptions[1]!.text()).toContain('Will be deleted');

    await dialog.get('[data-merge-keeper-radio-id="6"]').setValue(true);
    await flushPromises();
    expect(dialog.text()).toContain('https://hitomi.la/reader/5.html');
    expect(keeperOptions[0]!.text()).toContain('Will be deleted');
    expect(keeperOptions[1]!.text()).toContain('Will be kept');

    // 标题默认跟随主体，可以改选另一条（将被删除的那条）的标题
    const titleInput = dialog.get('[data-testid="entry-merge-title-input"]');
    expect((titleInput.element as HTMLInputElement).value).toBe('Work 6');
    await dialog.get('[data-merge-title-source-id="5"]').setValue(true);
    await flushPromises();
    expect((titleInput.element as HTMLInputElement).value).toBe('Work 5');
    // 选完后仍可自行改写
    await titleInput.setValue('Merged title win');
    await flushPromises();

    await dialog.get('[data-testid="confirm-entry-merge"]').trigger('click');
    await flushPromises();

    expect(mergeAuthorEntries).toHaveBeenCalledWith({
      authorId: 3,
      keepEntryId: 6,
      absorbEntryId: 5,
      copyTags: true,
      title: 'Merged title win',
      sourceUrls: ['https://hitomi.la/reader/5.html'],
    });
    expect(wrapper.find('[data-testid="entry-merge-confirmation"]').exists()).toBe(false);
    expect(wrapper.find('[data-author-work-id="5"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="start-entry-merge"]').exists()).toBe(true);
    expect(wrapper.emitted('works-changed')).toHaveLength(1);
  });

  it('ignores a stale Source response after merge mode is cancelled', async () => {
    const { api, listEntrySources } = createAuthorApi();
    const sourceResolvers: Array<(sources: []) => void> = [];
    listEntrySources.mockImplementation(() => new Promise((resolve) => {
      sourceResolvers.push(resolve);
    }));
    const wrapper = await openAuthor(api);

    await wrapper.get('[data-testid="start-author-editing"]').trigger('click');
    await wrapper.get('[data-testid="start-entry-merge"]').trigger('click');
    await flushPromises();
    const workButtons = wrapper.findAll('[data-author-work-id] .author-card-main');
    await workButtons[0]!.trigger('click');
    const secondSelection = workButtons[1]!.trigger('click');
    await Promise.resolve();
    expect(sourceResolvers).toHaveLength(2);

    await wrapper.get('[data-testid="cancel-entry-merge"]').trigger('click');
    sourceResolvers.forEach((resolve) => resolve([]));
    await secondSelection;
    await flushPromises();

    expect(wrapper.find('[data-testid="entry-merge-confirmation"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="cancel-entry-merge"]').exists()).toBe(false);
    expect(wrapper.find('.error-message').exists()).toBe(false);
  });

  it('moves a Directory member back to loose works through touch selection', async () => {
    const { api, removeEntryFromAuthorDirectory } = createAuthorApi();
    const wrapper = await openAuthor(api);
    await wrapper.get('[data-author-directory-id="5"] [data-directory-open]').trigger('click');
    await wrapper.get('[data-testid="start-directory-editing"]').trigger('click');

    expect(wrapper.get('[data-testid="directory-work-move-hint"]').text()).toContain('Tap a work');
    const removeTarget = wrapper.get('[data-testid="directory-remove-target"]');
    expect(removeTarget.attributes('disabled')).toBeDefined();

    const source = wrapper.get('[data-directory-work-id="1"]');
    await source.get('.author-card-main').trigger('click');
    expect(source.get('.author-card-main').attributes('aria-pressed')).toBe('true');
    expect(source.classes()).toContain('selected-work');
    expect(removeTarget.attributes('disabled')).toBeUndefined();

    await removeTarget.trigger('click');
    await flushPromises();
    expect(removeEntryFromAuthorDirectory).toHaveBeenCalledWith(3, 5, 1);
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
    api.queryProducerPage = vi.fn(async (input) => {
      const items = [
        { id: 3, name: '鲍勃', covers: [], galleryType: 'game', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
        { id: 4, name: 'Hypergryph', covers: [], galleryType: 'manga', viewCount: 0, likeCount: 0, lastViewedAt: null, nsfw: false },
      ];
      return { items, total: items.length, page: input.page, pageSize: input.pageSize };
    });
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
    const filterWorks = vi.fn(async (input: Parameters<GalleryApi['queryEntryPage']>[0]) => {
      expect(input.authorIds).toEqual([3]); // the author is fixed server-side
      const items = Array.from({ length: 34 }, (_, index) => index + 1)
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
      const start = (input.page - 1) * input.pageSize;
      return { items: items.slice(start, start + input.pageSize), total: items.length, page: input.page, pageSize: input.pageSize };
    });
    api.queryEntryPage = filterWorks;

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

    expect(filterWorks).toHaveBeenCalledWith(expect.objectContaining({
      entryType: 'manga',
      conditions: [{ facetId: 11, tagIds: [1] }],
      authorIds: [3],
      ratingConditions: [],
      ratingSort: null,
      usageConditions: [],
      usageSort: null,
      page: 1,
      pageSize: 30,
    }));

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
    const filterWorks = vi.fn(async (input: Parameters<GalleryApi['queryEntryPage']>[0]) => {
      const items = sortedIds.map((id) => ({
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
      }));
      const start = (input.page - 1) * input.pageSize;
      return { items: items.slice(start, start + input.pageSize), total: items.length, page: input.page, pageSize: input.pageSize };
    });
    api.queryEntryPage = filterWorks;

    const wrapper = await openAuthor(api);
    await wrapper.get('[data-testid="usage-sort-select"]').setValue('views');
    await flushPromises();

    expect(filterWorks).toHaveBeenCalled();
    expect(wrapper.findAll('[data-author-work-id]')[0]!.attributes('data-author-work-id')).toBe('5');
    expect(wrapper.get('[data-author-work-id="5"] [data-testid="shared-card-note"]').text())
      .toContain('12 views');

    await wrapper.get('[data-testid="usage-sort-select"]').setValue('lastViewed');
    await flushPromises();
    expect(wrapper.get('[data-author-work-id="5"] [data-testid="shared-card-note"]').text())
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
