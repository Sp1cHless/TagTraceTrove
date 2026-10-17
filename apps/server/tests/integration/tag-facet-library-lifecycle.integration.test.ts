import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { syncReplayOperationSchema } from '@t3/shared';
import { createLibraryBackup, restoreLibraryBackup } from '../../src/database/backup-restore.js';
import { openDatabase, type T3Database } from '../../src/database/connection.js';
import { inspectDatabase } from '../../src/database/doctor.js';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { runDatabaseProbe } from '../../src/database/probe.js';
import { insertLegacyEntry } from '../../src/database/testing.js';
import { createFacet, createSection, deleteFacet } from '../../src/repositories/layout-repository.js';
import { deleteTag } from '../../src/repositories/tag-merge-repository.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
import { buildSyncSnapshot, getSyncIdentity } from '../../src/sync/sync-service.js';

function fixture(version = 35) {
  const root = mkdtempSync(join(tmpdir(), 't3-tag-facet-lifecycle-'));
  const path = join(root, 'library.db');
  const db = openDatabase(path);
  if (version < 35) {
    const migrations = join(root, 'migrations');
    mkdirSync(migrations);
    const source = fileURLToPath(new URL('../../src/database/migrations/', import.meta.url));
    for (const name of readdirSync(source).filter(name => /^\d+_.+\.sql$/u.test(name) && Number.parseInt(name, 10) <= version)) {
      copyFileSync(join(source, name), join(migrations, name));
    }
    expect(applyAllMigrations(db, migrations).currentVersion).toBe(version);
  } else applyAllMigrations(db);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'fixture.bin'), 'disposable media');
  // Written against the version's own schema: this helper is called with pinned older versions, and
  // the current writer names columns those schemas do not have.
  const entry = insertLegacyEntry(db, { title: 'Legacy owner', type: 'comic' });
  const section = createSection(db, { entryType: 'comic', name: 'Tags', sortOrder: 7 });
  const facet = createFacet(db, { sectionId: section.id, name: 'Theme', sortOrder: 9 });
  return { db, root, path, entry, section, facet, close() {
    if (db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  } };
}

function canonical(db: T3Database) {
  return {
    tags: db.prepare('SELECT id, name, normalized_name FROM tags ORDER BY id').all(),
    groups: db.prepare('SELECT id, entry_type, name, group_kind, parent_id, sort_order FROM tag_groups ORDER BY id').all(),
    links: db.prepare('SELECT entry_id, tag_id, facet_id FROM entry_tags ORDER BY entry_id, tag_id').all(),
  };
}

function creates(f: ReturnType<typeof fixture>) {
  const identity = { ...getSyncIdentity(f.db), clientId: 'lifecycle-client', clientCreatedAt: '2026-10-03T00:00:00Z' };
  const sectionUid = f.db.prepare('SELECT sync_uid FROM tag_groups WHERE id=?').pluck().get(f.section.id);
  const version = f.db.prepare('SELECT sync_version FROM entry_tag_layouts WHERE entry_type=?').pluck().get('comic');
  const tag = syncReplayOperationSchema.parse({ ...identity, opId: randomUUID(), entityKind: 'entry_tag', entityUid: randomUUID(), operationKind: 'entry.tag.create', baseVersion: 0, baseValues: {}, payload: { name: 'Known' } });
  const facet = syncReplayOperationSchema.parse({ ...identity, opId: randomUUID(), entityKind: 'entry_facet', entityUid: randomUUID(), operationKind: 'entry.facet.create', baseVersion: version, baseValues: { entryType: 'comic', sectionUid }, payload: { entryType: 'comic', sectionUid, name: 'Theme' } });
  return { tag, facet };
}

function assignment(db: T3Database, f: ReturnType<typeof fixture>, origins: ReturnType<typeof creates>, tags: Array<{ name: string; tagUid: string; facetUid: string }>, captured: Array<{ name: string; facetId?: number; tagUid?: string; facetUid?: string }> = []) {
  const owner = db.prepare('SELECT sync_uid AS uid, sync_version AS version FROM entries WHERE id=?').get(f.entry.id) as { uid: string; version: number };
  return syncReplayOperationSchema.parse({ ...getSyncIdentity(db), clientId: origins.tag.clientId, clientCreatedAt: origins.tag.clientCreatedAt, opId: randomUUID(), entityKind: 'entry', entityUid: owner.uid, operationKind: 'entry.tags.set', baseVersion: owner.version, baseValues: { tags: captured }, payload: { tags, tagCreates: [{ tagUid: origins.tag.entityUid, createOpId: origins.tag.opId }], facetCreates: [{ facetUid: origins.facet.entityUid, createOpId: origins.facet.opId }] } });
}

