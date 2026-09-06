import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { createProducer } from '../../src/repositories/producer-repository.js';
import {
  createEntryRatingSlot,
  createProducerRatingSlot,
  createRatingSlot,
  listEntryRatings,
  listProducerRatings,
  listRatingSlots,
  reorderRatingSlots,
  setEntryRating,
  setProducerRating,
} from '../../src/repositories/rating-repository.js';
import { getEntryDetail } from '../../src/repositories/entry-repository.js';
import { getAuthorDetail } from '../../src/repositories/producer-repository.js';

type TestDatabase = ReturnType<typeof createMigratedMemoryDatabase>;

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

function createDatabase(): TestDatabase {
  const database = createMigratedMemoryDatabase();
  databases.push(database);
  return database;
}

describe('rating slots and values (real SQL)', () => {
  it('shares entry slots across every Entry of the same Gallery type', () => {
    const database = createDatabase();
    const first = createEntry(database, { title: 'First', type: 'comic' });
    const second = createEntry(database, { title: 'Second', type: 'comic' });
    const manga = createEntry(database, { title: 'Manga Work', type: 'manga' });

    const slot = createEntryRatingSlot(database, { entryId: first.id, name: 'Quality' });

    // Reusing the same name returns the shared slot instead of duplicating it.
    const reused = createEntryRatingSlot(database, { entryId: second.id, name: ' Quality ' });
    expect(reused.id).toBe(slot.id);
    expect(listRatingSlots(database, 'entry', 'comic')).toHaveLength(1);
    expect(listRatingSlots(database, 'entry', 'manga')).toHaveLength(0);

    // Every same-type Entry shows the row immediately, unrated = null (not 0).
    expect(listEntryRatings(database, first.id)).toEqual([
      { slotId: slot.id, name: 'Quality', stars: null },
    ]);
    expect(listEntryRatings(database, second.id)).toEqual([
      { slotId: slot.id, name: 'Quality', stars: null },
    ]);
    expect(listEntryRatings(database, manga.id)).toEqual([]);
  });

  it('upserts half-step stars and composes ratings into the Entry detail', () => {
    const database = createDatabase();
    const entry = createEntry(database, { title: 'Rated Work', type: 'comic' });
    const slot = createEntryRatingSlot(database, { entryId: entry.id, name: 'Art' });

    setEntryRating(database, { entryId: entry.id, slotId: slot.id, stars: 3.5 });
    expect(listEntryRatings(database, entry.id)[0]?.stars).toBe(3.5);

    // Overwriting the value updates in place; clearing back to null keeps the row.
    setEntryRating(database, { entryId: entry.id, slotId: slot.id, stars: 5 });
    expect(listEntryRatings(database, entry.id)[0]?.stars).toBe(5);
    setEntryRating(database, { entryId: entry.id, slotId: slot.id, stars: null });
    expect(listEntryRatings(database, entry.id)[0]?.stars).toBeNull();

    const detail = getEntryDetail(database, entry.id);
    expect(detail?.ratings).toEqual([{ slotId: slot.id, name: 'Art', stars: null }]);
  });

  it('rejects invalid stars and slots from a foreign Gallery', () => {
    const database = createDatabase();
    const entry = createEntry(database, { title: 'Work', type: 'comic' });
    const slot = createEntryRatingSlot(database, { entryId: entry.id, name: 'Story' });
    const mangaEntry = createEntry(database, { title: 'Manga', type: 'manga' });
    const mangaSlot = createEntryRatingSlot(database, { entryId: mangaEntry.id, name: 'Story' });

    expect(() => setEntryRating(database, { entryId: entry.id, slotId: slot.id, stars: 0.3 }))
      .toThrow(/half-step/);
    expect(() => setEntryRating(database, { entryId: entry.id, slotId: slot.id, stars: 5.5 }))
      .toThrow(/half-step/);
    expect(() => setEntryRating(database, { entryId: entry.id, slotId: mangaSlot.id, stars: 4 }))
      .toThrow(/does not belong/);
    expect(() => setEntryRating(database, { entryId: mangaEntry.id, slotId: slot.id, stars: 4 }))
      .toThrow(/does not belong/);
    expect(listEntryRatings(database, entry.id)[0]?.stars).toBeNull();
  });

  it('partitions producer slots by dominant Gallery and auto-applies to same-type authors', () => {
    const database = createDatabase();
    const comicAuthor = createProducer(database, { name: 'Comic Author' });
    const work = createEntry(database, { title: 'Comic Work', type: 'comic' });
    linkEntryProducer(database, work.id, comicAuthor.id);
    const anotherComicAuthor = createProducer(database, { name: 'Another Comic Author' });
    const anotherWork = createEntry(database, { title: 'Another Comic', type: 'comic' });
    linkEntryProducer(database, anotherWork.id, anotherComicAuthor.id);
    const mangaAuthor = createProducer(database, { name: 'Manga Author' });
    const mangaWork = createEntry(database, { title: 'Manga Work', type: 'manga' });
    linkEntryProducer(database, mangaWork.id, mangaAuthor.id);

    const slot = createProducerRatingSlot(database, { producerId: comicAuthor.id, name: 'Taste' });

    // Applied automatically to every same-dominant-Gallery author...
    expect(listProducerRatings(database, anotherComicAuthor.id)).toEqual([
      { slotId: slot.id, name: 'Taste', stars: null },
    ]);
    // ...and NOT to authors dominated by another Gallery.
    expect(listProducerRatings(database, mangaAuthor.id)).toEqual([]);

    setProducerRating(database, { producerId: comicAuthor.id, slotId: slot.id, stars: 2.5 });
    setProducerRating(database, { producerId: anotherComicAuthor.id, slotId: slot.id, stars: null });
    expect(listProducerRatings(database, comicAuthor.id)[0]?.stars).toBe(2.5);
    expect(listProducerRatings(database, anotherComicAuthor.id)[0]?.stars).toBeNull();

    const detail = getAuthorDetail(database, comicAuthor.id);
    expect(detail?.ratings).toEqual([{ slotId: slot.id, name: 'Taste', stars: 2.5 }]);
  });

  it('refuses author slots without works and cross-Gallery author ratings', () => {
    const database = createDatabase();
    const idleAuthor = createProducer(database, { name: 'Idle Author' });
    expect(() => createProducerRatingSlot(database, { producerId: idleAuthor.id, name: 'Taste' }))
      .toThrow(/cannot create a rating slot/);

    const comicAuthor = createProducer(database, { name: 'Comic Author' });
    const work = createEntry(database, { title: 'Comic Work', type: 'comic' });
    linkEntryProducer(database, work.id, comicAuthor.id);
    const slot = createProducerRatingSlot(database, { producerId: comicAuthor.id, name: 'Taste' });

    const mangaAuthor = createProducer(database, { name: 'Manga Author' });
    const mangaWork = createEntry(database, { title: 'Manga Work', type: 'manga' });
    linkEntryProducer(database, mangaWork.id, mangaAuthor.id);
    const mangaSlot = createProducerRatingSlot(database, { producerId: mangaAuthor.id, name: 'Style' });

    expect(() => setProducerRating(database, { producerId: mangaAuthor.id, slotId: slot.id, stars: 4 }))
      .toThrow(/does not belong/);
    expect(() => setProducerRating(database, { producerId: comicAuthor.id, slotId: mangaSlot.id, stars: 4 }))
      .toThrow(/does not belong/);
    expect(() => setProducerRating(database, { producerId: idleAuthor.id, slotId: slot.id, stars: 4 }))
      .toThrow(/cannot rate an author without works/);
  });

  it('reorders slots with a complete payload and persists the order', () => {
    const database = createDatabase();
    const entry = createEntry(database, { title: 'Work', type: 'comic' });
    const first = createRatingSlot(database, { kind: 'entry', entryType: 'comic', name: 'First' });
    const second = createRatingSlot(database, { kind: 'entry', entryType: 'comic', name: 'Second' });
    const third = createRatingSlot(database, { kind: 'entry', entryType: 'comic', name: 'Third' });

    expect(() => reorderRatingSlots(database, 'entry', 'comic', [first.id, second.id]))
      .toThrow(/every rating slot/);
    reorderRatingSlots(database, 'entry', 'comic', [third.id, first.id, second.id]);
    expect(listRatingSlots(database, 'entry', 'comic').map((slot) => slot.id))
      .toEqual([third.id, first.id, second.id]);
    expect(listEntryRatings(database, entry.id).map((row) => row.slotId))
      .toEqual([third.id, first.id, second.id]);
  });

  it('cascades value deletion when an Entry is deleted and exposes rating routes', async () => {
    const database = createDatabase();
    const entry = createEntry(database, { title: 'Doomed Work', type: 'comic' });
    const slot = createEntryRatingSlot(database, { entryId: entry.id, name: 'Art' });
    setEntryRating(database, { entryId: entry.id, slotId: slot.id, stars: 4.5 });

    const author = createProducer(database, { name: 'Author' });
    const work = createEntry(database, { title: 'Work', type: 'comic' });
    linkEntryProducer(database, work.id, author.id);
    const authorSlot = createProducerRatingSlot(database, { producerId: author.id, name: 'Taste' });

    const app = createApiApp(database);
    const setResponse = await app.request(`/api/entries/${entry.id}/ratings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotId: slot.id, stars: 2 }),
    });
    expect(setResponse.status).toBe(200);
    expect(await setResponse.json()).toEqual({ slotId: slot.id, name: 'Art', stars: 2 });

    const invalidResponse = await app.request(`/api/entries/${entry.id}/ratings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotId: slot.id, stars: 3.7 }),
    });
    expect(invalidResponse.status).toBe(400);

    const slotResponse = await app.request(`/api/producers/${author.id}/rating-slots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Second Taste' }),
    });
    expect(slotResponse.status).toBe(201);
    expect(await slotResponse.json()).toEqual({
      id: authorSlot.id + 1,
      name: 'Second Taste',
      sortOrder: 1,
    });

    const authorSetResponse = await app.request(`/api/producers/${author.id}/ratings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotId: authorSlot.id, stars: 4.5 }),
    });
    expect(await authorSetResponse.json()).toEqual({ slotId: authorSlot.id, name: 'Taste', stars: 4.5 });

    const detailResponse = await app.request(`/api/entries/${entry.id}`);
    expect((await detailResponse.json() as { ratings: unknown[] }).ratings)
      .toEqual([{ slotId: slot.id, name: 'Art', stars: 2 }]);

    // Deleting the Entry removes its values (CASCADE) but never the shared slot.
    database.prepare('DELETE FROM entries WHERE id = ?').run(entry.id);
    expect(database.prepare('SELECT COUNT(*) FROM entry_rating_values').pluck().get()).toBe(0);
    expect(listRatingSlots(database, 'entry', 'comic')).toHaveLength(1);
  });

  it('reorders rating slots through HTTP and syncs the template order across cards', async () => {
    const database = createDatabase();
    const first = createEntry(database, { title: 'First', type: 'comic' });
    const second = createEntry(database, { title: 'Second', type: 'comic' });
    const slotA = createRatingSlot(database, { kind: 'entry', entryType: 'comic', name: 'A' });
    const slotB = createRatingSlot(database, { kind: 'entry', entryType: 'comic', name: 'B' });
    const slotC = createRatingSlot(database, { kind: 'entry', entryType: 'comic', name: 'C' });

    const app = createApiApp(database);
    const response = await app.request(`/api/entries/${first.id}/rating-slots/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedSlotIds: [slotC.id, slotA.id, slotB.id] }),
    });
    expect(response.status).toBe(200);

    // The order is shared per Gallery: the other Entry sees it without any
    // per-Entry apply step, exactly like the slots themselves.
    expect(listEntryRatings(database, first.id).map((row) => row.slotId))
      .toEqual([slotC.id, slotA.id, slotB.id]);
    expect(listEntryRatings(database, second.id).map((row) => row.slotId))
      .toEqual([slotC.id, slotA.id, slotB.id]);

    const invalid = await app.request(`/api/entries/${first.id}/rating-slots/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedSlotIds: [slotC.id, slotA.id] }),
    });
    // An incomplete payload is a domain conflict (same family as content reorder).
    expect(invalid.status).toBe(409);
  });

  it('shares author slot order across the dominant-Gallery partition', async () => {
    const database = createDatabase();
    const makeAuthor = (name: string): number => {
      const author = createProducer(database, { name });
      const work = createEntry(database, { title: `${name} work`, type: 'comic' });
      linkEntryProducer(database, work.id, author.id);
      return author.id;
    };
    const authorA = makeAuthor('Author A');
    const authorB = makeAuthor('Author B');
    const slotX = createRatingSlot(database, { kind: 'producer', entryType: 'comic', name: 'X' });
    const slotY = createRatingSlot(database, { kind: 'producer', entryType: 'comic', name: 'Y' });

    const app = createApiApp(database);
    const response = await app.request(`/api/producers/${authorA}/rating-slots/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedSlotIds: [slotY.id, slotX.id] }),
    });
    expect(response.status).toBe(200);
    expect(listProducerRatings(database, authorB).map((row) => row.slotId))
      .toEqual([slotY.id, slotX.id]);
  });
});
