import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { serve } from '@hono/node-server';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import {
  ensureEntryThumbnail, mediaDigest, readEntryMedia, readEntryThumbnail, resolveEntryThumbnail,
} from '../../src/import/media.js';
import { createEntry } from '../../src/repositories/entry-repository.js';

async function withAssets(run: (root: string, entryId: number, origin: string) => Promise<void>) {
  const database = createMigratedMemoryDatabase();
  const root = await mkdtemp(join(tmpdir(), 't3-upload-thumbnail-'));
  const app = createApiApp(database, { assetRoot: root });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    if (!server.listening) await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected random TCP port');
    const entry = createEntry(database, { title: 'Thumbnail fixture', type: 'comic' });
    await mkdir(join(root, 'entries', String(entry.id)), { recursive: true });
    await run(root, entry.id, `http://127.0.0.1:${address.port}`);
  } finally {
    try {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function assertGeneratedMedia(root: string, entryId: number, origin: string, fileName: string) {
  const bytes = await sharp({ create: {
    width: 640, height: 320, channels: 3, background: '#3183ef',
  } }).png().toBuffer();
  await writeFile(join(root, 'entries', String(entryId), fileName), bytes);
  const ref = await ensureEntryThumbnail(root, entryId, fileName);
  expect(ref).toBe(`/api/assets/entries/${entryId}/thumbnails/${fileName.slice(0, -4)}.${mediaDigest(bytes)}.webp`);
  expect(await resolveEntryThumbnail(root, entryId, fileName)).toBe(ref);
  const original = await fetch(`${origin}/api/assets/entries/${entryId}/${fileName}`);
  expect(original.status).toBe(200);
  expect(original.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
  const redirect = await fetch(`${origin}/api/thumbnails/entries/${entryId}/${fileName}`, { redirect: 'manual' });
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get('location')).toBe(ref);
  const response = await fetch(`${origin}${ref}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/webp');
  expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
  const thumbnail = Buffer.from(await response.arrayBuffer());
  expect(thumbnail).toEqual(await readEntryThumbnail(root, entryId, basename(ref)));
  const expected = await sharp(bytes, { animated: false }).rotate()
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80, effort: 4 }).toBuffer();
  expect(thumbnail).toEqual(expected);
  expect(await sharp(thumbnail).metadata()).toMatchObject({ format: 'webp', width: 512, height: 256 });
}

describe('uploaded Entry source and generated thumbnail HTTP contract', () => {
  it('serves UUID-qualified sources and their actual generated derivatives', async () => {
    await withAssets(async (root, entryId, origin) => {
      for (const stem of ['cover', 'preview', 'preview-2']) {
        await assertGeneratedMedia(root, entryId, origin, `${stem}.${randomUUID()}.png`);
      }
    });
  });

  it('continues serving legacy cover and preview derivatives', async () => {
    await withAssets(async (root, entryId, origin) => {
      for (const fileName of ['cover.png', 'preview.png', 'preview-2.png']) {
        await assertGeneratedMedia(root, entryId, origin, fileName);
      }
    });
  });

  it('rejects malformed UUIDs, digest syntax, arbitrary names and path escapes even when bytes exist', async () => {
    await withAssets(async (root, entryId, origin) => {
      const uuid = randomUUID();
      const badSources = [
        'preview.not-a-uuid.png', `preview.${uuid.slice(0, -1)}.png`,
        `preview.${uuid.replace(/-/gu, '')}.png`, `preview.${uuid.slice(0, -1)}g.png`,
        'arbitrary.png', 'preview.svg', 'preview.png.extra',
      ];
      const badThumbnails = [
        `preview.${uuid}.0123456789abcde.webp`, `preview.${uuid}.0123456789abcdef0.webp`,
        `preview.${uuid}.0123456789abcdeg.webp`, 'preview.not-a-uuid.0123456789abcdef.webp',
        'arbitrary.0123456789abcdef.webp', `preview.${uuid}.0123456789abcdef.png`,
      ];
      const directory = join(root, 'entries', String(entryId));
      await mkdir(join(directory, 'thumbnails'), { recursive: true });
      for (const name of badSources) {
        await writeFile(join(directory, name), 'must not serve');
        expect(await readEntryMedia(root, entryId, name)).toBeNull();
        expect(await resolveEntryThumbnail(root, entryId, name)).toBeNull();
        await expect(ensureEntryThumbnail(root, entryId, name)).rejects.toThrow('Invalid Entry media file name');
        expect((await fetch(`${origin}/api/assets/entries/${entryId}/${encodeURIComponent(name)}`)).status).toBe(404);
      }
      for (const name of badThumbnails) {
        await writeFile(join(directory, 'thumbnails', name), 'must not serve');
        expect(await readEntryThumbnail(root, entryId, name)).toBeNull();
        expect((await fetch(`${origin}/api/assets/entries/${entryId}/thumbnails/${encodeURIComponent(name)}`)).status).toBe(404);
      }
      // Existing valid bytes outside the selected source/thumbnail directory must remain inaccessible.
      await writeFile(join(root, 'secret.png'), 'outside entry');
      await writeFile(join(directory, 'preview.png'), 'outside thumbnails');
      for (const name of ['../../secret.png', '..\\..\\secret.png', '/secret.png', 'nested/preview.png']) {
        expect(await readEntryMedia(root, entryId, name)).toBeNull();
        expect(await resolveEntryThumbnail(root, entryId, name)).toBeNull();
        expect((await fetch(`${origin}/api/assets/entries/${entryId}/${encodeURIComponent(name)}`)).status).toBe(404);
      }
      for (const name of ['../preview.png', '..\\preview.png', '/preview.png', 'nested/preview.0123456789abcdef.webp']) {
        expect(await readEntryThumbnail(root, entryId, name)).toBeNull();
        expect((await fetch(`${origin}/api/assets/entries/${entryId}/thumbnails/${encodeURIComponent(name)}`)).status).toBe(404);
      }
    });
  });
});
