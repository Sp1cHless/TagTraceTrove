import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import type { T3Database } from '../../src/database/connection.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntryContent } from '../../src/repositories/entry-content-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { setGalleryPartition } from '../../src/repositories/partition-repository.js';
import { createProducer, linkEntryProducer } from '../../src/repositories/producer-repository.js';
import { getSyncIdentity, rotateSyncEpoch } from '../../src/sync/sync-service.js';
import { syncSnapshotSchema } from '@t3/shared';

const databases: T3Database[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function seed(database: T3Database): void {
  const author = createProducer(database, { name: 'Hypergryph' });
  const entry = createEntry(database, { title: 'Endfield', type: 'game' });
  linkEntryProducer(database, entry.id, author.id);
  createEntryContent(database, {
    entryId: entry.id,
    contentType: 'Source URL',
    content: 'https://hitomi.la/g/1.html',
    sortOrder: 0,
  });
  setGalleryPartition(database, 'game', true);
  database.prepare(`
    UPDATE entries
    SET cover_ref = ?, preview_ref = ?, preview_refs = ?
    WHERE title = ?
  `).run(
    'assets/game/endfield/cover.jpg',
    'assets/game/endfield/preview.jpg',
    JSON.stringify([
      'assets/game/endfield/page-1.jpg',
      'assets/game/endfield/page-2.jpg',
    ]),
    'Endfield',
  );
}

describe('offline sync service and routes', () => {
  it('exposes stable capabilities with a persistent library identity', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const app = createApiApp(database);

    const first = await app.request('/api/sync/capabilities');
    expect(first.status).toBe(200);
    const capabilities = await first.json() as { libraryId: string; syncEpoch: string; sqliteSchemaVersion: number };
    expect(capabilities.sqliteSchemaVersion).toBe(15);
    expect(getSyncIdentity(database).libraryId).toBe(capabilities.libraryId);

    const second = await app.request('/api/sync/capabilities');
    expect((await second.json() as { libraryId: string }).libraryId).toBe(capabilities.libraryId);
  });

  it('captures the snapshot atomically and bumps the seq monotonically', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const app = createApiApp(database);

    const firstResponse = await app.request('/api/sync/snapshot?media=thumbnails');
    expect(firstResponse.status).toBe(200);
    const first = syncSnapshotSchema.parse(await firstResponse.json());
    expect(first.header.snapshotSeq).toBe(1);
    expect(first.header.counts).toEqual({
      entries: 1, producers: 1, entryContents: 1, entryTags: 0, collections: 0,
    });
    expect(first.payload.entries[0]).toMatchObject({ title: 'Endfield', type: 'game' });
    expect(first.payload.entryContents[0]).toMatchObject({ contentType: 'Source URL' });
    expect(first.payload.gallerySettings).toEqual([{ entryType: 'game', nsfw: true }]);
    expect(first.payload.mediaRefs).toEqual([
      'assets/game/endfield/cover.jpg',
      'assets/game/endfield/page-1.jpg',
      'assets/game/endfield/page-2.jpg',
      'assets/game/endfield/preview.jpg',
    ]);

    // Unchanged data → identical payload bytes, but a bumped snapshot seq.
    const second = syncSnapshotSchema.parse(await (await app.request('/api/sync/snapshot?media=thumbnails')).json());
    expect(second.header.snapshotSeq).toBe(2);
    expect(second.payload).toEqual(first.payload);

    // A write between snapshots is visible in the next generation.
    createEntry(database, { title: 'Hades II', type: 'game' });
    const third = syncSnapshotSchema.parse(await (await app.request('/api/sync/snapshot?media=thumbnails')).json());
    expect(third.header.snapshotSeq).toBe(3);
    expect(third.header.counts.entries).toBe(2);

    const metadataOnly = syncSnapshotSchema.parse(
      await (await app.request('/api/sync/snapshot?media=none')).json(),
    );
    expect(metadataOnly.payload.mediaRefs).toEqual([]);
  });

  it('preserves offline browse ordering and taxonomy alias rows', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const second = createEntry(database, { title: 'Endfield II', type: 'game' });
    const producer = database.prepare(`SELECT id FROM producers WHERE name = 'Hypergryph'`).get() as { id: number };
    linkEntryProducer(database, second.id, producer.id);
    const directoryId = Number(database.prepare(`
      INSERT INTO author_directories (producer_id, title, sort_order) VALUES (?, 'Main', 0)
    `).run(producer.id).lastInsertRowid);
    database.prepare(`
      INSERT INTO author_directory_entries (directory_id, producer_id, entry_id, sort_order)
      VALUES (?, ?, ?, 7)
    `).run(directoryId, producer.id, second.id);
    const collectionId = Number(database.prepare(`
      INSERT INTO collections (kind, title) VALUES ('entry', 'Series')
    `).run().lastInsertRowid);
    database.prepare(`
      INSERT INTO collection_entries (collection_id, entry_id, created_at)
      VALUES (?, ?, '2026-01-01T00:00:00Z'), (?, ?, '2026-01-02T00:00:00Z')
    `).run(collectionId, second.id, collectionId, 1);
    database.prepare(`
      INSERT INTO taxonomy_aliases (
        vocabulary, partition, alias_name, normalized_alias,
        canonical_name, normalized_canonical
      ) VALUES ('producer', 'authors', 'HG', 'hg', 'Hypergryph', 'hypergryph')
    `).run();

    const app = createApiApp(database);
    const snapshot = await (await app.request('/api/sync/snapshot?media=none')).json() as {
      payload: {
        authorDirectoryEntries: Array<{ entryId: number; sortOrder?: number }>;
        collectionMembers: Array<{ entryId?: number; position: number }>;
        taxonomyAliases?: Array<{ aliasName: string; canonicalName: string }>;
      };
    };

    expect(snapshot.payload.authorDirectoryEntries).toContainEqual(expect.objectContaining({
      entryId: second.id,
      sortOrder: 7,
    }));
    expect(snapshot.payload.collectionMembers.map((member) => [member.entryId, member.position]))
      .toEqual([[second.id, 0], [1, 1]]);
    expect(snapshot.payload.taxonomyAliases).toContainEqual(expect.objectContaining({
      aliasName: 'HG',
      canonicalName: 'Hypergryph',
    }));
  });

  it('rotates the sync epoch on restore so stale clients resnapshot', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    seed(database);
    const app = createApiApp(database);

    const before = (await (await app.request('/api/sync/capabilities')).json() as { syncEpoch: string; libraryId: string }).syncEpoch;
    const after = rotateSyncEpoch(database);
    expect(after).not.toBe(before);
    expect((await (await app.request('/api/sync/capabilities')).json() as { syncEpoch: string }).syncEpoch).toBe(after);
  });

});
