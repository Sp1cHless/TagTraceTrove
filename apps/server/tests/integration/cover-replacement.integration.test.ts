import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { storeEntryMedia } from '../../src/import/media.js';
import { createEntry, getEntryDetail } from '../../src/repositories/entry-repository.js';

describe('cover replacement', () => {
  it('keeps the prior cover and thumbnail when replacement thumbnail rendering fails', async () => {
    const database = createMigratedMemoryDatabase();
    const assetRoot = await mkdtemp(join(tmpdir(), 't3-cover-replace-'));
    try {
      const entry = createEntry(database, { title: 'Cover', type: 'comic' });
      const original = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ff0000' } }).png().toBuffer();
      const stored = await storeEntryMedia(database, assetRoot, { entryId: entry.id, kind: 'cover', mimeType: 'image/png', bytes: original });
      const mediaDirectory = join(assetRoot, 'entries', String(entry.id));
      const thumbnailsBefore = await readdir(join(mediaDirectory, 'thumbnails'));

      await expect(storeEntryMedia(database, assetRoot, {
        entryId: entry.id,
        kind: 'cover',
        mimeType: 'image/png',
        bytes: Buffer.from('not a decodable PNG'),
      })).rejects.toThrow();

      expect(await readFile(join(mediaDirectory, 'cover.png'))).toEqual(original);
      expect(await readdir(join(mediaDirectory, 'thumbnails'))).toEqual(thumbnailsBefore);
      expect(getEntryDetail(database, entry.id)?.coverRef).toBe(stored.relativeRef);
    } finally {
      database.close();
      await rm(assetRoot, { recursive: true, force: true });
    }
  });
});
