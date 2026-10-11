import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import sharp from 'sharp';
import type { T3Database } from '../database/connection.js';
import { getEntryDetail, updateEntry, type EntryRecord } from '../repositories/entry-repository.js';

export type EntryMediaKind = 'cover' | 'preview';

export const ENTRY_THUMBNAIL_MAX_DIMENSION = 512;
const sourceMediaPattern = /^(?:cover|preview(?:-\d+)?)(?:\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})?\.(avif|gif|jpg|png|webp)$/u;
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

/**
 * A picture's identity by content.
 *
 * Used for the thumbnail's file name, and by the import to recognize the cover arriving a second
 * time inside a site's own previews — the same bytes under a second address.
 */
export function mediaDigest(bytes: Uint8Array): string {
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
  const fileName = `${stem}.${mediaDigest(sourceBytes)}.webp`;
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
    const fileName = `${sourceStem(sourceFileName)}.${mediaDigest(bytes)}.webp`;
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
    await writeThumbnail(assetRoot, input.entryId, fileName, input.bytes);
    const temporary = join(directory, `.${fileName}.${randomUUID()}.tmp`);
    await writeFile(temporary, input.bytes);
    await rename(temporary, destination);
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

/** The Entry's whole media list in display order: the cover, then the previews. */
export function entryMediaRefs(entry: Pick<EntryRecord, 'coverRef' | 'previewRefs'>): string[] {
  return [
    ...(entry.coverRef === null ? [] : [entry.coverRef]),
    ...entry.previewRefs,
  ];
}

function mediaFileName(entryId: number, ref: string): string | null {
  const prefix = `/api/assets/entries/${entryId}/`;
  if (!ref.startsWith(prefix)) return null;
  const fileName = ref.slice(prefix.length);
  return sourceMediaPattern.test(fileName) ? fileName : null;
}

function namesForPosition(position: number, extension: string): string {
  if (position === 0) return `cover.${extension}`;
  // The upload path's own convention: the first preview has no number, the
  // second is `preview-2`, and so on — so the suffix is the position itself.
  return position === 1 ? `preview.${extension}` : `preview-${position}.${extension}`;
}

/**
 * Reorders, and/or deletes, an Entry's media so the stored list is exactly
 * `refs` — first one the cover.
 *
 * The files themselves are renamed to match their new position (`cover.*`,
 * `preview.*`, `preview-2.*`, …) and their thumbnails move with them, which is
 * what keeps a later read of any of them going through the same names. Every
 * surviving file is moved through a temporary name first, so a permutation
 * cannot overwrite a file that has not been moved yet.
 */
export async function applyEntryMediaOrder(
  database: T3Database,
  assetRoot: string,
  entryId: number,
  refs: string[],
): Promise<EntryRecord> {
  const entry = getEntryDetail(database, entryId);
  if (!entry) throw new Error('Entry not found');
  const directory = entryMediaDirectory(assetRoot, entryId);
  const current = new Set(entryMediaRefs(entry));
  const sources = refs.map((ref) => {
    const fileName = mediaFileName(entryId, ref);
    // Only media this Entry already holds may be re-ordered or removed here;
    // uploading is a different door with different preconditions.
    if (fileName === null || !current.has(ref)) throw new Error(`Entry media "${ref}" is unknown`);
    return fileName;
  });

  const staged: Array<{ temporary: string; target: string; thumbnailTemporary: string; thumbnailTarget: string }> = [];
  for (const [position, fileName] of sources.entries()) {
    const extension = extname(fileName).slice(1);
    const target = namesForPosition(position, extension);
    const stem = sourceStem(fileName);
    const bytes = await readFile(join(directory, fileName));
    const digest = mediaDigest(bytes);
    staged.push({
      temporary: join(directory, `.order.${randomUUID()}.tmp`),
      target: join(directory, target),
      thumbnailTemporary: join(thumbnailDirectory(assetRoot, entryId), `.order.${randomUUID()}.tmp`),
      thumbnailTarget: join(thumbnailDirectory(assetRoot, entryId), `${sourceStem(target)}.${digest}.webp`),
    });
    await rename(join(directory, fileName), staged[position]!.temporary);
    const thumbnail = join(thumbnailDirectory(assetRoot, entryId), `${stem}.${digest}.webp`);
    try {
      await access(thumbnail);
      await rename(thumbnail, staged[position]!.thumbnailTemporary);
    } catch {
      // No thumbnail yet: the read path renders one on demand.
    }
  }
  for (const step of staged) {
    await rename(step.temporary, step.target);
    try {
      await rename(step.thumbnailTemporary, step.thumbnailTarget);
    } catch {
      // Same as above: absent is allowed, and a missing temp is not an error.
    }
  }
  // Whatever the caller left out is gone from the Entry and from the disk,
  // thumbnails included.
  const kept = new Set(staged.map((step) => step.target));
  // An Entry that never had media has neither directory: nothing to delete is
  // not a failure, and the empty list is a legitimate desired state.
  const remainingFiles = await readdir(directory).catch(() => [] as string[]);
  for (const fileName of remainingFiles) {
    if (!sourceMediaPattern.test(fileName)) continue;
    if (!kept.has(join(directory, fileName))) await unlink(join(directory, fileName));
  }
  const thumbnails = thumbnailDirectory(assetRoot, entryId);
  const remainingThumbnails = await readdir(thumbnails).catch(() => [] as string[]);
  for (const fileName of remainingThumbnails) {
    if (!thumbnailMediaPattern.test(fileName)) continue;
    const target = join(thumbnails, fileName);
    if (!staged.some((step) => step.thumbnailTarget === target)) await unlink(target);
  }

  const storedRefs = refs.map((_, position) => {
    const fileName = staged[position]?.target.split(/[\\/]/u).pop() ?? '';
    return `/api/assets/entries/${entryId}/${fileName}`;
  });
  const previews = storedRefs.slice(1);
  return updateEntry(database, entryId, {
    coverRef: storedRefs[0] ?? null,
    previewRef: previews[0] ?? null,
    previewRefs: previews,
  });
}
