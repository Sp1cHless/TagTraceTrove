import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import sharp from 'sharp';
import type { T3Database } from '../database/connection.js';
import { getEntryDetail, updateEntry, type EntryRecord } from '../repositories/entry-repository.js';

export type EntryMediaKind = 'cover' | 'preview';

export const ENTRY_THUMBNAIL_MAX_DIMENSION = 512;
const sourceMediaPattern = /^(?:cover|preview(?:-\d+)?)\.(avif|gif|jpg|png|webp)$/u;
const thumbnailMediaPattern = /^(?:cover|preview(?:-\d+)?)\.[a-f0-9]{16}\.webp$/u;
const extensionByMimeType: Record<string, string> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const mimeTypeByExtension: Record<string, string> = Object.fromEntries(
  Object.entries(extensionByMimeType).map(([mimeType, extension]) => [extension, mimeType]),
);

export interface StoredEntryMedia {
  entry: EntryRecord;
  relativeRef: string;
}

function entryMediaDirectory(assetRoot: string, entryId: number): string {
  return join(assetRoot, 'entries', String(entryId));
}

function thumbnailDirectory(assetRoot: string, entryId: number): string {
  return join(entryMediaDirectory(assetRoot, entryId), 'thumbnails');
}

function sourceStem(fileName: string): string {
  return fileName.slice(0, -extname(fileName).length);
}

function sourceDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

async function renderThumbnail(bytes: Uint8Array): Promise<Buffer> {
  return sharp(bytes, { animated: false })
    .rotate()
    .resize({
      width: ENTRY_THUMBNAIL_MAX_DIMENSION,
      height: ENTRY_THUMBNAIL_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 80, effort: 4 })
    .toBuffer();
}

async function writeThumbnail(
  assetRoot: string,
  entryId: number,
  sourceFileName: string,
  sourceBytes: Uint8Array,
): Promise<string> {
  if (!sourceMediaPattern.test(sourceFileName)) throw new Error('Invalid Entry media file name');
  const directory = thumbnailDirectory(assetRoot, entryId);
  await mkdir(directory, { recursive: true });
  const stem = sourceStem(sourceFileName);
  const fileName = `${stem}.${sourceDigest(sourceBytes)}.webp`;
  const destination = join(directory, fileName);
  try {
    await access(destination);
  } catch {
    const temporary = join(directory, `.${fileName}.${randomUUID()}.tmp`);
    await writeFile(temporary, await renderThumbnail(sourceBytes));
    await rename(temporary, destination);
  }
  for (const existing of await readdir(directory)) {
    if (existing.startsWith(`${stem}.`) && existing !== fileName) {
      await unlink(join(directory, existing));
    }
  }
  return `/api/assets/entries/${entryId}/thumbnails/${fileName}`;
}

export async function ensureEntryThumbnail(
  assetRoot: string,
  entryId: number,
  sourceFileName: string,
): Promise<string> {
  if (!sourceMediaPattern.test(sourceFileName)) throw new Error('Invalid Entry media file name');
  const bytes = await readFile(join(entryMediaDirectory(assetRoot, entryId), sourceFileName));
  return writeThumbnail(assetRoot, entryId, sourceFileName, bytes);
}

export async function resolveEntryThumbnail(
  assetRoot: string,
  entryId: number,
  sourceFileName: string,
): Promise<string | null> {
  if (!sourceMediaPattern.test(sourceFileName)) return null;
  try {
    const bytes = await readFile(join(entryMediaDirectory(assetRoot, entryId), sourceFileName));
    const fileName = `${sourceStem(sourceFileName)}.${sourceDigest(bytes)}.webp`;
    await access(join(thumbnailDirectory(assetRoot, entryId), fileName));
    return `/api/assets/entries/${entryId}/thumbnails/${fileName}`;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function readEntryThumbnail(
  assetRoot: string,
  entryId: number,
  fileName: string,
): Promise<Uint8Array | null> {
  if (!thumbnailMediaPattern.test(fileName)) return null;
  try {
    return await readFile(join(thumbnailDirectory(assetRoot, entryId), fileName));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function storeEntryMedia(
  database: T3Database,
  assetRoot: string,
  input: {
    entryId: number;
    kind: EntryMediaKind;
    mimeType: string;
    bytes: Uint8Array;
  },
): Promise<StoredEntryMedia> {
  if (!getEntryDetail(database, input.entryId)) {
    throw new Error('Entry not found');
  }
  const extension = extensionByMimeType[input.mimeType];
  if (!extension) {
    throw new Error('Entry media must be a PNG, JPEG, WebP, GIF, or AVIF image');
  }
  const directory = entryMediaDirectory(assetRoot, input.entryId);
  await mkdir(directory, { recursive: true });

  if (input.kind === 'cover') {
    const fileName = `cover.${extension}`;
    const destination = join(directory, fileName);
    const temporary = join(directory, `.${fileName}.${randomUUID()}.tmp`);
    await writeFile(temporary, input.bytes);
    await rename(temporary, destination);
    await writeThumbnail(assetRoot, input.entryId, fileName, input.bytes);
    for (const existing of await readdir(directory)) {
      if (existing.startsWith('cover.') && existing !== fileName) {
        await unlink(join(directory, existing));
      }
    }
    const relativeRef = `/api/assets/entries/${input.entryId}/${fileName}`;
    const entry = updateEntry(database, input.entryId, { coverRef: relativeRef });
    return { entry, relativeRef };
  }

  const existingRefs = getEntryDetail(database, input.entryId)?.previewRefs ?? [];
  const ordinal = existingRefs.length;
  const fileName = `preview${ordinal === 0 ? '' : `-${ordinal + 1}`}.${extension}`;
  const destination = join(directory, fileName);
  const temporary = join(directory, `.${fileName}.${randomUUID()}.tmp`);
  await writeFile(temporary, input.bytes);
  await rename(temporary, destination);
  await writeThumbnail(assetRoot, input.entryId, fileName, input.bytes);
  const relativeRef = `/api/assets/entries/${input.entryId}/${fileName}`;
  const previewRefs = [...existingRefs, relativeRef];
  const entry = updateEntry(database, input.entryId, {
    previewRef: previewRefs[0],
    previewRefs,
  });
  return { entry, relativeRef };
}

export async function readEntryMedia(
  assetRoot: string,
  entryId: number,
  fileName: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const match = sourceMediaPattern.exec(fileName);
  if (!match?.[1]) return null;
  try {
    return {
      bytes: await readFile(join(entryMediaDirectory(assetRoot, entryId), fileName)),
      mimeType: mimeTypeByExtension[match[1]] ?? 'application/octet-stream',
    };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function deleteEntryMedia(assetRoot: string, entryId: number): Promise<void> {
  await rm(entryMediaDirectory(assetRoot, entryId), { recursive: true, force: true });
}
