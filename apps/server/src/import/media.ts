import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { T3Database } from '../database/connection.js';
import { getEntryDetail, updateEntry, type EntryRecord } from '../repositories/entry-repository.js';

export type EntryMediaKind = 'cover' | 'preview';

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
  const match = /^(?:cover|preview(?:-\d+)?)\.(avif|gif|jpg|png|webp)$/u.exec(fileName);
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
