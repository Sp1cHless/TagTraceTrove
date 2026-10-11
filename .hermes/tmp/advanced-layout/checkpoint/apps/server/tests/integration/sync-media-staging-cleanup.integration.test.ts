import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { syncReplayOperationSchema } from '@t3/shared';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { setGalleryPartition } from '../../src/repositories/partition-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { replaySyncOperation } from '../../src/sync/replay-service.js';
import { replaySyncMediaUpload } from '../../src/sync/media-replay-service.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupAbandonedSyncMediaStaging } from '../../src/sync/media-replay-service.js';
import { startApiServer } from '../../src/http/server.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('offline media staging cleanup', () => {
  it('removes only expired upload temporary files under numeric Entry assets', async () => {
    const root = mkdtempSync(join(tmpdir(), 't3-sync-stage-'));
    roots.push(root);
    const entry = join(root, 'entries', '42');
    const thumbnails = join(entry, 'thumbnails');
    const other = join(root, 'entries', 'not-an-entry');
    mkdirSync(thumbnails, { recursive: true });
    mkdirSync(other, { recursive: true });
    const suffix = '12121212-1212-4212-8212-121212121212';
    const expiredSource = join(entry, `.cover.png.${suffix}.tmp`);
    const expiredThumb = join(thumbnails, `.cover.abcd1234abcd1234.webp.${suffix}.tmp`);
    const expiredPreview = join(entry, `.preview-2.png.${suffix}.tmp`);
    const expiredPreviewThumb = join(thumbnails, `.preview-2.abcd1234abcd1234.webp.${suffix}.tmp`);
    const recent = join(entry, `.preview.png.${suffix}.tmp`);
    const genuineAsset = join(entry, 'cover.png');
    const unrelated = join(other, `.cover.png.${suffix}.tmp`);
    for (const filename of [expiredSource, expiredThumb, expiredPreview, expiredPreviewThumb, recent, genuineAsset, unrelated]) {
      writeFileSync(filename, 'original bytes');
    }
    const now = Date.now();
    const old = new Date(now - 48 * 60 * 60 * 1000);
    for (const filename of [expiredSource, expiredThumb, expiredPreview, expiredPreviewThumb, unrelated]) utimesSync(filename, old, old);

    const removed = await cleanupAbandonedSyncMediaStaging(root, { now, maxAgeMs: 24 * 60 * 60 * 1000 });

    expect(removed).toBe(4);
    for (const filename of [expiredSource, expiredThumb, expiredPreview, expiredPreviewThumb]) expect(() => readFileSync(filename)).toThrow();
    for (const filename of [recent, genuineAsset, unrelated]) {
      expect(readFileSync(filename, 'utf8')).toBe('original bytes');
    }
  });

  it('sweeps abandoned uploads before a disposable server starts accepting requests', async () => {
    const root = mkdtempSync(join(tmpdir(), 't3-sync-server-stage-'));
    roots.push(root);
    const entry = join(root, 'assets', 'entries', '42');
    mkdirSync(entry, { recursive: true });
    const stale = join(entry, '.cover.png.12121212-1212-4212-8212-121212121212.tmp');
    writeFileSync(stale, 'old');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    const runtime = await startApiServer({ databasePath: join(root, 'library.db'), port: 0 });
    try {
      expect(() => readFileSync(stale)).toThrow();
    } finally {
      await runtime.close();
    }
  });

  it.each(['changed body', 'exact retry', 'different ID'])('isolates concurrent media staging: %s', async (mode) => {
    const database = createMigratedMemoryDatabase();
    setGalleryPartition(database, 'game', true);
    createEntry(database, { title: 'Seed', type: 'game' });
    const root = mkdtempSync(join(tmpdir(), 't3-sync-concurrent-stage-'));
    roots.push(root);
    const identity = getSyncIdentity(database);
    const entryUid = 'abababab-abab-4bab-8bab-abababababab';
    const created = replaySyncOperation(database, syncReplayOperationSchema.parse({
      opId: 'abababab-1111-4222-8333-444444444444', clientId: 'client',
      clientCreatedAt: '2026-09-30T00:00:00Z', ...identity,
      entityKind: 'entry', entityUid: entryUid, operationKind: 'entry.create', baseVersion: 0,
      baseValues: {}, payload: { title: 'Concurrent', type: 'game', uploadDate: null,
        pageCount: null, ratings: [], viewLater: false },
    }));
    if (created.status !== 'applied') throw new Error('Expected applied create');
    const images = await Promise.all(['#336699ff', '#ff0000ff'].map((background) =>
      sharp({ create: { width: 4, height: 3, channels: 4, background } }).png().toBuffer()));
    if (mode === 'exact retry') images[1] = images[0]!;
    const gate = () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      return { promise, release };
    };
    const stagedFirst = gate(); const stagedSecond = gate();
    const allowFirst = gate(); const allowSecond = gate();
    const uploadId = '12121212-1212-4212-8212-121212121212';
    const upload = (index: number, staged: ReturnType<typeof gate>, allow: ReturnType<typeof gate>) => {
      const image = images[index]!;
      return replaySyncMediaUpload(database, root, mode === 'different ID' && index === 1
        ? '23232323-2323-4232-8232-232323232323' : uploadId, {
        ...identity, entryUid, kind: 'preview', ordinal: 0, mimeType: 'image/png',
        byteLength: image.byteLength, sha256: createHash('sha256').update(image).digest('hex'),
      }, image, { stageWrite: async (filename, bytes) => {
        await writeFile(filename, bytes);
        if (!filename.includes('thumbnails')) { staged.release(); await allow.promise; }
      } });
    };
    const first = upload(0, stagedFirst, allowFirst);
    await stagedFirst.promise;
    const second = upload(1, stagedSecond, allowSecond);
    void second.catch(() => undefined);
    try {
      await stagedSecond.promise;
      allowFirst.release();
      const receipt = await first;
      const directory = join(root, 'entries', String(created.entityId));
      expect(readFileSync(join(directory, 'preview.png'))).toEqual(images[0]);
      const thumbnailFile = join(directory, 'thumbnails', `preview.${createHash('sha256').update(images[0]!).digest('hex').slice(0, 16)}.webp`);
      const originalThumbnail = readFileSync(thumbnailFile);
      expect(originalThumbnail).toEqual(
        await sharp(images[0]).rotate().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80, effort: 4 }).toBuffer());
      allowSecond.release();
      if (mode === 'exact retry') await expect(second).resolves.toEqual(receipt);
      else await expect(second).rejects.toThrow(/already used|replace|skip/i);
      expect(readFileSync(join(directory, 'preview.png'))).toEqual(images[0]);
      expect(readFileSync(thumbnailFile)).toEqual(originalThumbnail);
      expect(readdirSync(join(directory, 'thumbnails')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect(database.prepare('SELECT COUNT(*) FROM sync_media_upload_receipts').pluck().get()).toBe(1);
      expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      allowFirst.release(); allowSecond.release();
      await Promise.allSettled([first, second]);
      database.close();
    }
  });

  it('cleans the first temp file when staging the second image fails before the DB transaction', async () => {
    const database = createMigratedMemoryDatabase();
    setGalleryPartition(database, 'game', true);
    createEntry(database, { title: 'Existing Gallery seed', type: 'game' });
    const root = mkdtempSync(join(tmpdir(), 't3-sync-stage-write-'));
    roots.push(root);
    const identity = getSyncIdentity(database);
    const entryUid = 'abababab-abab-4bab-8bab-abababababab';
    const create = syncReplayOperationSchema.parse({
      opId: 'abababab-1111-4222-8333-444444444444',
      clientId: '99999999-8888-4777-8666-555555555555',
      clientCreatedAt: '2026-09-19T12:00:00.000Z',
      ...identity,
      entityKind: 'entry', entityUid: entryUid, operationKind: 'entry.create', baseVersion: 0,
      baseValues: {},
      payload: { title: 'Staged', type: 'game', uploadDate: null, pageCount: null, ratings: [], viewLater: false },
    });
    const created = replaySyncOperation(database, create);
    if (created.status !== 'applied') throw new Error(JSON.stringify(created));
    const png = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#336699ff' } }).png().toBuffer();
    const metadata = {
      ...identity, entryUid, kind: 'cover' as const, ordinal: 0 as const,
      mimeType: 'image/png' as const, byteLength: png.byteLength,
      sha256: createHash('sha256').update(png).digest('hex'),
    };
    let writes = 0;
    try {
      await expect(replaySyncMediaUpload(
        database, root, '12121212-1212-4212-8212-121212121212', metadata, png,
        { stageWrite: async (filename, bytes) => {
          writes += 1;
          if (writes === 2) throw new Error('thumbnail staging disk failure');
          await writeFile(filename, bytes);
        } },
      )).rejects.toThrow('thumbnail staging disk failure');
      expect(writes).toBe(2);
      const entry = join(root, 'entries', String(created.status === 'applied' ? created.entityId : -1));
      expect(readdirSync(entry).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect(database.prepare('SELECT COUNT(*) FROM sync_media_upload_receipts').pluck().get()).toBe(0);
    } finally {
      database.close();
    }
  });
});
