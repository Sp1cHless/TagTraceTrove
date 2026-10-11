import { describe, expect, it } from 'vitest';
import type { CollectionRecordDto } from '@t3/shared';
import { collectionOptionsForGallery, flattenCollectionOptions } from '../src/collection-tree.js';

function folder(
  id: number,
  title: string,
  galleryType: string | null,
  children: CollectionRecordDto[] = [],
): CollectionRecordDto {
  return {
    id,
    kind: 'entry',
    title,
    description: '',
    nsfw: false,
    sortOrder: id,
    galleryType,
    children,
    entries: [],
    producers: [],
  };
}

describe('add-to-collection menu scope', () => {
  it('offers the folders of the work\u2019s own Gallery, and the unfiled ones', () => {
    const records = [
      folder(1, 'Comic shelf', 'Comic'),
      folder(2, 'Movie shelf', 'movie'),
      folder(3, 'Loose shelf', null),
      folder(4, 'Comic box', 'Comic', [folder(5, 'Nested box', 'Comic')]),
    ];

    // A Comic work gets the Comic folders (nested ones through their parent) and
    // the unfiled shelf; the movie folder is not on offer.
    expect(collectionOptionsForGallery(records, 'Comic', []).map((record) => record.id))
      .toEqual([1, 3, 4]);
    expect(flattenCollectionOptions(collectionOptionsForGallery(records, 'movie', []))
      .map((option) => option.title))
      .toEqual(['Movie shelf', 'Loose shelf']);
  });

  it('keeps a folder the work is already in, even when it belongs elsewhere', () => {
    const records = [
      folder(1, 'Comic shelf', 'Comic'),
      folder(2, 'Movie shelf', 'movie', [folder(3, 'Old nested shelf', 'movie')]),
    ];

    // Membership in a child keeps its parent record, so the tick stays visible
    // and can be removed again from the same menu.
    const kept = collectionOptionsForGallery(records, 'Comic', [3]);
    expect(kept.map((record) => record.id)).toEqual([1, 2]);
    expect(flattenCollectionOptions(kept).map((option) => option.title))
      .toEqual(['Comic shelf', 'Movie shelf', 'Movie shelf / Old nested shelf']);
  });
});
