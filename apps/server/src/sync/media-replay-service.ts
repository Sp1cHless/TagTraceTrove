import { createHash, randomUUID } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import {
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  syncMediaUploadResultSchema,
  type SyncMediaUploadMetadata,
  type SyncMediaUploadResult,
} from '@t3/shared';
import type { T3Database } from '../database/connection.js';
import { updateEntry } from '../repositories/entry-repository.js';
import { getSyncIdentity } from './sync-service.js';

const extensionByMimeType: Record<SyncMediaUploadMetadata['mimeType'], string> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const mimeTypeBySharpFormat: Record<string, SyncMediaUploadMetadata['mimeType'] | undefined> = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
const MAX_DIMENSION = 20_000;
const MAX_PIXELS = 100_000_000;
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STAGED_SOURCE = /^\.(?:cover|preview(?:-[1-9][0-9]*)?)\.(?:avif|gif|jpg|png|webp)\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/i;
const STAGED_THUMBNAIL = /^\.(?:cover|preview(?:-[1-9][0-9]*)?)\.[0-9a-f]{16}\.webp\.[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.tmp$/i;

/** Remove abandoned pre-commit files, never authoritative media or arbitrary paths.
 * Run once before accepting uploads, so an active writer is never mistaken for debris. */
export async function cleanupAbandonedSyncMediaStaging(
  assetRoot: string,
  options: { now?: number; maxAgeMs?: number } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? STAGING_MAX_AGE_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error('Invalid staging retention');
  const entriesRoot = join(assetRoot, 'entries');
  let entries;
  try {
    entries = await readdir(entriesRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) continue;
    for (const [directory, pattern] of [
      [join(entriesRoot, entry.name), STAGED_SOURCE],
      [join(entriesRoot, entry.name, 'thumbnails'), STAGED_THUMBNAIL],
    ] as const) {
      let files;
      try {
        files = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const file of files) {
        if (!file.isFile() || !pattern.test(file.name)) continue;
        const path = join(directory, file.name);
        try {
          if (now - (await stat(path)).mtimeMs <= maxAgeMs) continue;
          await rm(path);
          removed += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  }
  return removed;
}


interface ReceiptRow {
  requestHash: string;
  resultJson: string;
}

interface EntryRow {
  id: number;
  coverRef: string | null;
  previewRefs: string | null;
}

export class SyncMediaUploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly code: 'invalid-media' | 'entry-not-found' | 'upload-id-collision'
      | 'media-slot-occupied' | 'identity-mismatch' | 'entry-not-staged-create' | 'media-state-conflict',
  ) {
    super(message);
  }
}

function canonicalRequestHash(metadata: SyncMediaUploadMetadata): string {
  return createHash('sha256').update(JSON.stringify({
    byteLength: metadata.byteLength,
    entryUid: metadata.entryUid,
    kind: metadata.kind,
    libraryId: metadata.libraryId,
    mimeType: metadata.mimeType,
    ordinal: metadata.ordinal,
    sha256: metadata.sha256,
    syncEpoch: metadata.syncEpoch,
    ...(metadata.existingEntry === undefined ? {} : { existingEntry: {
      expectedCoverRef: metadata.existingEntry.expectedCoverRef,
      expectedPreviewRefs: metadata.existingEntry.expectedPreviewRefs,
    } }),
  })).digest('hex');
}

function maxServerSeq(database: T3Database): number {
  return Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());
}

function parsePreviewRefs(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

async function validateAndRenderThumbnail(
  metadata: SyncMediaUploadMetadata,
  bytes: Uint8Array,
): Promise<Buffer> {
  if (bytes.byteLength !== metadata.byteLength) {
    throw new SyncMediaUploadError('Media byte length does not match metadata', 400, 'invalid-media');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== metadata.sha256) {
    throw new SyncMediaUploadError('Media SHA-256 does not match metadata', 400, 'invalid-media');
  }
  let imageMetadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    imageMetadata = await sharp(bytes, { animated: false }).metadata();
  } catch {
    throw new SyncMediaUploadError('Media bytes are not a supported image', 400, 'invalid-media');
  }
  const detectedMime = imageMetadata.format === undefined
    ? undefined
    : mimeTypeBySharpFormat[imageMetadata.format];
  if (detectedMime !== metadata.mimeType) {
    throw new SyncMediaUploadError('Media MIME type does not match its bytes', 400, 'invalid-media');
  }
  const width = imageMetadata.width ?? 0;
  const height = imageMetadata.height ?? 0;
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new SyncMediaUploadError('Media dimensions are outside the supported range', 400, 'invalid-media');
  }
  try {
    return await sharp(bytes, { animated: false })
      .rotate()
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80, effort: 4 })
      .toBuffer();
  } catch {
    // Reading the header can succeed on bytes the decoder then refuses (a
    // malformed PNG: libspng rejects it after sharp already reported 16x16).
    // An unhandled throw here reached the client as a transient failure, so a
    // payload the server can never accept was retried on every probe forever;
    // as a client error it becomes a visible failed upload the person can
    // discard.
    throw new SyncMediaUploadError('Media bytes are not a supported image', 400, 'invalid-media');
  }
}

