import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import {
  assignEntryTag,
  findEntriesByFacetFilters,
  listFacetFilterOptions,
} from '../../src/repositories/entry-tag-repository.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';
import {
  createProducer,
  linkEntryProducer,
} from '../../src/repositories/producer-repository.js';
import { createRatingSlot, setEntryRating } from '../../src/repositories/rating-repository.js';

type TestDatabase = ReturnType<typeof createMigratedMemoryDatabase>;

function createComicLayout(database: TestDatabase) {
  const basic = createSection(database, { entryType: 'comic', name: 'Basic Information' });
  const series = createFacet(database, { sectionId: basic.id, name: 'Series' });
  const characters = createFacet(database, { sectionId: basic.id, name: 'Characters' });
  const language = createFacet(database, { sectionId: basic.id, name: 'Language' });
  const tags = createSection(database, { entryType: 'comic', name: 'Tags' });
  return { basic, series, characters, language, tags };
}

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

/**
 * Three comic Entries:
 * - Alpha:  Azur Lane→Series, 中文→Language, Favorite→default
 * - Beta:   GFL→Series, Azur Lane→Language
 * - Gamma:  Azur Lane→Series AND GFL→Series (both in one Facet)
 * Producers: akchu links Alpha+Gamma, Hypergryph links Beta.
 */
function seed(database: TestDatabase) {
  const { series, language, tags } = createComicLayout(database);
  const entryOne = createEntry(database, { title: 'Alpha work', type: 'comic' }).id;
  assignEntryTag(database, { entryId: entryOne, facetId: series.id, name: 'Azur Lane' });
  assignEntryTag(database, { entryId: entryOne, facetId: language.id, name: '中文' });
  assignEntryTag(database, { entryId: entryOne, facetId: tags.defaultFacetId, name: 'Favorite' });
  const entryTwo = createEntry(database, { title: 'Beta work', type: 'comic' }).id;
  assignEntryTag(database, { entryId: entryTwo, facetId: series.id, name: 'GFL' });
  assignEntryTag(database, { entryId: entryTwo, facetId: language.id, name: 'Azur Lane' });
  const entryThree = createEntry(database, { title: 'Gamma work', type: 'comic' }).id;
  assignEntryTag(database, { entryId: entryThree, facetId: series.id, name: 'Azur Lane' });
  assignEntryTag(database, { entryId: entryThree, facetId: series.id, name: 'GFL' });

  const akchu = createProducer(database, { name: 'akchu' });
  const hypergryph = createProducer(database, { name: 'Hypergryph' });
  linkEntryProducer(database, entryOne, akchu.id);
  linkEntryProducer(database, entryThree, akchu.id);
  linkEntryProducer(database, entryTwo, hypergryph.id);

  const tagId = (name: string): number => database.prepare(
    'SELECT id FROM tags WHERE name = ?',
  ).pluck().get(name) as number;

  return {
    entryOne,
    entryTwo,
    entryThree,
    series,
    language,
    tags,
    akchu: akchu.id,
    hypergryph: hypergryph.id,
    tagIds: {
      azur: tagId('Azur Lane'),
      gfl: tagId('GFL'),
      chinese: tagId('中文'),
      favorite: tagId('Favorite'),
    },
  };
}

