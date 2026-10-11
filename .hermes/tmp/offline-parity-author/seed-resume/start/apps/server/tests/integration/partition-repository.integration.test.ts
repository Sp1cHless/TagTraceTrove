import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntry, listGalleries } from '../../src/repositories/entry-repository.js';
import { createProducer, deleteProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { findProducers } from '../../src/repositories/producer-tag-repository.js';
import { isNsfwGallery, setGalleryPartition } from '../../src/repositories/partition-repository.js';
import {
  addViewLaterEntry,
  addViewLaterProducer,
} from '../../src/repositories/view-later-repository.js';

type TestDatabase = ReturnType<typeof createMigratedMemoryDatabase>;

const databases: TestDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe('gallery partitions (real SQL)', () => {
  it('partitions whole galleries and derives author partitioning', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);

    // Default partition is SFW, even before any row exists.
    expect(isNsfwGallery(database, 'comic')).toBe(false);

    const comicAuthor = createProducer(database, { name: 'Comic Author' });
    const comicWork = createEntry(database, { title: 'Comic Work', type: 'comic' });
    linkEntryProducer(database, comicWork.id, comicAuthor.id);
    const nsfwAuthor = createProducer(database, { name: 'Nsfw Author' });
    const nsfwWork = createEntry(database, { title: 'Nsfw Work', type: 'hentai' });
    linkEntryProducer(database, nsfwWork.id, nsfwAuthor.id);

    setGalleryPartition(database, 'hentai', true);
    expect(isNsfwGallery(database, 'hentai')).toBe(true);
    expect(isNsfwGallery(database, 'comic')).toBe(false);

    // The gallery projection carries the flag.
    const galleries = listGalleries(database);
    expect(galleries.find((gallery) => gallery.type === 'hentai')?.nsfw).toBe(true);
    expect(galleries.find((gallery) => gallery.type === 'comic')?.nsfw).toBe(false);

    // Author partitioning is derived from their works, never stored.
    const authors = findProducers(database);
    expect(authors.find((author) => author.id === nsfwAuthor.id)?.nsfw).toBe(true);
    expect(authors.find((author) => author.id === comicAuthor.id)?.nsfw).toBe(false);

    // Toggling the whole gallery back flips every derived author too.
    setGalleryPartition(database, 'hentai', false);
    expect(findProducers(database).find((author) => author.id === nsfwAuthor.id)?.nsfw).toBe(false);
  });

  it('toggles the partition through the HTTP route', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    createEntry(database, { title: 'Work', type: 'hentai' });
    const app = createApiApp(database);

    const response = await app.request('/api/galleries/hentai/partition', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nsfw: true }),
    });
    expect(response.status).toBe(200);
    expect(isNsfwGallery(database, 'hentai')).toBe(true);

    const invalid = await app.request('/api/galleries/hentai/partition', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nsfw: 'yes' }),
    });
    expect(invalid.status).toBe(400);

    const galleries = await (await app.request('/api/galleries')).json() as Array<{ nsfw: boolean }>;
    expect(galleries[0]?.nsfw).toBe(true);
  });

  it('starts a Gallery that did not exist yet on the SFW side', () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const established = createEntry(database, { title: 'Established', type: 'comic' });
    setGalleryPartition(database, 'comic', true);

    // A brand-new type is its own Gallery and is not inherited from any other.
    const fresh = createEntry(database, { title: 'Fresh', type: 'doujin' });
    expect(isNsfwGallery(database, 'doujin')).toBe(false);
    const galleries = listGalleries(database);
    expect(galleries.find((gallery) => gallery.type === 'doujin')?.nsfw).toBe(false);
    expect(galleries.find((gallery) => gallery.type === 'comic')?.nsfw).toBe(true);
    expect(established.type).toBe('comic');
    expect(fresh.type).toBe('doujin');
  });

  it('counts only what the current boundary can show', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const safeAuthor = createProducer(database, { name: 'Safe Author' });
    const safeWork = createEntry(database, { title: 'Safe Work', type: 'comic' });
    linkEntryProducer(database, safeWork.id, safeAuthor.id);
    const adultAuthor = createProducer(database, { name: 'Adult Author' });
    const adultWork = createEntry(database, { title: 'Adult Work', type: 'hentai' });
    linkEntryProducer(database, adultWork.id, adultAuthor.id);
    setGalleryPartition(database, 'hentai', true);
    addViewLaterEntry(database, safeWork.id);
    addViewLaterEntry(database, adultWork.id);
    addViewLaterProducer(database, safeAuthor.id);
    addViewLaterProducer(database, adultAuthor.id);
    // Saving the same Author twice must not inflate the count.
    addViewLaterProducer(database, adultAuthor.id);
    const app = createApiApp(database);

    const counts = async (includeNsfw: boolean) => (
      await (await app.request(`/api/navigation-counts?includeNsfw=${String(includeNsfw)}`)).json()
    );

    expect(await counts(true)).toEqual({ authors: 2, viewLaterEntries: 2, viewLaterAuthors: 2 });
    expect(await counts(false)).toEqual({ authors: 1, viewLaterEntries: 1, viewLaterAuthors: 1 });

    // The boundary is the whole Gallery, so flipping it moves every number at once.
    setGalleryPartition(database, 'comic', true);
    expect(await counts(false)).toEqual({ authors: 0, viewLaterEntries: 0, viewLaterAuthors: 0 });

    // Deleting a saved Author drops it from both Author numbers; the saved works
    // it happened to be linked to are untouched.
    deleteProducer(database, safeAuthor.id);
    expect(await counts(true)).toEqual({ authors: 1, viewLaterEntries: 2, viewLaterAuthors: 1 });
  });
});
