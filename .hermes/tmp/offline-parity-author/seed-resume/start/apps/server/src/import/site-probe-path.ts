import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { ImportBatch, ImportCommitMapping, ImportCommitResult } from '@t3/shared';
import { importCommitResultSchema } from '@t3/shared';

import { createImportPreview, type ImportPreview } from './preview.js';
import { commitImportBatch } from './commit.js';
import { loadSiteProbeExport } from './site-probe.js';
import {
  mediaDigest,
  storeEntryMedia,
  type EntryMediaKind,
} from './media.js';
import { getEntryDetail } from '../repositories/entry-repository.js';
import type { T3Database } from '../database/connection.js';

/**
 * The other half of the import: an export the **server** can already reach.
 *
 * The upload path exists because a browser holds the files and the server cannot see them. When T³
 * itself started the crawl, that is inverted — the export is on this machine, in the tool's own
 * tree — and round-tripping it through the browser would mean reading every cover into a
 * `File` object only to upload it back. So this reads the document in place, and the media too.
 *
 * Two guards, because a path from a client is untrusted input:
 *
 * * the path must be **absolute** (a relative one would silently resolve against the server's
 *   working directory) and must live **inside** `<home>/export/`, which is the only tree a crawl
 *   writes. The check is on the resolved path (`..` segments included), not the string;
 * * media is only stored for entries the commit actually created or matched, and every file that
 *   cannot be read is named in the result — an import once claimed covers for 53 records while 20
 *   of the files were not on disk, and the export looked complete.
 */
export interface SiteProbePathPreview extends ImportPreview {
  batch: ImportBatch;
}

export function resolveInsideExportRoot(exportRoot: string, candidate: string): string {
  if (!isAbsolute(candidate)) {
    throw new Error('Export path must be absolute');
  }
  const resolved = resolve(candidate);
  const root = resolve(exportRoot);
  const inside = relative(root, resolved);
  if (inside.startsWith('..') || isAbsolute(inside) || inside === '') {
    throw new Error(`Export path is outside the SiteProbe export root: ${candidate}`);
  }
  return resolved;
}

/** Resolve an existing export path through symlinks, then re-check containment on its real path. */
export async function resolveExistingInsideExportRoot(
  exportRoot: string,
  candidate: string,
): Promise<string> {
  const lexicalPath = resolveInsideExportRoot(exportRoot, candidate);
  try {
    const [realRoot, realCandidate] = await Promise.all([
      realpath(exportRoot),
      realpath(lexicalPath),
    ]);
    return resolveInsideExportRoot(realRoot, realCandidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Keep the old NOT_FOUND behavior for missing files/roots; no bytes are read on this path.
    if (code === 'ENOENT' || code === 'ENOTDIR') return lexicalPath;
    throw error;
  }
}

/** Read one export file through an open handle, rechecking path containment and file identity. */
export async function readInsideExportRoot(
  exportRoot: string,
  candidate: string,
): Promise<Buffer> {
  const realRoot = await realpath(exportRoot);
  const safePath = await resolveExistingInsideExportRoot(exportRoot, candidate);
  const handle = await open(safePath, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`Export path is not a file: ${safePath}`);
    const currentPath = resolveInsideExportRoot(realRoot, await realpath(safePath));
    const current = await stat(currentPath);
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error('Export path changed while being read');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function previewSiteProbeExportPath(
  exportRoot: string,
  metadataPath: string,
): Promise<SiteProbePathPreview> {
  const resolved = await resolveExistingInsideExportRoot(exportRoot, metadataPath);
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`Metadata file not found: ${metadataPath}`);
    }
    throw error;
  }
  if (!info.isFile()) {
    throw new Error(`Export metadata is not a file: ${resolved}`);
  }
  // Every manifest/sidecar read is routed through the same real-path and open-handle guard.
  const batch = await loadSiteProbeExport(resolved, {
    preserveRelativeMediaPaths: false,
    readExportFile: (path) => readInsideExportRoot(exportRoot, path),
  });
  return { batch, ...createImportPreview(batch) };
}

