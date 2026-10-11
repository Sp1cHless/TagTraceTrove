import { describe, expect, it } from 'vitest';

import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { listGalleries } from '../../src/repositories/entry-repository.js';
import {
  listGalleryOrder,
  setGalleryOrder,
} from '../../src/repositories/gallery-order-repository.js';

/**
 * The order the sidebar lists Galleries in.
 *
 * A Gallery is a projection of `entries.type`, so it has no row of its own and the list fell back to
 * the alphabet. Measured on a real library with seven galleries, the two used every day sat wherever
 * their spelling put them and there was no way to move one — which is what the exchange control is
 * for. These are the properties the sidebar depends on: the order is total, it survives the Galleries
 * it does not name, and a Gallery created later does not land in the middle of it.
 */
function withGalleries(names: string[]): ReturnType<typeof createMigratedMemoryDatabase> {
  const database = createMigratedMemoryDatabase();
  names.forEach((name, index) => createEntry(database, { title: `Work ${index}`, type: name }));
  return database;
}

describe('the stored Gallery order', () => {
  it('lists Galleries by name until one is moved', () => {
    const database = withGalleries(['Zebra', 'alpha', 'Manga']);
    try {
      expect(listGalleryOrder(database)).toEqual([]);
      expect(listGalleries(database).map((gallery) => gallery.type))
        .toEqual(['alpha', 'Manga', 'Zebra']);
    } finally {
      database.close();
    }
  });

  it('follows the stored order, and puts a Gallery created later after the named ones', () => {
    const database = withGalleries(['Zebra', 'alpha', 'Manga']);
    try {
      setGalleryOrder(database, ['Zebra', 'alpha', 'Manga']);
      expect(listGalleries(database).map((gallery) => gallery.type))
        .toEqual(['Zebra', 'alpha', 'Manga']);

      // A Gallery created after the last move has no row, so it belongs at the end rather than
      // somewhere in the middle of an order it was never part of.
      createEntry(database, { title: 'A later work', type: 'Beta' });
      expect(listGalleries(database).map((gallery) => gallery.type))
        .toEqual(['Zebra', 'alpha', 'Manga', 'Beta']);
    } finally {
      database.close();
    }
  });

  it('writes the whole list, so moving one Gallery does not scatter the rest', () => {
    const database = withGalleries(['One', 'Two', 'Three']);
    try {
      // What the sidebar sends after moving "Three" to the top: every Gallery, in the new order.
      setGalleryOrder(database, ['Three', 'One', 'Two']);
      expect(listGalleries(database).map((gallery) => gallery.type))
        .toEqual(['Three', 'One', 'Two']);
      // And the write replaces the order rather than adding to it.
      setGalleryOrder(database, ['Two', 'Three', 'One']);
      expect(listGalleryOrder(database)).toEqual(['Two', 'Three', 'One']);
      expect(listGalleries(database).map((gallery) => gallery.type))
        .toEqual(['Two', 'Three', 'One']);
    } finally {
      database.close();
    }
  });

  it('refuses a list that names a Gallery twice or names nothing', () => {
    const database = withGalleries(['One', 'Two']);
    try {
      expect(() => setGalleryOrder(database, ['One', 'One'])).toThrow(/once/u);
      expect(() => setGalleryOrder(database, ['One', '  '])).toThrow(/once/u);
      // A refused write changes nothing.
      expect(listGalleryOrder(database)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