/**
 * Replay staged media without replacing occupied slots. Cover uses ordinal 0;
 * previews append in exact ordinal order so a lost response can retry its
 * upload ID without overwriting a later image.
 */
export async function replaySyncMediaUpload(
  database: T3Database,
  assetRoot: string,
  uploadId: string,
  metadata: SyncMediaUploadMetadata,
  bytes: Uint8Array,
  options: { stageWrite?: (filename: string, bytes: Uint8Array) => Promise<void> } = {},
): Promise<SyncMediaUploadResult> {
  if (metadata.kind === 'cover' && metadata.ordinal !== 0) {
    throw new SyncMediaUploadError('Cover media must use ordinal zero', 400, 'invalid-media');
  }
  const identity = getSyncIdentity(database);
  if (metadata.libraryId !== identity.libraryId || metadata.syncEpoch !== identity.syncEpoch) {
    throw new SyncMediaUploadError(
      'Offline media belongs to a different library state; update the offline copy',
      409,
      'identity-mismatch',
    );
  }
  const requestHash = canonicalRequestHash(metadata);
  const existingReceipt = database.prepare(`
    SELECT request_hash AS requestHash, result_json AS resultJson
    FROM sync_media_upload_receipts WHERE upload_id = ?
  `).get(uploadId) as ReceiptRow | undefined;
  if (existingReceipt !== undefined) {
    if (existingReceipt.requestHash !== requestHash) {
      throw new SyncMediaUploadError(
        'Upload ID was already used for different content',
        409,
        'upload-id-collision',
      );
    }
    return syncMediaUploadResultSchema.parse(JSON.parse(existingReceipt.resultJson));
  }

  const stagedCreate = database.prepare(`
    SELECT 1 FROM sync_offline_created_entries WHERE entry_uid = ?
  `).get(metadata.entryUid);
  if (!stagedCreate && metadata.existingEntry === undefined) {
    throw new SyncMediaUploadError(
      'Offline media is only available for Entries created by offline replay',
      409,
      'entry-not-staged-create',
    );
  }

  const thumbnail = await validateAndRenderThumbnail(metadata, bytes);
  const entryBefore = database.prepare(`
    SELECT id, cover_ref AS coverRef, preview_refs AS previewRefs
    FROM entries WHERE sync_uid = ?
  `).get(metadata.entryUid) as EntryRow | undefined;
  if (entryBefore === undefined) {
    throw new SyncMediaUploadError('Entry sync identity does not exist', 404, 'entry-not-found');
  }
  const extension = extensionByMimeType[metadata.mimeType];
  const mediaName = metadata.kind === 'cover' ? 'cover'
    : metadata.ordinal === 0 ? 'preview' : `preview-${metadata.ordinal + 1}`;
  // Existing targets never reuse names of previously referenced assets.
  const sourceName = metadata.existingEntry === undefined
    ? `${mediaName}.${extension}` : `${mediaName}.${uploadId}.${extension}`;
  const digestPrefix = metadata.sha256.slice(0, 16);
  const thumbnailName = metadata.existingEntry === undefined
    ? `${mediaName}.${digestPrefix}.webp` : `${mediaName}.${uploadId}.${digestPrefix}.webp`;
  const directory = join(assetRoot, 'entries', String(entryBefore.id));
  const thumbnailDirectory = join(directory, 'thumbnails');
  await mkdir(thumbnailDirectory, { recursive: true });
  const token = randomUUID();
  const sourceTemporary = join(directory, `.${sourceName}.${token}.tmp`);
  const thumbnailTemporary = join(thumbnailDirectory, `.${thumbnailName}.${token}.tmp`);
  const sourceDestination = join(directory, sourceName);
  const thumbnailDestination = join(thumbnailDirectory, thumbnailName);
  let sourcePromoted = false;
  let thumbnailPromoted = false;

  try {
    const stageWrite = options.stageWrite ?? writeFile;
    await stageWrite(sourceTemporary, bytes);
    await stageWrite(thumbnailTemporary, thumbnail);
    const apply = database.transaction((): SyncMediaUploadResult => {
      const receipt = database.prepare(`
        SELECT request_hash AS requestHash, result_json AS resultJson
        FROM sync_media_upload_receipts WHERE upload_id = ?
      `).get(uploadId) as ReceiptRow | undefined;
      if (receipt !== undefined) {
        if (receipt.requestHash !== requestHash) {
          throw new SyncMediaUploadError(
            'Upload ID was already used for different content',
            409,
            'upload-id-collision',
          );
        }
        return syncMediaUploadResultSchema.parse(JSON.parse(receipt.resultJson));
      }
      const currentIdentity = getSyncIdentity(database);
      if (currentIdentity.libraryId !== metadata.libraryId || currentIdentity.syncEpoch !== metadata.syncEpoch) {
        throw new SyncMediaUploadError(
          'Library state changed while preparing media; update the offline copy', 409, 'identity-mismatch');
      }
      const entry = database.prepare(`
        SELECT id, cover_ref AS coverRef, preview_refs AS previewRefs
        FROM entries WHERE sync_uid = ?
      `).get(metadata.entryUid) as EntryRow | undefined;
      if (entry === undefined) {
        throw new SyncMediaUploadError('Entry sync identity does not exist', 404, 'entry-not-found');
      }
      if (entry.id !== entryBefore.id) {
        throw new SyncMediaUploadError('Entry owner changed while preparing media', 409, 'media-state-conflict');
      }
      const existingPreviews = parsePreviewRefs(entry.previewRefs);
      const expected = metadata.existingEntry;
      if (expected !== undefined && (entry.coverRef !== expected.expectedCoverRef
        || JSON.stringify(existingPreviews) !== JSON.stringify(expected.expectedPreviewRefs))) {
        throw new SyncMediaUploadError('Entry media changed; review the queued image in the foreground',
          409, 'media-state-conflict');
      }
      const relativeRef = `/api/assets/entries/${entry.id}/${sourceName}`;
      // A declared cover replacement swaps the frozen occupied slot: the
      // expected-state check above already bound it to the reviewed revision.
      const replacingCover = metadata.kind === 'cover' && metadata.replace === true
        && metadata.existingEntry?.expectedCoverRef != null
        && entry.coverRef === metadata.existingEntry.expectedCoverRef;
      if (!replacingCover && ((metadata.kind === 'cover' && entry.coverRef !== null)
        || (metadata.kind === 'preview' && (metadata.ordinal !== existingPreviews.length
          || existingPreviews.includes(relativeRef) || entry.coverRef === relativeRef)))) {
        throw new SyncMediaUploadError(
          'Offline media upload cannot replace or skip an existing media slot',
          409,
          'media-slot-occupied',
        );
      }
      // rename() is atomic on the same volume. A hard crash can leave these
      // deterministic files behind before the SQLite receipt commits. Because
      // the authoritative slot is still empty, exact retry may replace that
      // unreferenced debris safely.
      rmSync(sourceDestination, { force: true });
      rmSync(thumbnailDestination, { force: true });
      renameSync(sourceTemporary, sourceDestination);
      sourcePromoted = true;
      renameSync(thumbnailTemporary, thumbnailDestination);
      thumbnailPromoted = true;
      updateEntry(database, entry.id, metadata.kind === 'cover'
        ? { coverRef: relativeRef }
        : { previewRef: existingPreviews[0] ?? relativeRef,
          previewRefs: [...existingPreviews, relativeRef] });
      const resourceVersion = Number(database.prepare(
        'SELECT sync_version FROM entries WHERE id = ?',
      ).pluck().get(entry.id));
      const result = syncMediaUploadResultSchema.parse({
        uploadId,
        status: 'applied',
        entityId: entry.id,
        relativeRef,
        resourceVersion,
        serverSeq: maxServerSeq(database),
      });
      database.prepare(`
        INSERT INTO sync_media_upload_receipts (upload_id, request_hash, result_json, server_seq)
        VALUES (?, ?, ?, ?)
      `).run(uploadId, requestHash, JSON.stringify(result), result.serverSeq);
      return result;
    });
    return apply();
  } catch (error) {
    if (sourcePromoted) await rm(sourceDestination, { force: true });
    if (thumbnailPromoted) await rm(thumbnailDestination, { force: true });
    throw error;
  } finally {
    await rm(sourceTemporary, { force: true });
    await rm(thumbnailTemporary, { force: true });
  }
}
