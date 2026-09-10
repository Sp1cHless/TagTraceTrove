import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { backfillEntryThumbnails } from '../../src/import/thumbnail-backfill.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('Entry thumbnail backfill', () => {
  it('is resumable and continues after an unreadable source image', async () => {
    const assetRoot = await mkdtemp(join(tmpdir(), 't3-thumbnail-backfill-'));
    temporaryDirectories.push(assetRoot);
    const goodDirectory = join(assetRoot, 'entries', '7');
    const badDirectory = join(assetRoot, 'entries', '8');
    await mkdir(goodDirectory, { recursive: true });
    await mkdir(badDirectory, { recursive: true });
    await writeFile(
      join(goodDirectory, 'cover.png'),
      await sharp({
        create: { width: 900, height: 1_200, channels: 3, background: '#6a1b9a' },
      }).png().toBuffer(),
    );
    await writeFile(join(badDirectory, 'preview.jpg'), new Uint8Array([1, 2, 3]));

    const first = await backfillEntryThumbnails(assetRoot);
    expect(first).toMatchObject({ scanned: 2, generated: 1, skipped: 0, failed: 1, interrupted: false });
    expect(first.errors[0]).toMatchObject({ entryId: 8, fileName: 'preview.jpg' });

    const second = await backfillEntryThumbnails(assetRoot);
    expect(second).toMatchObject({ scanned: 2, generated: 0, skipped: 1, failed: 1, interrupted: false });
  });
});