describe('listFacetFilterOptions', () => {
  it('groups tags by named Facet, keeps allTags and lists type Authors', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const { series, language, tags } = seed(database);

    // A second type must not leak into the comic options.
    const mangaBasic = createSection(database, { entryType: 'manga', name: 'Basic Information' });
    const mangaLanguage = createFacet(database, { sectionId: mangaBasic.id, name: 'Language' });
    const mangaEntry = createEntry(database, { title: 'Manga work', type: 'manga' }).id;
    assignEntryTag(database, { entryId: mangaEntry, facetId: mangaLanguage.id, name: 'Azur Lane' });
    const mangaAuthor = createProducer(database, { name: 'Manga-sensei' });
    linkEntryProducer(database, mangaEntry, mangaAuthor.id);

    const options = listFacetFilterOptions(database, 'comic');
    expect(options.entryType).toBe('comic');
    expect(options.facets.map((facet) => facet.facetName)).toEqual(['Series', 'Language']);

    const seriesOption = options.facets.find((facet) => facet.facetName === 'Series')!;
    expect(seriesOption.sectionName).toBe('Basic Information');
    expect(seriesOption.tags.map((tag) => tag.name)).toEqual(['Azur Lane', 'GFL']);

    const languageOption = options.facets.find((facet) => facet.facetName === 'Language')!;
    expect(languageOption.tags.map((tag) => tag.name).sort()).toEqual(['Azur Lane', '中文']);

    // The unnamed default Facet is NOT a filter row, but its tag still shows
    // up in allTags so it can never disappear from filtering.
    expect(options.facets.some((facet) => facet.facetName === '')).toBe(false);
    expect(options.allTags.map((tag) => tag.name).sort()).toEqual(
      ['Azur Lane', 'Favorite', 'GFL', '中文'].sort(),
    );

    // Authors are scoped to the type (manga author excluded).
    expect(options.authors.map((author) => author.name)).toEqual(['akchu', 'Hypergryph']);
    void series;
    void language;
    void tags;
  });

  it('returns empty options for a type without tagged entries', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    createComicLayout(database);
    expect(listFacetFilterOptions(database, 'comic')).toEqual({
      entryType: 'comic',
      facets: [],
      allTags: [],
      authors: [],
      ratingSlots: [],
    });
  });

  it('scopes the aggregation to one Author when authorId is given', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const { akchu, hypergryph } = seed(database);

    // akchu's works only: his authors list is himself; Beta's GFL placement
    // under Hypergryph stays out of akchu's Series options.
    const akchuOptions = listFacetFilterOptions(database, 'comic', akchu);
    expect(akchuOptions.authors.map((author) => author.name)).toEqual(['akchu']);
    expect(akchuOptions.facets.find((facet) => facet.facetName === 'Series')!.tags
      .map((tag) => tag.name)).toEqual(['Azur Lane', 'GFL']);

    // Hypergryph's works are a different slice of the same type.
    const hyperOptions = listFacetFilterOptions(database, 'comic', hypergryph);
    expect(hyperOptions.authors.map((author) => author.name)).toEqual(['Hypergryph']);
    expect(hyperOptions.facets.find((facet) => facet.facetName === 'Series')!.tags
      .map((tag) => tag.name)).toEqual(['GFL']);
    expect(hyperOptions.facets.find((facet) => facet.facetName === 'Language')!.tags
      .map((tag) => tag.name)).toEqual(['Azur Lane']);
  });
});

