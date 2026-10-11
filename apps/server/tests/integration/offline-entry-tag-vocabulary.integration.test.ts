import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { syncReplayOperationSchema } from '@t3/shared';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createFacet, createSection } from '../../src/repositories/layout-repository.js';
import { buildSyncCapabilities, buildSyncSnapshot } from '../../src/sync/sync-service.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
import { createNodeSqliteMemoryDatabase } from './node-sqlite-adapter.js';

const migrationsDirectory = fileURLToPath(new URL('../../src/database/migrations/', import.meta.url));

function migratedDatabase(maxVersion: number): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  for (const name of readdirSync(migrationsDirectory).filter((value) => (
    /^\d+_.+\.sql$/u.test(value) && Number.parseInt(value, 10) <= maxVersion
  )).sort()) {
    const version = Number.parseInt(name, 10);
    database.exec(readFileSync(`${migrationsDirectory}/${name}`, 'utf8'));
    database.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)')
      .run(version, name, 'test');
  }
  return database;
}

it('migration 034 gives Entry Tags and shared per-type layout rows stable sync identities', () => {
  const database = migratedDatabase(33);
  database.prepare('INSERT INTO entries (title, type) VALUES (?, ?)').run('Seed', 'comic');
  const sectionId = Number(database.prepare(`
    INSERT INTO tag_groups (entry_type, name, group_kind) VALUES (?, ?, 'section')
  `).run('comic', 'Details').lastInsertRowid);
  const facetId = Number(database.prepare(`
    INSERT INTO tag_groups (entry_type, name, group_kind, parent_id) VALUES (?, ?, 'facet', ?)
  `).run('comic', 'Theme', sectionId).lastInsertRowid);
  database.prepare('INSERT INTO tags (name, normalized_name) VALUES (?, ?)').run('Known', 'known');
  const migrationName = readdirSync(migrationsDirectory).find((name) => name.startsWith('034_'))!;
  database.exec(readFileSync(`${migrationsDirectory}/${migrationName}`, 'utf8'));
  database.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (34, ?, ?)')
    .run(migrationName, 'test');

  const version = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()!.version;
  const tagUid = database.prepare('SELECT sync_uid AS syncUid FROM tags WHERE normalized_name = ?').get('known')!.syncUid;
  const sectionUid = database.prepare('SELECT sync_uid AS syncUid FROM tag_groups WHERE id = ?').get(sectionId)!.syncUid;
  const facetUid = database.prepare('SELECT sync_uid AS syncUid FROM tag_groups WHERE id = ?').get(facetId)!.syncUid;
  const layout = database.prepare(`
    SELECT sync_uid AS syncUid, sync_version AS syncVersion
    FROM entry_tag_layouts WHERE entry_type = ?
  `).get('comic');

  expect(version).toBe(34);
  expect([tagUid, sectionUid, facetUid]).toEqual([
    expect.stringMatching(/^[0-9a-f-]{36}$/),
    expect.stringMatching(/^[0-9a-f-]{36}$/),
    expect.stringMatching(/^[0-9a-f-]{36}$/),
  ]);
  expect(layout).toEqual({ syncUid: expect.stringMatching(/^[0-9a-f-]{36}$/), syncVersion: 1 });
  expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sync_offline_created_entry_%' ORDER BY name").all().map((row) => row.name))
    .toEqual(['sync_offline_created_entry_facets', 'sync_offline_created_entry_tags']);
  expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_entry_taxonomy_changes'").get()?.name)
    .toBe('sync_entry_taxonomy_changes');
  database.close();
});

it('advertises and snapshots the complete schema-34 Tag vocabulary capability', () => {
  const database = createNodeSqliteMemoryDatabase();
  try {
    expect(applyAllMigrations(database).currentVersion).toBe(43);
    createEntry(database, { title: 'Seed', type: 'comic' });
    const section = createSection(database, { entryType: 'comic', name: 'Details' });
    const facet = createFacet(database, { sectionId: section.id, name: 'Theme' });
    database.prepare('INSERT INTO tags (name, normalized_name) VALUES (?, ?)').run('Known', 'known');

    const capabilities = buildSyncCapabilities(database, 'test');
    expect(capabilities.featureFlags).toMatchObject({
      offlineEntryTagVocabulary: true,
      offlineEntryFacetCreate: true,
      offlinePendingEntryTagCreation: true,
    });
    const snapshot = buildSyncSnapshot(database);
    expect(snapshot.payload.tags).toContainEqual(expect.objectContaining({
      name: 'Known', syncUid: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }));
    expect(snapshot.payload.tagGroups).toContainEqual(expect.objectContaining({
      id: facet.id, syncUid: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }));
    expect(snapshot.payload.entryTagLayouts).toContainEqual(expect.objectContaining({
      entryType: 'comic', syncVersion: expect.any(Number),
    }));
  } finally {
    database.close();
  }
});

