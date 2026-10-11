import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { syncReplayOperationSchema } from '@t3/shared';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { inspectDatabase } from '../../src/database/doctor.js';
import { runDatabaseProbe } from '../../src/database/probe.js';
import { insertLegacyEntry } from '../../src/database/testing.js';
import { createFacet, createSection, deleteFacet } from '../../src/repositories/layout-repository.js';
import { deleteTag } from '../../src/repositories/tag-merge-repository.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
import { createNodeSqliteMemoryDatabase } from './node-sqlite-adapter.js';

function fixture(legacy = false) {
  const db = createNodeSqliteMemoryDatabase();
  const root = mkdtempSync(join(tmpdir(), 't3-origin-convergence-'));
  if (legacy) {
    const directory = join(root, 'migrations'); mkdirSync(directory);
    const source = fileURLToPath(new URL('../../src/database/migrations/', import.meta.url));
    for (const name of readdirSync(source).filter(name => /^\d+_.+\.sql$/u.test(name) && Number.parseInt(name, 10) <= 34)) copyFileSync(join(source, name), join(directory, name));
    expect(applyAllMigrations(db, directory).currentVersion).toBe(34);
  } else applyAllMigrations(db);
  const section = createSection(db, { entryType: 'comic', name: 'Tags' });
  const facet = createFacet(db, { sectionId: section.id, name: 'Theme' });
  // Written against the version's own schema — this fixture is also built at v34, which predates
  // columns the current writer names.
  const owners = ['A', 'B', 'Unauthorized'].map(title => insertLegacyEntry(db, { title, type: 'comic' }));
  const sectionUid = db.prepare('SELECT sync_uid FROM tag_groups WHERE id=?').pluck().get(section.id);
  const version = db.prepare('SELECT sync_version FROM entry_tag_layouts WHERE entry_type=?').pluck().get('comic');
  const creates = (clientId: string) => {
    const identity = { ...getSyncIdentity(db), clientId, clientCreatedAt: '2026-10-03T00:00:00Z' };
    return {
      tag: syncReplayOperationSchema.parse({ ...identity, opId: randomUUID(), entityUid: randomUUID(), entityKind: 'entry_tag', operationKind: 'entry.tag.create', baseVersion: 0, baseValues: {}, payload: { name: 'Shared' } }),
      facet: syncReplayOperationSchema.parse({ ...identity, opId: randomUUID(), entityUid: randomUUID(), entityKind: 'entry_facet', operationKind: 'entry.facet.create', baseVersion: version, baseValues: { entryType: 'comic', sectionUid }, payload: { entryType: 'comic', sectionUid, name: 'Theme' } }),
    };
  };
  const assignment = (ownerId: number, origins: ReturnType<typeof creates>, clientId = origins.tag.clientId) => {
    const owner = db.prepare('SELECT sync_uid AS uid,sync_version AS version FROM entries WHERE id=?').get(ownerId) as { uid: string; version: number };
    return syncReplayOperationSchema.parse({ ...getSyncIdentity(db), clientId, clientCreatedAt: origins.tag.clientCreatedAt, opId: randomUUID(), entityUid: owner.uid, entityKind: 'entry', operationKind: 'entry.tags.set', baseVersion: owner.version, baseValues: { tags: [] }, payload: { tags: [{ name: 'Shared', tagUid: origins.tag.entityUid, facetUid: origins.facet.entityUid }], tagCreates: [{ tagUid: origins.tag.entityUid, createOpId: origins.tag.opId }], facetCreates: [{ facetUid: origins.facet.entityUid, createOpId: origins.facet.opId }] } });
  };
  return { db, section, facet, owners, creates, assignment, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

it.each([
  { kind: 'tag', secondClient: 'A' }, { kind: 'tag', secondClient: 'B' },
  { kind: 'facet', secondClient: 'A' }, { kind: 'facet', secondClient: 'B' },
] as const)('A and $secondClient converge on one canonical $kind with independently scoped origins and exact receipts', ({ kind, secondClient }) => {
  const f = fixture();
  try {
    const a = f.creates('A'), b = f.creates(secondClient);
    // A genuinely new Facet becomes the canonical row before B reuses it.
    if (kind === 'facet') {
      a.facet = syncReplayOperationSchema.parse({ ...a.facet, payload: { ...a.facet.payload, name: 'Convergent' } });
      b.facet = syncReplayOperationSchema.parse({ ...b.facet, payload: { ...b.facet.payload, name: 'Convergent' } });
    }
    const first = replaySyncOperation(f.db, a[kind]);
    expect(first).toMatchObject({ status: 'applied', opId: a[kind].opId });
    const unseen = createFacet(f.db, { sectionId: f.section.id, name: 'Unseen', sortOrder: 77 });
    const beforeVersion = f.db.prepare('SELECT sync_version FROM entry_tag_layouts WHERE entry_type=?').pluck().get('comic');
    const second = replaySyncOperation(f.db, b[kind]);
    expect(second).toMatchObject({ status: 'applied', opId: b[kind].opId, entityId: first.status === 'applied' ? first.entityId : -1 });
    expect(replaySyncOperation(f.db, a[kind])).toEqual(first);
    expect(replaySyncOperation(f.db, b[kind])).toEqual(second);
    expect(replaySyncOperation(f.db, syncReplayOperationSchema.parse({ ...b[kind], payload: { ...b[kind].payload, name: 'Changed' } }))).toMatchObject({ status: 'failed', errorCode: 'operation-id-collision' });
    expect(f.db.prepare('SELECT sync_version FROM entry_tag_layouts WHERE entry_type=?').pluck().get('comic')).toBe(beforeVersion);
    expect(f.db.prepare('SELECT sort_order FROM tag_groups WHERE id=?').pluck().get(unseen.id)).toBe(77);
    const table = kind === 'tag' ? 'sync_offline_created_entry_tags' : 'sync_offline_created_entry_facets';
    expect(f.db.prepare(`SELECT client_id FROM ${table} ORDER BY client_id`).pluck().all()).toEqual(['A', secondClient]);
    for (const op of [a[kind], b[kind]]) {
      expect(JSON.parse(f.db.prepare('SELECT result_json FROM sync_operation_receipts WHERE op_id=?').pluck().get(op.opId) as string)).toEqual(replaySyncOperation(f.db, op));
    }
    for (const origins of [a, b]) expect(replaySyncOperation(f.db, origins[kind === 'tag' ? 'facet' : 'tag']).status).toBe('applied');
    expect(replaySyncOperation(f.db, f.assignment(f.owners[2]!.id, a, 'B')).status).toBe('failed');
    for (const [index, origins] of [a, b].entries()) expect(replaySyncOperation(f.db, f.assignment(f.owners[index]!.id, origins)).status).toBe('applied');
    expect(f.db.prepare('SELECT COUNT(*) FROM entry_tags').pluck().get()).toBe(2);
    expect(f.db.prepare('SELECT COUNT(*) FROM tags WHERE normalized_name=?').pluck().get('shared')).toBe(1);
    expect(f.db.prepare('SELECT COUNT(*) FROM tag_groups WHERE parent_id=? AND name=?').pluck().get(f.section.id, kind === 'facet' ? 'Convergent' : 'Theme')).toBe(1);
  } finally { f.close(); }
});

it('migration 035 preserves populated schema34 origins receipts edges and enforces causal uniqueness with cascading plural origins', () => {
  const f = fixture(true);
  try {
    const a = f.creates('A');
    for (const op of [a.tag, a.facet]) expect(replaySyncOperation(f.db, op).status).toBe('applied');
    expect(replaySyncOperation(f.db, f.assignment(f.owners[0]!.id, a)).status).toBe('applied');
    const tables = ['tags', 'tag_groups', 'entry_tags', 'sync_offline_created_entry_tags', 'sync_offline_created_entry_facets', 'sync_operation_receipts', 'sync_entry_taxonomy_changes'];
    const before = tables.map(table => f.db.prepare(`SELECT * FROM ${table}`).all());
    // Neither registry is a parent FK target, nor referenced by persistent triggers.
    for (const row of f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>) {
      expect(f.db.prepare(`PRAGMA foreign_key_list("${row.name}")`).all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ table: 'sync_offline_created_entry_tags' })]));
      expect(f.db.prepare(`PRAGMA foreign_key_list("${row.name}")`).all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ table: 'sync_offline_created_entry_facets' })]));
    }
    expect(f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (sql LIKE '%sync_offline_created_entry_tags%' OR sql LIKE '%sync_offline_created_entry_facets%')").all()).toEqual([]);
    expect(applyAllMigrations(f.db)).toEqual({ applied: [35, 36, 37, 38, 39, 40, 41], currentVersion: 41 });
    expect(tables.map(table => f.db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    const b = f.creates('B');
    for (const op of [b.tag, b.facet]) expect(replaySyncOperation(f.db, op).status).toBe('applied');
    expect(replaySyncOperation(f.db, f.assignment(f.owners[1]!.id, b)).status).toBe('applied');
    for (const [table, uid] of [['sync_offline_created_entry_tags', 'tag_uid'], ['sync_offline_created_entry_facets', 'facet_uid']] as const) {
      expect(() => f.db.exec(`INSERT INTO ${table} SELECT * FROM ${table} LIMIT 1`)).toThrow(/UNIQUE/);
      // Separate checks for UUID and operation identity, on both registries.
      const origin = table.endsWith('tags') ? a.tag : a.facet;
      const second = table.endsWith('tags') ? b.tag : b.facet;
      expect(() => f.db.prepare(`UPDATE ${table} SET create_op_id=? WHERE ${uid}=?`).run(origin.opId, second.entityUid)).toThrow(/UNIQUE/);
      expect(() => f.db.prepare(`UPDATE ${table} SET ${uid}=? WHERE ${uid}=?`).run(origin.entityUid, second.entityUid)).toThrow(/UNIQUE/);
      expect(f.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").pluck().get(table)).toMatch(/WITHOUT ROWID/);
    }
    deleteFacet(f.db, f.facet.id);
    expect(f.db.prepare('SELECT COUNT(*) FROM sync_offline_created_entry_facets').pluck().get()).toBe(0);
    deleteTag(f.db, { vocabulary: 'entry', tagId: Number(f.db.prepare('SELECT id FROM tags WHERE normalized_name=?').pluck().get('shared')) });
    expect(f.db.prepare('SELECT COUNT(*) FROM sync_offline_created_entry_tags').pluck().get()).toBe(0);
    const doctorDb = Object.create(f.db) as typeof f.db;
    doctorDb.pragma = (query: string) => f.db.prepare(`PRAGMA ${query}`).all();
    expect(inspectDatabase(doctorDb).issues).toEqual([]);
    expect(runDatabaseProbe().ok).toBe(true);
  } finally { f.close(); }
});
