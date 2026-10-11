import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { applyEntryMediaOrder, storeEntryMedia } from '../../src/import/media.js';
import { createEntry, getEntryDetail } from '../../src/repositories/entry-repository.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { replayEntryMediaOperation } from '../../src/sync/replay-service.js';
import type { SyncEntryMediaOperation } from '@t3/shared';

async function png(hex: string): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 16, channels: 3, background: hex } }).png().toBuffer();
}

async function entryWithThreeImages(assetRoot: string, database: ReturnType<typeof createMigratedMemoryDatabase>) {
  const entry = createEntry(database, { title: 'Media', type: 'comic' });
  const cover = await storeEntryMedia(database, assetRoot, {
    entryId: entry.id, kind: 'cover', mimeType: 'image/png', bytes: await png('#ff0000'),
  });
  const first = await storeEntryMedia(database, assetRoot, {
    entryId: entry.id, kind: 'preview', mimeType: 'image/png', bytes: await png('#00ff00'),
  });
  const second = await storeEntryMedia(database, assetRoot, {
    entryId: entry.id, kind: 'preview', mimeType: 'image/png', bytes: await png('#0000ff'),
  });
  return {
    entryId: entry.id,
    refs: [cover.relativeRef, first.relativeRef, second.relativeRef],
  };
}

function mediaOperation(
  libraryId: string,
  syncEpoch: string,
  entryUid: string,
  baseRefs: string[],
  refs: string[],
  baseVersion: number,
  opId = '77777777-7777-4777-8777-777777777777',
): SyncEntryMediaOperation {
  return {
    opId,
    clientId: 'client-media-order',
    libraryId,
    syncEpoch,
    entityKind: 'entry',
    entityUid: entryUid,
    operationKind: 'entry.media.set',
    baseVersion,
    baseValues: { refs: baseRefs },
    payload: { refs },
    clientCreatedAt: '2026-10-07T00:00:00.000Z',
  } as SyncEntryMediaOperation;
}

describe('Entry media order', () => {
  it('renames every file into its new position and deletes what the new list omits', async () => {
    const database = createMigratedMemoryDatabase();
    const assetRoot = await mkdtemp(join(tmpdir(), 't3-media-order-'));
    try {
      const { entryId, refs } = await entryWithThreeImages(assetRoot, database);
      const entry = getEntryDetail(database, entryId)!;
      expect(refs[0]).toContain('/cover.png');
      expect(refs[1]).toContain('/preview.png');
      expect(refs[2]).toContain('/preview-2.png');

      // The second preview becomes the cover, and the old cover becomes a
      // preview: a permutation, which is why the files move through temporaries.
      const reordered = await applyEntryMediaOrder(database, assetRoot, entryId, [refs[2]!, refs[0]!]);
      const directory = join(assetRoot, 'entries', String(entryId));
      expect(reordered.coverRef).toBe(`/api/assets/entries/${entryId}/cover.png`);
      expect(reordered.previewRefs).toEqual([`/api/assets/entries/${entryId}/preview.png`]);
      const files = (await readdir(directory)).filter((name) => name.endsWith('.png')).sort();
      expect(files).toEqual(['cover.png', 'preview.png']);
      // The dropped image's thumbnail goes with it.
      const thumbnails = await readdir(join(directory, 'thumbnails'));
      expect(thumbnails).toHaveLength(2);
      expect(thumbnails.every((name) => name.endsWith('.webp'))).toBe(true);
      // Bytes followed their refs: the new cover is the blue one that was `preview-3`.
      const coverBytes = await sharp(join(directory, 'cover.png')).stats();
      expect(coverBytes.channels[2]!.mean).toBeGreaterThan(coverBytes.channels[0]!.mean);
      void entry;
    } finally {
      database.close();
      await rm(assetRoot, { recursive: true, force: true });
    }
  });

  it('replays the order as one command, conflicting on a stale base and staying idempotent', async () => {
    const database = createMigratedMemoryDatabase();
    const assetRoot = await mkdtemp(join(tmpdir(), 't3-media-replay-'));
    try {
      const { entryId, refs } = await entryWithThreeImages(assetRoot, database);
      const identity = getSyncIdentity(database);
      // The detail DTO does not carry sync_uid; a replay addresses the row by it.
      const row = database.prepare('SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM entries WHERE id = ?')
        .get(entryId) as { syncUid: string; syncVersion: number };
      const operation = mediaOperation(
        identity.libraryId, identity.syncEpoch, row.syncUid, refs, [refs[1]!, refs[0]!, refs[2]!], row.syncVersion,
      );

      const applied = await replayEntryMediaOperation(database, assetRoot, operation);
      expect(applied.status).toBe('applied');
      const after = getEntryDetail(database, entryId)!;
      // Names are positional after the move: position 0 is `cover.*` whatever it
      // used to be called, which is what the review page's own model says too.
      expect(after.coverRef).toBe(`/api/assets/entries/${entryId}/cover.png`);
      expect(after.previewRefs).toEqual([
        `/api/assets/entries/${entryId}/preview.png`,
        `/api/assets/entries/${entryId}/preview-2.png`,
      ]);
      // Bytes, not names: the green preview the client promoted is now the cover.
      const promoted = await sharp(join(assetRoot, 'entries', String(entryId), 'cover.png')).stats();
      expect(promoted.channels[1]!.mean).toBeGreaterThan(promoted.channels[0]!.mean);

      // The same opId replays from its receipt without touching the files again.
      const again = await replayEntryMediaOperation(database, assetRoot, operation);
      expect(again).toEqual(applied);

      // A second client that still held the old list conflicts instead of
      // overwriting the newer order.
      const stale = {
        ...operation,
        opId: '88888888-8888-4888-8888-888888888888',
        payload: { refs: [refs[2]!, refs[0]!, refs[1]!] },
      };
      const conflicted = await replayEntryMediaOperation(database, assetRoot, stale);
      expect(conflicted.status).toBe('conflict');
      expect(getEntryDetail(database, entryId)!.coverRef).toBe(`/api/assets/entries/${entryId}/cover.png`);
    } finally {
      database.close();
      await rm(assetRoot, { recursive: true, force: true });
    }
  });
});
