import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureEntryThumbnail, resolveEntryThumbnail } from './media.js';

const sourceMediaPattern = /^(?:cover|preview(?:-\d+)?)\.(?:avif|gif|jpg|png|webp)$/u;

export interface ThumbnailBackfillError {
  entryId: number;
  fileName: string;
  message: string;
}

export interface ThumbnailBackfillProgress {
  entryId: number;
  fileName: string;
  status: 'generated' | 'skipped' | 'failed';
  scanned: number;
}

export interface ThumbnailBackfillResult {
  scanned: number;
  generated: number;
  skipped: number;
  failed: number;
  interrupted: boolean;
  errors: ThumbnailBackfillError[];
}

export async function backfillEntryThumbnails(
  assetRoot: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: ThumbnailBackfillProgress) => void;
  } = {},
): Promise<ThumbnailBackfillResult> {
  const result: ThumbnailBackfillResult = {
    scanned: 0,
    generated: 0,
    skipped: 0,
    failed: 0,
    interrupted: false,
    errors: [],
  };
  let entryDirectories;
  try {
    entryDirectories = await readdir(join(assetRoot, 'entries'), { withFileTypes: true });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return result;
    }
    throw error;
  }
  entryDirectories.sort((left, right) => Number(left.name) - Number(right.name));

  for (const entryDirectory of entryDirectories) {
    const entryId = Number(entryDirectory.name);
    if (!entryDirectory.isDirectory() || !Number.isSafeInteger(entryId) || entryId <= 0) continue;
    const files = (await readdir(join(assetRoot, 'entries', entryDirectory.name)))
      .filter((fileName) => sourceMediaPattern.test(fileName))
      .sort();
    for (const fileName of files) {
      if (options.signal?.aborted) {
        result.interrupted = true;
        return result;
      }
      result.scanned += 1;
      try {
        if (await resolveEntryThumbnail(assetRoot, entryId, fileName)) {
          result.skipped += 1;
          options.onProgress?.({ entryId, fileName, status: 'skipped', scanned: result.scanned });
          continue;
        }
        await ensureEntryThumbnail(assetRoot, entryId, fileName);
        result.generated += 1;
        options.onProgress?.({ entryId, fileName, status: 'generated', scanned: result.scanned });
      } catch (error) {
        result.failed += 1;
        result.errors.push({
          entryId,
          fileName,
          message: error instanceof Error ? error.message : String(error),
        });
        options.onProgress?.({ entryId, fileName, status: 'failed', scanned: result.scanned });
      }
    }
  }
  return result;
}