describe('findEntriesByFacetFilters', () => {
  it('matches the tag only when it sits in the selected Facet', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const { entryOne, entryTwo, entryThree, series, language, tagIds } = seed(database);

    const viaSeries = findEntriesByFacetFilters(database, {
      entryType: 'comic',
      conditions: [{ facetId: series.id, tagIds: [tagIds.azur] }],
      authorIds: [],
    });
    expect(viaSeries.map((entry) => entry.id).sort((a, b) => a - b)).toEqual(
      [entryOne, entryThree].sort((a, b) => a - b),
    );

    const viaLanguage = findEntriesByFacetFilters(database, {
      entryType: 'comic',
      conditions: [{ facetId: language.id, tagIds: [tagIds.azur] }],
      authorIds: [],
    });
    expect(viaLanguage.map((entry) => entry.id)).toEqual([entryTwo]);
  });

  it('matches tags in ANY facet when facetId is null (all-tags row)', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const { entryOne, entryTwo, entryThree, tagIds } = seed(database);

    const matches = findEntriesByFacetFilters(database, {
      entryType: 'comic',
      conditions: [{ facetId: null, tagIds: [tagIds.azur] }],
      authorIds: [],
    });
    // All three works carry Azur Lane, some under different Facets.
    expect(matches.map((entry) => entry.id).sort((a, b) => a - b)).toEqual(
      [entryOne, entryTwo, entryThree].sort((a, b) => a - b),
    );
  });

  it('ANDs tags within one row: more tags always narrow the result', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const { entryTwo, entryThree, series, tagIds } = seed(database);

    // Only Gamma carries BOTH Azur Lane and GFL in the Series Facet.
    const bothInSeries = findEntriesByFacetFilters(database, {
      entryType: 'comic',
      conditions: [{ facetId: series.id, tagIds: [tagIds.azur, tagIds.gfl] }],
      authorIds: [],
    });
    expect(bothInSeries.map((entry) => entry.id)).toEqual([entryThree]);

    // All-tags row ANDs too: Beta carries Azur Lane (in Language) AND GFL
    // (in Series), so it satisfies the any-facet AND just like Gamma.
    const bothAnywhere = findEntriesByFacetFilters(database, {
      entryType: 'comic',
      conditions: [{ facetId: null, tagIds: [tagIds.azur, tagIds.gfl] }],
      authorIds: [],
    });
    expect(bothAnywhere.map((entry) => entry.id).sort((a, b) => a - b)).toEqual(
      [entryTwo, entryThree].sort((a, b) => a - b),
    );
  });

  it('ANDs rows together', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const { entryTwo, series, language, tagIds } = seed(database);

    // GFL in Series AND Azur Lane in Language -> only Beta.
    const bothRows = findEntriesByFacetFilters(database, {
      entryType: 'comic',
      conditions: [
        { facetId: series.id, tagIds: [tagIds.gfl] },
        { facetId: language.id, tagIds: [tagIds.azur] },
      ],
      authorIds: [],
    });
    expect(bothRows.map((entry) => entry.id)).toEqual([entryTwo]);

    // The same tag under two different Facets can never satisfy both rows:
    // no single Entry carries Azur Lane twice.
    const sameTagTwoFacets = findEntriesByFacetFilters(database, {
      entryType: 'comic',
      conditions: [
        { facetId: series.id, tagIds: [tagIds.azur] },
        { facetId: language.id, tagIds: [tagIds.azur] },
      ],
      authorIds: [],
    });
    expect(sameTagTwoFacets).toEqual([]);
  });

  it('filters by Authors alone (OR inside the author list)', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const { entryOne, entryTwo, entryThree, akchu, hypergryph } = seed(database);

    const akchuWorks = findEntriesByFacetFilters(database, {
      entryType: 'comic',
      conditions: [],
      authorIds: [akchu],
    });
    expect(akchuWorks.map((entry) => entry.id).sort((a, b) => a - b)).toEqual(
      [entryOne, entryThree].sort((a, b) => a - b),
    );

    const eitherAuthor = findEntriesByFacetFilters(database, {
      entryType: 'comic',
      conditions: [],
      authorIds: [akchu, hypergryph],
    });
    expect(eitherAuthor.map((entry) => entry.id).sort((a, b) => a - b)).toEqual(
      [entryOne, entryTwo, entryThree].sort((a, b) => a - b),
    );
  });

  it('ANDs the Author condition with tag rows', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const { entryThree, series, akchu, tagIds } = seed(database);

    // akchu works whose Series Facet holds BOTH Azur Lane and GFL -> Gamma only.
    const combined = findEntriesByFacetFilters(database, {
      entryType: 'comic',
      conditions: [{ facetId: series.id, tagIds: [tagIds.azur, tagIds.gfl] }],
      authorIds: [akchu],
    });
    expect(combined.map((entry) => entry.id)).toEqual([entryThree]);
  });

  it('returns lean summaries ordered by title and filters by type', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const { series, tagIds } = seed(database);

    const mangaBasic = createSection(database, { entryType: 'manga', name: 'Basic Information' });
    const mangaSeries = createFacet(database, { sectionId: mangaBasic.id, name: 'Series' });
    const mangaEntry = createEntry(database, { title: 'Manga with GFL', type: 'manga' }).id;
    assignEntryTag(database, { entryId: mangaEntry, facetId: mangaSeries.id, name: 'GFL' });

    const matches = findEntriesByFacetFilters(database, {
      entryType: 'comic',
      conditions: [{ facetId: series.id, tagIds: [tagIds.gfl] }],
      authorIds: [],
    });
    expect(matches.map((entry) => entry.title)).toEqual(['Beta work', 'Gamma work']);
    expect(matches[0]).toMatchObject({
      coverRef: null,
      previewRef: null,
      previewRefs: [],
      uploadDate: null,
      pageCount: null,
    });
  });
});

