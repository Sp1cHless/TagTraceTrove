import { describe, expect, it } from 'vitest';
import type { SyncSnapshot } from '@t3/shared';
import { createOfflineLibrary } from '../src/offline/offline-library.js';

function makeSnapshot(): SyncSnapshot {
  return {
    header: {
      libraryId: 'library-1', syncEpoch: 'epoch-1', snapshotSeq: 1,
      generatedAt: '2026-09-13T00:00:00.000Z', sqliteSchemaVersion: 15,
      snapshotFormatVersion: 1,
      counts: { entries: 3, producers: 1, entryContents: 1, entryTags: 2, collections: 1 },
      checksum: 'test',
    },
    payload: {
      entries: [
        { id: 1, title: 'Endfield', type: 'game', coverRef: 'entries/1/cover.webp', previewRef: null, previewRefs: [], pageCount: null, uploadDate: '2026-09-12', createdAt: '2026-09-12', updatedAt: '2026-09-12' },
        { id: 2, title: 'Hades II', type: 'game', coverRef: null, previewRef: null, previewRefs: [], pageCount: null, uploadDate: '2026-09-11', createdAt: '2026-09-11', updatedAt: '2026-09-11' },
        { id: 3, title: 'Witch Hat', type: 'manga', coverRef: null, previewRef: null, previewRefs: [], pageCount: 10, uploadDate: null, createdAt: '2026-09-10', updatedAt: '2026-09-10' },
      ],
      producers: [{ id: 9, name: 'Hypergryph', occupation: 'Developer', artworkRef: null, content: null }],
      entryProducers: [{ entryId: 1, producerId: 9 }],
      tags: [{ id: 30, name: 'RPG', normalizedName: 'rpg' }, { id: 31, name: 'Anime', normalizedName: 'anime' }],
      tagGroups: [
        { id: 10, entryType: 'game', name: 'Genre', groupKind: 'section', parentId: null, sortOrder: 0 },
        { id: 11, entryType: 'game', name: 'Genre', groupKind: 'facet', parentId: 10, sortOrder: 0 },
      ],
      entryTags: [{ entryId: 1, tagId: 30, facetId: 11 }, { entryId: 3, tagId: 31, facetId: 11 }],
      producerTags: [], producerTagAssignments: [],
      entryContents: [{ id: 50, entryId: 1, contentType: 'note', content: 'saved', sortOrder: 0 }],
      ratingSlots: [{ id: 40, subjectKind: 'entry', entryType: 'game', name: 'Quality', sortOrder: 0 }],
      entryRatingValues: [{ slotId: 40, entryId: 1, stars: 5 }], producerRatingValues: [],
      collections: [{ id: 60, kind: 'entry', title: 'Favorites', description: '', nsfw: false, parentId: null, sortOrder: 0 }],
      collectionMembers: [{ collectionId: 60, entryId: 1, position: 0 }],
      authorDirectories: [], authorDirectoryEntries: [],
      entryUsage: [{ entryId: 1, viewCount: 4, likeCount: 1, lastViewedAt: '2026-09-12T12:00:00Z' }],
      viewLaterEntries: [{ subjectId: 2, position: 0 }], viewLaterProducers: [],
      gallerySettings: [{ entryType: 'game', nsfw: true }],
      mediaRefs: ['entries/1/cover.webp'],
    },
  };
}

describe('offline library read model', () => {
  it('derives galleries and author cards from snapshot rows', () => {
    const library = createOfflineLibrary(makeSnapshot());
    expect(library.listGalleries()).toEqual([
      { type: 'game', entryCount: 2, nsfw: true },
      { type: 'manga', entryCount: 1, nsfw: false },
    ]);
    expect(library.listAuthors()).toEqual([{
      id: 9, name: 'Hypergryph', covers: ['entries/1/cover.webp'], galleryType: 'game',
      viewCount: 4, likeCount: 1, lastViewedAt: '2026-09-12T12:00:00Z', nsfw: true,
    }]);
  });

  it('filters, sorts, and paginates gallery entries', () => {
    const library = createOfflineLibrary(makeSnapshot());
    expect(library.queryEntryPage({
      entryType: 'game', conditions: [], authorIds: [], ratingConditions: [], ratingSort: null,
      usageConditions: [], usageSort: null, sort: 'title-asc', page: 1, pageSize: 1,
    })).toMatchObject({ total: 2, page: 1, pageSize: 1, items: [{ id: 1, title: 'Endfield', viewCount: 4 }] });
  });

  it('keeps recent-only queries scoped to entries that were actually viewed', () => {
    const result = createOfflineLibrary(makeSnapshot()).queryEntryPage({
      conditions: [], authorIds: [], ratingConditions: [], ratingSort: null,
      usageConditions: [], usageSort: null, recentOnly: true,
      sort: 'date-desc', page: 1, pageSize: 30,
    });

    expect(result.items.map((entry) => entry.title)).toEqual(['Endfield']);
  });

  it('lets usage ordering override the visible title sort offline, matching SQL', () => {
    const result = createOfflineLibrary(makeSnapshot()).queryEntryPage({
      entryType: 'game', conditions: [], authorIds: [], ratingConditions: [], ratingSort: null,
      usageConditions: [], usageSort: { field: 'views', direction: 'asc' },
      sort: 'title-asc', page: 1, pageSize: 30,
    });

    expect(result.items.map((entry) => entry.title)).toEqual(['Hades II', 'Endfield']);
  });

  it('reconstructs an Entry detail and read-only collection context', () => {
    const library = createOfflineLibrary(makeSnapshot());
    expect(library.getEntry(1)).toMatchObject({
      id: 1,
      producers: [{ id: 9, name: 'Hypergryph', entryCount: 1 }],
      sections: [{ id: 10, facets: [{ id: 11, tags: [{ id: 30, name: 'RPG' }] }] }],
      contents: [{ id: 50, content: 'saved' }],
      ratings: [{ slotId: 40, name: 'Quality', stars: 5 }],
      usage: { viewCount: 4, likeCount: 1 },
    });
    expect(library.getViewLaterState()).toEqual({ entryIds: [2], producerIds: [] });
    expect(library.listCollectionsForEntry(1)).toEqual([60]);
    expect(library.listCollections('entry', false)[0]).toMatchObject({
      entryCount: 0,
      entries: [],
    });
    expect(library.listCollections('entry')).toMatchObject([{
      id: 60,
      title: 'Favorites',
      entries: [{ id: 1, title: 'Endfield' }],
    }]);
  });
});