it('restores a genuinely populated schema-33 library through staging and backfills Tag Section Facet snapshot identity', async () => {
  const f = fixture(33);
  try {
    const tagId = Number(f.db.prepare('INSERT INTO tags(name,normalized_name) VALUES (?,?)').run('Known', 'known').lastInsertRowid);
    f.db.prepare('INSERT INTO entry_tags(entry_id,tag_id,facet_id) VALUES (?,?,?)').run(f.entry.id, tagId, f.facet.id);
    const before = canonical(f.db), identity = getSyncIdentity(f.db);
    expect(f.db.prepare('PRAGMA table_info(tags)').all()).not.toContainEqual(expect.objectContaining({ name: 'sync_uid' }));
    expect(inspectDatabase(f.db).ok).toBe(true);
    const backup = await createLibraryBackup({ databasePath: f.path, dataDir: f.root });
    f.db.close();
    const result = await restoreLibraryBackup({ backupDir: backup.backupDir, databasePath: f.path, dataDir: f.root });
    expect(result.doctorOk).toBe(true);
    const restored = openDatabase(f.path);
    try {
      expect(restored.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get()).toBe(44);
      expect(canonical(restored)).toEqual(before);
      expect(getSyncIdentity(restored)).toMatchObject({ libraryId: identity.libraryId, syncEpoch: expect.not.stringMatching(identity.syncEpoch) });
      const snapshot = buildSyncSnapshot(restored);
      for (const row of [...snapshot.payload.tags, ...snapshot.payload.tagGroups]) expect(row.syncUid).toMatch(/^[0-9a-f-]{36}$/u);
      expect(snapshot.payload.entryTagLayouts).toContainEqual(expect.objectContaining({ entryType: 'comic', syncUid: expect.stringMatching(/^[0-9a-f-]{36}$/u), syncVersion: 1 }));
      expect(snapshot.payload.entryTags).toContainEqual(expect.objectContaining({ entryId: f.entry.id, tagId, facetId: f.facet.id }));
      expect(inspectDatabase(restored).issues).toEqual([]);
      expect(runDatabaseProbe().ok).toBe(true);
      expect(readFileSync(join(f.root, 'assets', 'fixture.bin'), 'utf8')).toBe('disposable media');
    } finally { restored.close(); }
  } finally { f.close(); }
});

