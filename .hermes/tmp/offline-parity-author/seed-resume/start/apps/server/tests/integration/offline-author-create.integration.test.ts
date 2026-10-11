import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import type { T3Database } from '../../src/database/connection.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { createProducer } from '../../src/repositories/producer-repository.js';
import { buildSyncCapabilities, getSyncIdentity } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
import { syncReplayOperationSchema } from '@t3/shared';

const databases: T3Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close();
});

function setup() {
  const database = createMigratedMemoryDatabase();
  databases.push(database);
  const entry = createEntry(database, { title: 'Offline test', type: 'game' });
  const identity = getSyncIdentity(database);
  const entryUid = database.prepare('SELECT sync_uid FROM entries WHERE id = ?').pluck().get(entry.id) as string;
  const entryVersion = database.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id) as number;
  const operation = {
    opId: '11111111-1111-4111-8111-111111111111',
    clientId: 'author-create-test',
    libraryId: identity.libraryId,
    syncEpoch: identity.syncEpoch,
    entityKind: 'entry',
    entityUid: entryUid,
    operationKind: 'entry.author.create-and-link',
    baseVersion: entryVersion,
    baseValues: { producerUids: [] },
    payload: { producerUid: '22222222-2222-4222-8222-222222222222', name: 'New Offline Author' },
    clientCreatedAt: '2026-09-25T00:00:00.000Z',
  } as const;
  return { database, entry, entryVersion, operation };
}

describe('atomic offline Author creation and Entry link', () => {
  it('creates one durable Producer with the client UID, links it, journals both, and deduplicates retry', () => {
    const { database, entry, entryVersion, operation } = setup();
    expect(buildSyncCapabilities(database, 'test').featureFlags.offlineAuthorCreate).toBe(true);
    const parsed = syncReplayOperationSchema.parse(operation);
    const first = replaySyncOperation(database, parsed);
    expect(first.status).toBe('applied');
    expect(replaySyncOperation(database, parsed)).toEqual(first);
    expect(database.prepare('SELECT COUNT(*) FROM producers WHERE sync_uid = ?').pluck().get(operation.payload.producerUid)).toBe(1);
    expect(database.prepare(`
      SELECT producer.name FROM entry_producers AS link
      JOIN producers AS producer ON producer.id = link.producer_id
      WHERE link.entry_id = ?
    `).pluck().all(entry.id)).toEqual(['New Offline Author']);
    expect(database.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id)).toBe(entryVersion + 1);
    expect(database.prepare('SELECT COUNT(*) FROM sync_operation_receipts').pluck().get()).toBe(1);
  });

  it('does not create a duplicate if the name has become an existing Author or alias', () => {
    const { database, entry, operation } = setup();
    createProducer(database, { name: 'New Offline Author' });
    const result = replaySyncOperation(database, syncReplayOperationSchema.parse(operation));
    expect(result.status).toBe('conflict');
    expect(database.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(1);
    expect(database.prepare('SELECT COUNT(*) FROM entry_producers WHERE entry_id = ?').pluck().get(entry.id)).toBe(0);
  });

  it('refuses to create an offline Author when a newly mapped alias points elsewhere', () => {
    const { database, entry, operation } = setup();
    database.prepare(`
      INSERT INTO taxonomy_aliases
        (vocabulary, partition, alias_name, normalized_alias, canonical_name, normalized_canonical)
      VALUES ('producer', 'authors', ?, ?, ?, ?)
    `).run('New Offline Author', 'new offline author', 'Canonical Author', 'canonical author');
    const result = replaySyncOperation(database, syncReplayOperationSchema.parse(operation));
    expect(result.status).toBe('conflict');
    expect(database.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM entry_producers WHERE entry_id = ?').pluck().get(entry.id)).toBe(0);
  });

  it('rolls back Producer and link if durable receipt insertion fails', () => {
    const { database, entry, operation } = setup();
    database.exec(`
      CREATE TRIGGER block_author_create_receipt BEFORE INSERT ON sync_operation_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt blocked'); END;
    `);
    expect(() => replaySyncOperation(database, syncReplayOperationSchema.parse(operation))).toThrow();
    expect(database.prepare('SELECT COUNT(*) FROM producers').pluck().get()).toBe(0);
    expect(database.prepare('SELECT COUNT(*) FROM entry_producers WHERE entry_id = ?').pluck().get(entry.id)).toBe(0);
  });
});
