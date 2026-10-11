import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createSection } from '../../src/repositories/layout-repository.js';
import { assignEntryTag } from '../../src/repositories/entry-tag-repository.js';
import { getSyncIdentity, buildSyncCapabilities } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
import { syncReplayOperationSchema } from '@t3/shared';
import { inspectDatabase } from '../../src/database/doctor.js';

const databases: Array<ReturnType<typeof createMigratedMemoryDatabase>> = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

it('rejects invalid Facet before deleting assignments or creating typed names', () => {
  const db = createMigratedMemoryDatabase(); databases.push(db);
  const entry = createEntry(db, { title: 'Entry', type: 'comic' });
  const section = createSection(db, { entryType: 'comic', name: 'Tags' });
  const wrong = createSection(db, { entryType: 'game', name: 'Tags' });
  assignEntryTag(db, { entryId: entry.id, facetId: section.defaultFacetId, name: 'Existing' });
  const identity = getSyncIdentity(db);
  const uid = String(db.prepare('SELECT sync_uid FROM entries WHERE id = ?').pluck().get(entry.id));
  const version = Number(db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id));
  const operation = syncReplayOperationSchema.parse({
    opId: randomUUID(), clientId: 'test', ...identity, entityUid: uid,
    clientCreatedAt: '2026-09-25T00:00:00Z', entityKind: 'entry', operationKind: 'entry.tags.set',
    baseVersion: version, baseValues: { tags: [{ name: 'Existing', facetId: section.defaultFacetId }] },
    payload: { tags: [{ name: 'New', facetId: section.defaultFacetId }, { name: 'Bad', facetId: wrong.defaultFacetId }] },
  });
  expect(replaySyncOperation(db, operation)).toMatchObject({ status: 'failed', errorCode: 'invalid-tag-data' });
  expect(db.prepare('SELECT normalized_name FROM tags ORDER BY normalized_name').pluck().all()).toEqual(['existing']);
  expect(db.prepare('SELECT COUNT(*) FROM entry_tags WHERE entry_id = ?').pluck().get(entry.id)).toBe(1);
  expect(db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id)).toBe(version);
});

it('accepts an unchanged base tag set regardless of SQLite versus locale sort order', () => {
  const db = createMigratedMemoryDatabase(); databases.push(db);
  const entry = createEntry(db, { title: 'Entry', type: 'comic' });
  const section = createSection(db, { entryType: 'comic', name: 'Tags' });
  assignEntryTag(db, { entryId: entry.id, facetId: section.defaultFacetId, name: 'zebra' });
  assignEntryTag(db, { entryId: entry.id, facetId: section.defaultFacetId, name: 'äther' });
  const identity = getSyncIdentity(db);
  const uid = String(db.prepare('SELECT sync_uid FROM entries WHERE id = ?').pluck().get(entry.id));
  const version = Number(db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id));
  const operation = syncReplayOperationSchema.parse({
    opId: randomUUID(), clientId: 'test', ...identity, entityUid: uid,
    clientCreatedAt: '2026-09-25T00:00:00Z', entityKind: 'entry', operationKind: 'entry.tags.set',
    baseVersion: version,
    baseValues: { tags: [
      { name: 'zebra', facetId: section.defaultFacetId },
      { name: 'äther', facetId: section.defaultFacetId },
    ] },
    payload: { tags: [
      { name: 'zebra', facetId: section.defaultFacetId },
      { name: 'äther', facetId: section.defaultFacetId },
      { name: 'new', facetId: section.defaultFacetId },
    ] },
  });
  expect(replaySyncOperation(db, operation)).toMatchObject({ status: 'applied' });
  expect(db.prepare('SELECT normalized_name FROM tags ORDER BY normalized_name').pluck().all())
    .toEqual(['new', 'zebra', 'äther']);
});

it('conflicts against complete current assignment set after concurrent owner change', () => {
  const db = createMigratedMemoryDatabase(); databases.push(db);
  const entry = createEntry(db, { title: 'Entry', type: 'comic' });
  const section = createSection(db, { entryType: 'comic', name: 'Tags' });
  const identity = getSyncIdentity(db);
  const uid = String(db.prepare('SELECT sync_uid FROM entries WHERE id = ?').pluck().get(entry.id));
  const version = Number(db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id));
  assignEntryTag(db, { entryId: entry.id, facetId: section.defaultFacetId, name: 'Concurrent' });
  const operation = syncReplayOperationSchema.parse({
    opId: randomUUID(), clientId: 'test', ...identity, entityUid: uid,
    clientCreatedAt: '2026-09-25T00:00:00Z', entityKind: 'entry', operationKind: 'entry.tags.set',
    baseVersion: version, baseValues: { tags: [] }, payload: { tags: [{ name: 'Mine', facetId: section.defaultFacetId }] },
  });
  const result = replaySyncOperation(db, operation);
  expect(result).toMatchObject({ status: 'conflict', currentValues: { tags: [{ name: 'Concurrent', facetId: section.defaultFacetId }] } });
  expect(replaySyncOperation(db, operation)).toEqual(result);
  expect(db.prepare('SELECT normalized_name FROM tags').pluck().all()).toEqual(['concurrent']);
});

it('replays complete Entry Tag assignment set with normalized identity, journal and exact receipt', () => {
  const db = createMigratedMemoryDatabase(); databases.push(db);
  const entry = createEntry(db, { title: 'Entry', type: 'comic' });
  const section = createSection(db, { entryType: 'comic', name: 'Tags' });
  const identity = getSyncIdentity(db);
  const version = Number(db.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id));
  const op = syncReplayOperationSchema.parse({
    opId: randomUUID(), clientId: 'test', ...identity, entityUid: String(db.prepare('SELECT sync_uid FROM entries WHERE id = ?').pluck().get(entry.id)),
    clientCreatedAt: '2026-09-25T00:00:00Z', entityKind: 'entry',
    operationKind: 'entry.tags.set', baseVersion: version,
    baseValues: { tags: [] }, payload: { tags: [{ name: '  Hello  ', facetId: section.defaultFacetId }] },
  });
  expect(buildSyncCapabilities(db, 'test').featureFlags.offlineEntryTags).toBe(true);
  const result = replaySyncOperation(db, op);
  expect(result.status).toBe('applied');
  expect(result).toMatchObject({ resourceVersion: version + 1 });
  expect(replaySyncOperation(db, op)).toEqual(result);
  expect(db.prepare('SELECT normalized_name FROM tags').pluck().all()).toEqual(['hello']);
  expect(db.prepare('SELECT facet_id FROM entry_tags WHERE entry_id = ?').pluck().all(entry.id)).toEqual([section.defaultFacetId]);
  expect(inspectDatabase(db).ok).toBe(true);
});
