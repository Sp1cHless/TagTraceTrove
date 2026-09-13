// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { SyncSnapshot } from '@t3/shared';
import {
  ACTIVE_GENERATION_KEY,
  applySnapshot,
  createMemorySnapshotStore,
  readActiveSnapshot,
  verifyChecksum,
} from '../src/offline/snapshot-store.js';

function makeSnapshot(overrides: Partial<SyncSnapshot['header']> = {}): SyncSnapshot {
  const header = {
    libraryId: 'lib-1',
    syncEpoch: 'epoch-1',
    snapshotSeq: 1,
    generatedAt: '2026-09-13T00:00:00Z',
    sqliteSchemaVersion: 15,
    snapshotFormatVersion: 1,
    counts: { entries: 1, producers: 0, entryContents: 0, entryTags: 0, collections: 0 },
    ...overrides,
  };
  const { checksum, ...rest } = header;
  void checksum;
  const hashable = { header: rest, payload: { entries: [], producers: [], entryProducers: [], tags: [], tagGroups: [], entryTags: [], producerTags: [], producerTagAssignments: [], entryContents: [], ratingSlots: [], entryRatingValues: [], producerRatingValues: [], collections: [], collectionMembers: [], authorDirectories: [], authorDirectoryEntries: [], entryUsage: [], viewLaterEntries: [], viewLaterProducers: [], gallerySettings: [], mediaRefs: [] } };
  // The test cannot recompute the server hash synchronously; it stamps a
  // placeholder and the happy-path test patches it via the real server
  // checksum shape. For pure client rules we use a fixed marker checksum.
  const fixed = '0'.repeat(64);
  return { header: { ...header, checksum: overrides.checksum ?? fixed }, payload: hashable.payload };
}

async function stampChecksum(snapshot: SyncSnapshot): Promise<void> {
  // Mirror the server exactly: sha256(JSON(header-without-checksum) + JSON(payload)).
  const { checksum, ...header } = snapshot.header;
  void checksum;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(header) + JSON.stringify(snapshot.payload),
  ));
  snapshot.header.checksum = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

describe('snapshot store rules', () => {
  it('rejects a wrong library id before touching the store', async () => {
    const store = createMemorySnapshotStore();
    const result = await applySnapshot(makeSnapshot({ libraryId: 'other-lib' }), {
      store,
      currentLibraryId: 'lib-1',
    });
    expect(result).toEqual({
      ok: false,
      failure: { reason: 'library-mismatch', detail: 'other-lib' },
    });
    expect(await store.listGenerationIds()).toEqual([]);
  });

  it('rejects a rotated epoch and stale sequences without writing', async () => {
    const store = createMemorySnapshotStore();
    const rotated = await applySnapshot(makeSnapshot({ syncEpoch: 'epoch-2' }), {
      store,
      currentLibraryId: 'lib-1',
      currentSyncEpoch: 'epoch-1',
    });
    expect(rotated).toMatchObject({ ok: false, failure: { reason: 'epoch-mismatch' } });

    const stale = await applySnapshot(makeSnapshot({ snapshotSeq: 3 }), {
      store,
      currentLibraryId: 'lib-1',
      currentSyncEpoch: 'epoch-1',
      currentSnapshotSeq: 5,
    });
    expect(stale).toMatchObject({ ok: false, failure: { reason: 'stale-snapshot' } });
  });

  it('rejects checksum mismatches', async () => {
    const store = createMemorySnapshotStore();
    const snapshot = makeSnapshot();
    const result = await applySnapshot(snapshot, {
      store,
      currentLibraryId: 'lib-1',
      currentSyncEpoch: 'epoch-1',
    });
    expect(result).toMatchObject({ ok: false, failure: { reason: 'checksum-mismatch' } });
    expect(await verifyChecksum(snapshot, snapshot.header.checksum)).toBe(false);
  });

  it('writes a new generation and atomically switches the active pointer', async () => {
    const store = createMemorySnapshotStore();
    const first = makeSnapshot();
    await stampChecksum(first);

    const applied = await applySnapshot(first, { store });
    expect(applied).toMatchObject({ ok: true, generationId: 1, identity: { libraryId: 'lib-1' } });
    const active = await readActiveSnapshot(store);
    expect(active?.generationId).toBe(1);
    expect(active?.snapshot.header.snapshotSeq).toBe(1);
    expect(await store.readMeta(ACTIVE_GENERATION_KEY)).toBe('1');

    // A second snapshot prunes nothing but generation 1 stays as fallback.
    const second = makeSnapshot({ snapshotSeq: 2 });
    await stampChecksum(second);
    const secondApplied = await applySnapshot(second, { store });
    expect(secondApplied).toMatchObject({ ok: true, generationId: 2 });
    expect(await store.listGenerationIds()).toEqual([1, 2]);
    expect(await readActiveSnapshot(store)).toMatchObject({ generationId: 2 });
  });

  it('keeps the previous generation active when the new write fails', async () => {
    const store = createMemorySnapshotStore();
    await store.writeGeneration(1, '{"header":{},"payload":{}}');
    await store.writeMeta(ACTIVE_GENERATION_KEY, '1');
    const failing: typeof store = {
      ...store,
      async writeGeneration(generationId) {
        if (generationId > 1) throw new Error('quota exceeded');
        await store.writeGeneration(generationId, '{}');
      },
    };
    const third = makeSnapshot();
    await stampChecksum(third);
    const result = await applySnapshot(third, { store: failing });
    expect(result).toMatchObject({ ok: false, failure: { reason: 'quota' } });
    // The old pointer and generation survive untouched.
    expect(await store.readMeta(ACTIVE_GENERATION_KEY)).toBe('1');
    expect(await store.readGeneration(1)).toBe('{"header":{},"payload":{}}');
  });
});
