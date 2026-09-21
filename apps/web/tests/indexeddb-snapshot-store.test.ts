// @vitest-environment jsdom

import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import { createIndexedDbOfflineStore } from '../src/offline/indexeddb-snapshot-store.js';
import { clearOfflineSnapshot } from '../src/offline/offline-sync.js';
import { createPendingSyncOperation } from '../src/offline/outbox-store.js';

const databaseNames: string[] = [];

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('failed to delete IndexedDB fixture'));
    request.onblocked = () => reject(new Error('IndexedDB fixture deletion was blocked'));
  });
}

function createLegacyV1Database(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('snapshotGenerations');
      request.result.createObjectStore('meta');
    };
    request.onerror = () => reject(request.error ?? new Error('failed to create v1 fixture'));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(['snapshotGenerations', 'meta'], 'readwrite');
      transaction.objectStore('snapshotGenerations').put('{"snapshotSeq":1}', 1);
      transaction.objectStore('meta').put('1', 'activeGeneration');
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error ?? new Error('failed to seed v1 fixture'));
    };
  });
}

afterEach(async () => {
  for (const name of databaseNames.splice(0)) await deleteDatabase(name);
});

describe('IndexedDB snapshot store', () => {
  it('persists snapshot generations and metadata across store instances', async () => {
    const databaseName = `t3-offline-test-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    const first = createIndexedDbOfflineStore({ indexedDB, databaseName });

    await first.writeGeneration(2, '{"snapshotSeq":2}');
    await first.writeGeneration(1, '{"snapshotSeq":1}');
    await first.writeMeta('activeGeneration', '2');
    first.close();

    const reopened = createIndexedDbOfflineStore({ indexedDB, databaseName });
    expect(await reopened.listGenerationIds()).toEqual([1, 2]);
    expect(await reopened.readGeneration(2)).toBe('{"snapshotSeq":2}');
    expect(await reopened.readMeta('activeGeneration')).toBe('2');

    await reopened.deleteGeneration(1);
    expect(await reopened.listGenerationIds()).toEqual([2]);
    reopened.close();
  });

  it('upgrades v1 without losing snapshots and preserves outbox rows across restart and snapshot clear', async () => {
    const databaseName = `t3-offline-test-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    await createLegacyV1Database(databaseName);
    const operation = createPendingSyncOperation({
      clientId: '11111111-1111-4111-8111-111111111111',
      libraryId: 'library-1',
      syncEpoch: 'epoch-1',
      entityKind: 'entry',
      entityUid: '22222222-2222-4222-8222-222222222222',
      operationKind: 'entry.patch',
      baseVersion: 3,
      baseValues: { title: 'Before' },
      payload: { title: 'After' },
    });
    const secondOperation = {
      ...operation,
      opId: '00000000-0000-4000-8000-000000000000',
      entityKind: 'rating',
      entityUid: '44444444-4444-4444-8444-444444444444',
      operationKind: 'rating.set',
      payload: { stars: 4.5 },
    };
    const createOperation = {
      ...operation,
      opId: '55555555-5555-4555-8555-555555555555',
      entityUid: '66666666-6666-4666-8666-666666666666',
      operationKind: 'entry.create',
      baseVersion: 0,
      baseValues: {},
      payload: { title: 'Queued create', type: 'game' },
    };
    const stagedMedia = {
      uploadId: '77777777-7777-4777-8777-777777777777',
      libraryId: '11111111-1111-4111-8111-111111111111',
      syncEpoch: 'epoch-1',
      entryUid: createOperation.entityUid,
      kind: 'cover' as const,
      ordinal: 0 as const,
      mimeType: 'image/png' as const,
      byteLength: 4,
      sha256: 'a'.repeat(64),
      blob: new NodeBlob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }) as unknown as Blob,
      status: 'pending' as const,
      lastAttemptAt: null,
      lastError: null,
    };
    const upgraded = createIndexedDbOfflineStore({ indexedDB, databaseName });

    expect(await upgraded.readGeneration(1)).toBe('{"snapshotSeq":1}');
    expect(await upgraded.enqueue(operation)).toBe('queued');
    expect(await upgraded.enqueue(secondOperation)).toBe('queued');
    await upgraded.enqueueEntryCreate(createOperation, [stagedMedia]);
    await upgraded.update(operation.opId, {
      status: 'conflict',
      lastAttemptAt: '2026-09-14T12:01:00.000Z',
      lastError: 'newer server value',
    });
    const conflictedOperation = {
      ...operation,
      status: 'conflict' as const,
      lastAttemptAt: '2026-09-14T12:01:00.000Z',
      lastError: 'newer server value',
    };
    upgraded.close();

    const reopened = createIndexedDbOfflineStore({ indexedDB, databaseName });
    expect(await reopened.list()).toEqual([conflictedOperation, secondOperation, createOperation]);
    const reopenedMedia = await reopened.listMedia();
    expect(reopenedMedia).toHaveLength(1);
    expect(reopenedMedia[0]).toMatchObject({
      uploadId: stagedMedia.uploadId,
      entryUid: stagedMedia.entryUid,
      sha256: stagedMedia.sha256,
      status: 'pending',
    });
    expect([...new Uint8Array(await reopenedMedia[0]!.blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    await clearOfflineSnapshot(reopened);
    expect(await reopened.readGeneration(1)).toBeNull();
    expect(await reopened.list()).toEqual([conflictedOperation, secondOperation, createOperation]);
    expect(await reopened.listMedia()).toHaveLength(1);
    await reopened.removeMany([
      operation.opId,
      secondOperation.opId,
      createOperation.opId,
      'missing-op-id',
    ]);
    expect(await reopened.list()).toEqual([]);
    await reopened.removeMedia(stagedMedia.uploadId);
    expect(await reopened.listMedia()).toEqual([]);
    reopened.close();
  });
});