export interface MediaIngestResult {
  stored: number;
  warnings: string[];
}

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  // The export tree is not only media: a listing holds the review page a person opens and the
  // selection it saves, and those are served from the same route.
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** The content type of a file the tool wrote, by extension — the export tree holds images too. */
export function mimeTypeOf(path: string): string {
  const lower = path.toLowerCase();
  const extension = lower.slice(lower.lastIndexOf('.'));
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

/**
 * Commit a batch and store the media its entries point at, read from disk.
 *
 * Only paths inside the export root are read, and the mapping from a stored entry back to the batch
 * entry is by `externalKey` (falling back to batch order, which is how the commit walks them).
 */
export async function commitSiteProbeExportPath(
  database: T3Database,
  assetRoot: string | undefined,
  exportRoot: string,
  input: { batch: ImportBatch; mapping: ImportCommitMapping },
): Promise<ImportCommitResult> {
  const result = commitImportBatch(database, input.batch, input.mapping);
  if (!assetRoot) {
    return result;
  }

  const byKey = new Map<string, ImportBatch['entries'][number]>();
  input.batch.entries.forEach((entry) => {
    if (entry.externalKey) byKey.set(entry.externalKey, entry);
  });

  // **Every** work the batch names, paired with the Entry it belongs to: the created ones from
  // `entries`, the already-known ones from `skippedExisting`. Reaching only the created ones is what
  // made an interrupted commit permanent — a work whose pictures never landed is skipped by every
  // later import of the same export, so it was never asked for them again. Measured: after cutting a
  // commit between its halves, the work had `coverRef: (none)` and `previewRefs: 0`, and importing the
  // same export reported `created: 0, skippedExisting: 1, mediaStoredCount: 0`.
  const paired = [
    ...result.entries.map((entry) => ({ entry, repair: false as const })),
    ...result.skippedExisting.map((entry) => ({ entry, repair: true as const })),
  ];

  const warnings: string[] = [];
  let stored = 0;
  let duplicates = 0;
  let repaired = 0;
  for (const { entry: committed, repair } of paired) {
    // A batch work with no external key names no export item, so there is nothing to read for it —
    // the same answer this half has always given, now said out loud.
    const item = committed.externalKey ? byKey.get(committed.externalKey) : undefined;
    if (!item) continue;
    const outcome = await storeExportMedia(database, assetRoot, exportRoot, committed.entryId,
                                           item, committed.title, repair);
    stored += outcome.stored;
    duplicates += outcome.duplicates;
    repaired += outcome.repaired;
    warnings.push(...outcome.warnings);
  }

  return importCommitResultSchema.parse({
    ...result,
    mediaStoredCount: stored,
    mediaDuplicateCount: duplicates,
    mediaRepairedCount: repaired,
    mediaWarnings: warnings,
  });
}

/**
 * The export's pictures for one Entry: the cover, then every preview in the export's own order.
 *
 * Split out of the commit loop because the two halves of a commit can disagree — the transaction is
 * atomic, the files are not — so this runs twice for one work in the worst case: once when the work
 * is created, and once when a later import of the same export finds it already there. The two differ
 * only in where they start:
 *
 * * a work being imported for the first time has no pictures, so everything is written;
 * * an already-known work may have some, and the repair continues from where the interrupted write
 *   stopped. It counts **slots**, not pictures: the export's own order is the sequence, a complete
 *   write fills it left to right, so what is stored is a prefix of it and `previewRefs.length` says
 *   how far it got.
 *
 * Counting is not interchangeable with comparing bytes, and the existing test says why: a work whose
 * two previews are byte-for-byte identical is a legitimate export, and "this picture is already
 * stored" would call the second one a duplicate and drop it. So the position decides, and the only
 * content comparison left is the one that was always there — a cover arriving again inside the
 * previews container, which is the cover rather than a second layer of the stack.
 *
 * A cover that is present is the person's: the editor lets them choose one, and a re-import must not
 * undo that. Only an empty cover is filled.
 */
async function storeExportMedia(
  database: T3Database,
  assetRoot: string,
  exportRoot: string,
  entryId: number,
  item: ImportBatch['entries'][number],
  title: string,
  repair: boolean,
): Promise<{ stored: number; duplicates: number; repaired: number; warnings: string[] }> {
  const warnings: string[] = [];
  const wanted: Array<{ kind: EntryMediaKind; path: string }> = [];
  if (item.cover) wanted.push({ kind: 'cover', path: item.cover });
  for (const path of previewPathsOf(item)) {
    wanted.push({ kind: 'preview', path });
  }

  // Read every picture before writing any of them: the repair needs the whole sequence to know which
  // slots a complete write would have filled, and a picture that cannot be read is a warning rather
  // than a hole in the middle of that sequence.
  const slots: Array<{ kind: EntryMediaKind; resolved: string; bytes: Uint8Array; digest: string }> = [];
  let duplicates = 0;
  let coverDigest: string | null = null;
  for (const { kind, path } of wanted) {
    if (!isAbsolute(path)) continue;
    let resolved: string;
    try {
      resolved = await resolveExistingInsideExportRoot(exportRoot, path);
    } catch {
      warnings.push(`${title}: ${kind} is outside the export root and was not stored`);
      continue;
    }
    try {
      const bytes = await readInsideExportRoot(exportRoot, resolved);
      const digest = mediaDigest(bytes);
      if (kind === 'cover') {
        coverDigest = digest;
      } else if (coverDigest !== null && digest === coverDigest) {
        // Some sites publish the cover inside the very container the previews come from, so the first
        // preview is byte-for-byte the cover. Storing it twice shows the same picture on two layers of
        // the stack, and the Entry already has it as the cover.
        duplicates += 1;
        continue;
      }
      slots.push({ kind, resolved, bytes, digest });
    } catch (error) {
      warnings.push(`${title}: ${kind} could not be stored (${(error as Error).message})`);
    }
  }

  const detail = repair ? getEntryDetail(database, entryId) : null;
  const hasCover = (detail?.coverRef ?? null) !== null;
  const filled = detail?.previewRefs.length ?? 0;

  let stored = 0;
  let repaired = 0;
  let previews = 0;
  for (const slot of slots) {
    if (slot.kind === 'cover') {
      // The cover the work already has is the person's.
      if (repair && hasCover) continue;
    } else {
      // The sequence is filled left to right, so a preview whose slot is already occupied is there.
      const index = previews;
      previews += 1;
      if (repair && index < filled) continue;
    }
    try {
      await storeEntryMedia(database, assetRoot, {
        entryId,
        kind: slot.kind,
        mimeType: mimeTypeOf(slot.resolved),
        bytes: slot.bytes,
      });
      stored += 1;
      if (repair) repaired += 1;
    } catch (error) {
      warnings.push(`${title}: ${slot.kind} could not be stored (${(error as Error).message})`);
    }
  }
  return { stored, duplicates, repaired, warnings };
}


/**
 * The preview paths of a batch entry, in order.
 *
 * `previews` is the whole set the export recorded; `preview` is the first of them, kept for the
 * batches that only ever carried one.
 */
function previewPathsOf(entry: ImportBatch['entries'][number]): string[] {
  if (entry.previews && entry.previews.length > 0) return entry.previews;
  return entry.preview ? [entry.preview] : [];
}
