import type { SyncSnapshot } from '@t3/shared';
export function offlineSnapshot(): SyncSnapshot {
  return {
    header: {
      libraryId: 'library-1', syncEpoch: 'epoch-1', snapshotSeq: 1, changeSeq: 1,
      generatedAt: '2026-09-13', sqliteSchemaVersion: 28, snapshotFormatVersion: 2,
      counts: { entries: 1, producers: 1, entryContents: 0, entryTags: 1, collections: 1 }, checksum: 'stored',
    },
    payload: {
      entries: [{ id: 1, syncUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', syncVersion: 1, title: 'Offline Entry', type: 'game', coverRef: null, previewRef: null, previewRefs: [], pageCount: null, uploadDate: null, createdAt: '2026-09-13', updatedAt: '2026-09-13' }],
      producers: [{ id: 9, syncUid: '99999999-9999-4999-8999-999999999999', syncVersion: 1, name: 'Offline Author', occupation: 'Artist', artworkRef: '/api/assets/producers/9/artwork.webp', content: 'Saved bio' }],
      entryProducers: [{ entryId: 1, producerId: 9 }],
      tags: [{ id: 10, name: 'RPG', normalizedName: 'rpg' }], tagGroups: [],
      entryTags: [{ entryId: 1, tagId: 10, facetId: 1 }],
      producerTags: [{ id: 20, syncUid: '20202020-2020-4020-8020-202020202020', name: 'Illustrator', normalizedName: 'illustrator' }],
      producerTagAssignments: [{ producerId: 9, tagId: 20 }],
      entryContents: [],
      ratingSlots: [{
        id: 7,
        syncUid: '71717171-7171-4171-8171-717171717171',
        subjectKind: 'entry',
        entryType: 'game',
        name: 'Quality',
        sortOrder: 0,
      }],
      ratingLayouts: [
        { syncUid: '72727272-7272-4272-8272-727272727272', syncVersion: 2, subjectKind: 'entry', entryType: 'game' },
        { syncUid: '82828282-8282-4282-8282-828282828282', syncVersion: 1, subjectKind: 'producer', entryType: 'game' },
      ],
      entryRatingValues: [], producerRatingValues: [],
      collections: [{
        id: 60, syncUid: '60606060-6060-4060-8060-606060606060', syncVersion: 1,
        kind: 'producer', title: 'Artists', description: '', nsfw: false, parentId: null, sortOrder: 0,
      }],
      collectionMembers: [{ collectionId: 60, producerId: 9, position: 0 }],
      authorDirectories: [],
      authorDirectorySets: [{
        producerId: 9, syncUid: '92929292-9292-4292-8292-929292929292', syncVersion: 1,
      }],
      authorDirectoryEntries: [], entryUsage: [],
      viewLaterEntries: [], viewLaterProducers: [], gallerySettings: [], mediaRefs: [],
    },
  };
}
