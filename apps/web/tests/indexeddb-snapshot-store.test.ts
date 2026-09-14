// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { indexedDB } from 'fake-indexeddb';
import { createIndexedDbSnapshotStore } from '../src/offline/indexeddb-snapshot-store.js';

const databaseNames: string[] = [];

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('failed to delete IndexedDB fixture'));
    request.onblocked = () => reject(new Error('IndexedDB fixture deletion was blocked'));
  });
}

afterEach(async () => {
  for (const name of databaseNames.splice(0)) await deleteDatabase(name);
});

describe('IndexedDB snapshot store', () => {
  it('persists snapshot generations and metadata across store instances', async () => {
    const databaseName = `t3-offline-test-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    const first = createIndexedDbSnapshotStore({ indexedDB, databaseName });

    await first.writeGeneration(2, '{"snapshotSeq":2}');
    await first.writeGeneration(1, '{"snapshotSeq":1}');
    await first.writeMeta('activeGeneration', '2');
    first.close();

    const reopened = createIndexedDbSnapshotStore({ indexedDB, databaseName });
    expect(await reopened.listGenerationIds()).toEqual([1, 2]);
    expect(await reopened.readGeneration(2)).toBe('{"snapshotSeq":2}');
    expect(await reopened.readMeta('activeGeneration')).toBe('2');

    await reopened.deleteGeneration(1);
    expect(await reopened.listGenerationIds()).toEqual([2]);
    reopened.close();
  });
});
