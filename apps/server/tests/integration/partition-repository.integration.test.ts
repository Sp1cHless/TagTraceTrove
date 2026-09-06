import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntry, listGalleries } from '../../src/repositories/entry-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { findProducers } from '../../src/repositories/producer-tag-repository.js';
import { isNsfwGallery, setGalleryPartition } from '../../src/repositories/partition-repository.js';

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
});