it('atomically creates causal Tag and Facet identities and assigns them only within one Entry type', () => {
  const database = createNodeSqliteMemoryDatabase();
  try {
    applyAllMigrations(database);
    const source = createEntry(database, { title: 'Source', type: 'comic' });
    const peer = createEntry(database, { title: 'Peer', type: 'comic' });
    const other = createEntry(database, { title: 'Other', type: 'game' });
    const section = createSection(database, { entryType: 'comic', name: 'Details' });
    createSection(database, { entryType: 'game', name: 'Details' });
    const sectionUid = database.prepare('SELECT sync_uid FROM tag_groups WHERE id = ?').pluck().get(section.id) as string;
    const layoutVersion = database.prepare('SELECT sync_version FROM entry_tag_layouts WHERE entry_type = ?').pluck().get('comic') as number;
    const owner = (id: number) => database.prepare(`
      SELECT sync_uid AS uid, sync_version AS version FROM entries WHERE id = ?
    `).get(id) as { uid: string; version: number };
    const identity = { clientId: 'tag-board', ...getSyncIdentity(database), clientCreatedAt: '2026-10-03T00:00:00Z' };
    const tagUid = randomUUID();
    const facetUid = randomUUID();
    const tagCreate = syncReplayOperationSchema.parse({
      ...identity, opId: randomUUID(), entityKind: 'entry_tag', entityUid: tagUid,
      operationKind: 'entry.tag.create', baseVersion: 0, baseValues: {}, payload: { name: '  School   Life  ' },
    });
    const facetCreate = syncReplayOperationSchema.parse({
      ...identity, opId: randomUUID(), entityKind: 'entry_facet', entityUid: facetUid,
      operationKind: 'entry.facet.create', baseVersion: layoutVersion,
      baseValues: { entryType: 'comic', sectionUid },
      payload: { entryType: 'comic', sectionUid, name: '  Theme  ' },
    });
    const assignment = (entryId: number) => syncReplayOperationSchema.parse({
      ...identity, opId: randomUUID(), entityKind: 'entry', entityUid: owner(entryId).uid,
      operationKind: 'entry.tags.set', baseVersion: owner(entryId).version,
      baseValues: { tags: [] }, payload: {
        tags: [{ name: 'School Life', tagUid, facetUid }],
        tagCreates: [{ tagUid, createOpId: tagCreate.opId }],
        facetCreates: [{ facetUid, createOpId: facetCreate.opId }],
      },
    });

    const tagReceipt = replaySyncOperation(database, tagCreate);
    const facetReceipt = replaySyncOperation(database, facetCreate);
    expect(tagReceipt).toMatchObject({ status: 'applied', entityId: expect.any(Number) });
    expect(facetReceipt).toMatchObject({ status: 'applied', entityId: expect.any(Number) });
    expect(replaySyncOperation(database, tagCreate)).toEqual(tagReceipt);
    expect(replaySyncOperation(database, facetCreate)).toEqual(facetReceipt);
    expect(replaySyncOperation(database, syncReplayOperationSchema.parse({ ...tagCreate, payload: { name: 'Changed' } })))
      .toMatchObject({ status: 'failed', errorCode: 'operation-id-collision' });

    const sourceAssignment = assignment(source.id);
    expect(replaySyncOperation(database, sourceAssignment)).toMatchObject({ status: 'applied' });
    expect(replaySyncOperation(database, assignment(peer.id))).toMatchObject({ status: 'applied' });
    expect(replaySyncOperation(database, assignment(other.id)))
      .toMatchObject({ status: 'failed', errorCode: 'invalid-tag-data' });
    expect(database.prepare(`
      SELECT entry.id AS entryId, tag.name, facet.name AS facetName
      FROM entry_tags AS edge
      JOIN entries AS entry ON entry.id = edge.entry_id
      JOIN tags AS tag ON tag.id = edge.tag_id
      JOIN tag_groups AS facet ON facet.id = edge.facet_id
      ORDER BY entry.id
    `).all()).toEqual([
      { entryId: source.id, name: 'School Life', facetName: 'Theme' },
      { entryId: peer.id, name: 'School Life', facetName: 'Theme' },
    ]);
    expect(database.prepare('SELECT COUNT(*) FROM sync_offline_created_entry_tags').pluck().get()).toBe(1);
    expect(database.prepare('SELECT COUNT(*) FROM sync_offline_created_entry_facets').pluck().get()).toBe(1);
    expect(database.prepare('SELECT COUNT(*) FROM sync_entry_taxonomy_changes').pluck().get()).toBeGreaterThanOrEqual(2);
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(5);
  } finally {
    database.close();
  }
});