describe('Facet filter HTTP routes', () => {
  it('GET facet-options returns aggregated rows and Authors for one type', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    seed(database);

    const response = await app.request('/api/entries/facet-options/comic');
    expect(response.status).toBe(200);
    const body = await response.json() as {
      entryType: string;
      facets: Array<{ facetName: string; tags: Array<{ name: string }> }>;
      authors: Array<{ authorId: number; name: string }>;
    };
    expect(body.entryType).toBe('comic');
    expect(body.facets[0]).toMatchObject({ facetName: 'Series' });
    expect(body.facets[0]!.tags.map((tag) => tag.name)).toEqual(['Azur Lane', 'GFL']);
    expect(body.authors.map((author) => author.name)).toEqual(['akchu', 'Hypergryph']);
  });

  it('GET facet-options accepts an authorId query to scope the rows', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const { akchu, hypergryph } = seed(database);

    const scoped = await app.request(`/api/entries/facet-options/comic?authorId=${hypergryph}`);
    expect(scoped.status).toBe(200);
    const body = await scoped.json() as {
      facets: Array<{ facetName: string; tags: Array<{ name: string }> }>;
      authors: Array<{ name: string }>;
    };
    expect(body.authors.map((author) => author.name)).toEqual(['Hypergryph']);
    expect(body.facets.find((facet) => facet.facetName === 'Series')!.tags
      .map((tag) => tag.name)).toEqual(['GFL']);

    const invalid = await app.request(`/api/entries/facet-options/comic?authorId=${akchu}-x`);
    expect(invalid.status).toBe(400);
  });

  it('POST filter supports tag rows, Author rows and rejects duplicate tag ids', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const { series, akchu, tagIds } = seed(database);

    const tagOnly = await app.request('/api/entries/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entryType: 'comic',
        conditions: [{ facetId: series.id, tagIds: [tagIds.azur] }],
        sort: 'title-asc',
      }),
    });
    expect(tagOnly.status).toBe(200);
    expect(((await tagOnly.json() as { items: Array<{ title: string }> }).items).map((entry) => entry.title))
      .toEqual(['Alpha work', 'Gamma work']);

    const authorOnly = await app.request('/api/entries/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entryType: 'comic', conditions: [], authorIds: [akchu], sort: 'title-asc',
      }),
    });
    expect(authorOnly.status).toBe(200);
    expect(((await authorOnly.json() as { items: Array<{ title: string }> }).items).map((entry) => entry.title))
      .toEqual(['Alpha work', 'Gamma work']);
    void series;

    const duplicateTags = await app.request('/api/entries/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entryType: 'comic',
        conditions: [{ facetId: null, tagIds: [tagIds.azur, tagIds.azur] }],
      }),
    });
    expect(duplicateTags.status).toBe(400);
  });

  it('filters and sorts by rating slots, sinking unrated entries', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const slot = createRatingSlot(database, { kind: 'entry', entryType: 'comic', name: 'Quality' });
    const rated5 = createEntry(database, { title: 'Rated Five', type: 'comic' }).id;
    const rated3 = createEntry(database, { title: 'Rated Three', type: 'comic' }).id;
    const unrated = createEntry(database, { title: 'Unrated Work', type: 'comic' }).id;
    setEntryRating(database, { entryId: rated5, slotId: slot.id, stars: 5 });
    setEntryRating(database, { entryId: rated3, slotId: slot.id, stars: 3 });

    const filter = (ratingConditions: never[] = [], ratingSort: unknown = null) => (
      findEntriesByFacetFilters(database, {
        entryType: 'comic',
        conditions: [],
        authorIds: [],
        ratingConditions,
        ratingSort: ratingSort as never,
      }).map((entry) => entry.id)
    );

    expect(filter([{ slotId: slot.id, operator: 'eq', stars: 5 } as never]))
      .toEqual([rated5]);
    expect(filter([{ slotId: slot.id, operator: 'gt', stars: 2.5 } as never]))
      .toEqual(expect.arrayContaining([rated3, rated5]));
    expect(filter([{ slotId: slot.id, operator: 'lt', stars: 4 } as never]))
      .toEqual([rated3]);
    // Unrated means "no stars given" — never zero.
    expect(filter([{ slotId: slot.id, operator: 'unrated', stars: null } as never]))
      .toEqual([unrated]);
    // eq combined with a rating AND across conditions.
    expect(filter([
      { slotId: slot.id, operator: 'gt', stars: 2 } as never,
      { slotId: slot.id, operator: 'lt', stars: 4 } as never,
    ])).toEqual([rated3]);

    // Sort: high to low, unrated sinks below every rated entry.
    expect(filter([], { slotId: slot.id, direction: 'desc' }))
      .toEqual([rated5, rated3, unrated]);

    // Options surface the shared slots for the filter UI.
    expect(listFacetFilterOptions(database, 'comic').ratingSlots)
      .toEqual([{ id: slot.id, name: 'Quality', sortOrder: 0 }]);
  });

  it('rejects rating conditions pointing at a foreign Gallery', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const slot = createRatingSlot(database, { kind: 'entry', entryType: 'manga', name: 'Style' });
    createEntry(database, { title: 'Work', type: 'comic' });

    expect(() => findEntriesByFacetFilters(database, {
      entryType: 'comic',
      conditions: [],
      authorIds: [],
      ratingConditions: [{ slotId: slot.id, operator: 'eq', stars: 4 }],
      ratingSort: null,
    })).toThrow(/does not belong/);

    const app = createApiApp(database);
    const response = await app.request('/api/entries/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entryType: 'comic',
        conditions: [],
        authorIds: [],
        ratingConditions: [{ slotId: slot.id, operator: 'unrated', stars: null }],
        ratingSort: null,
      }),
    });
    expect(response.status).toBe(409);
  });
});