it('restored schema-34 canonical reuse origins remain inert across epoch rotation while same-name current-epoch work succeeds', async () => {
  const f = fixture(34);
  try {
    f.db.prepare('INSERT INTO tags(name,normalized_name) VALUES (?,?)').run('Known', 'known');
    const origins = creates(f);
    for (const op of [origins.tag, origins.facet]) expect(replaySyncOperation(f.db, op).status).toBe('applied');
    const desired = [{ name: 'Known', tagUid: origins.tag.entityUid, facetUid: origins.facet.entityUid }];
    const linked = assignment(f.db, f, origins, desired);
    expect(replaySyncOperation(f.db, linked).status).toBe('applied');
    const pending = assignment(f.db, f, origins, [], [{ name: 'Known', tagUid: origins.tag.entityUid, facetUid: origins.facet.entityUid }]);
    const before = canonical(f.db);
    const identities = f.db.prepare('SELECT id,sync_uid FROM tag_groups ORDER BY id').all();
    const tagIdentities = f.db.prepare('SELECT id,sync_uid FROM tags ORDER BY id').all();
    const layouts = f.db.prepare('SELECT entry_type,sync_uid,sync_version FROM entry_tag_layouts ORDER BY entry_type').all();
    expect(f.db.prepare('SELECT sync_uid FROM tags WHERE name=?').pluck().get('Known')).not.toBe(origins.tag.entityUid);
    expect(f.db.prepare('SELECT sync_uid FROM tag_groups WHERE id=?').pluck().get(f.facet.id)).not.toBe(origins.facet.entityUid);
    expect(inspectDatabase(f.db).issues).toEqual([]);
    const backup = await createLibraryBackup({ databasePath: f.path, dataDir: f.root });
    f.db.close();
    await restoreLibraryBackup({ backupDir: backup.backupDir, databasePath: f.path, dataDir: f.root });
    const db = openDatabase(f.path);
    try {
      expect(canonical(db)).toEqual(before);
      expect(db.prepare('SELECT id,sync_uid FROM tag_groups ORDER BY id').all()).toEqual(identities);
      expect(db.prepare('SELECT id,sync_uid FROM tags ORDER BY id').all()).toEqual(tagIdentities);
      expect(db.prepare('SELECT entry_type,sync_uid,sync_version FROM entry_tag_layouts ORDER BY entry_type').all()).toEqual(layouts);
      const epoch = getSyncIdentity(db).syncEpoch;
      expect(epoch).not.toBe(origins.tag.syncEpoch);
      for (const op of [origins.tag, origins.facet, linked, pending]) expect(replaySyncOperation(db, op)).toMatchObject({ status: 'resnapshot-required', reason: 'epoch-mismatch' });
      // Historical receipts/origins are retained, but their epoch cannot authorize fresh operations.
      for (const table of ['sync_offline_created_entry_tags', 'sync_offline_created_entry_facets']) {
        expect(db.prepare(`SELECT sync_epoch FROM ${table}`).pluck().all()).toEqual([origins.tag.syncEpoch]);
      }
      expect(db.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(3);
      for (const clientId of [origins.tag.clientId, 'other-client']) {
        expect(replaySyncOperation(db, { ...pending, opId: randomUUID(), syncEpoch: epoch, clientId }).status).toBe('failed');
      }
      expect(canonical(db)).toEqual(before);
      const fresh = syncReplayOperationSchema.parse({ ...origins.tag, opId: randomUUID(), entityUid: randomUUID(), syncEpoch: epoch, payload: { name: 'Known' } });
      expect(replaySyncOperation(db, fresh).status).toBe('applied');
      const freshFacet = syncReplayOperationSchema.parse({ ...origins.facet, opId: randomUUID(), entityUid: randomUUID(), syncEpoch: epoch, payload: { ...origins.facet.payload, name: 'Theme' } });
      expect(replaySyncOperation(db, freshFacet).status).toBe('applied');
      const freshOrigins = { tag: fresh, facet: freshFacet };
      expect(replaySyncOperation(db, assignment(db, f, freshOrigins, [{ name: 'Known', tagUid: fresh.entityUid, facetUid: freshFacet.entityUid }], [{ name: 'Known', facetId: f.facet.id }])).status).toBe('applied');
      expect(canonical(db)).toEqual(before);
      expect(db.prepare('SELECT id,sync_uid FROM tags ORDER BY id').all()).toEqual(tagIdentities);
      expect(db.prepare('SELECT id,sync_uid FROM tag_groups ORDER BY id').all()).toEqual(identities);
      expect(db.prepare('SELECT entry_type,sync_uid,sync_version FROM entry_tag_layouts ORDER BY entry_type').all()).toEqual(layouts);
      for (const table of ['sync_offline_created_entry_tags', 'sync_offline_created_entry_facets']) expect(db.prepare(`SELECT sync_epoch FROM ${table} ORDER BY sync_epoch`).pluck().all()).toEqual([origins.tag.syncEpoch, epoch].sort());
      for (const clientId of [origins.tag.clientId, 'other-client']) expect(replaySyncOperation(db, { ...pending, opId: randomUUID(), syncEpoch: epoch, clientId }).status).toBe('failed');
      expect(inspectDatabase(db).issues).toEqual([]);
      expect(buildSyncSnapshot(db).payload.entryTags).toHaveLength(1);
    } finally { db.close(); }
  } finally { f.close(); }
});

it('repository Facet and Tag deletion cascades causal origins without corrupting surviving assignments', () => {
  const f = fixture();
  try {
    const origins = creates(f);
    for (const op of [origins.tag, origins.facet]) expect(replaySyncOperation(f.db, op).status).toBe('applied');
    expect(replaySyncOperation(f.db, assignment(f.db, f, origins, [{ name: 'Known', tagUid: origins.tag.entityUid, facetUid: origins.facet.entityUid }])).status).toBe('applied');
    deleteFacet(f.db, f.facet.id);
    expect(f.db.prepare('SELECT COUNT(*) FROM sync_offline_created_entry_facets').pluck().get()).toBe(0);
    expect(f.db.prepare('SELECT facet_id FROM entry_tags').pluck().get()).toBe(f.section.defaultFacetId);
    expect(f.db.prepare('SELECT COUNT(*) FROM sync_offline_created_entry_tags').pluck().get()).toBe(1);
    expect(inspectDatabase(f.db).issues).toEqual([]);
    const tagId = Number(f.db.prepare('SELECT id FROM tags WHERE name=?').pluck().get('Known'));
    deleteTag(f.db, { vocabulary: 'entry', tagId });
    expect(f.db.prepare('SELECT COUNT(*) FROM sync_offline_created_entry_tags').pluck().get()).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) FROM entry_tags').pluck().get()).toBe(0);
    expect(inspectDatabase(f.db).issues).toEqual([]);
  } finally { f.close(); }
});
