import type { T3Database } from '../database/connection.js';
import type { CommitSourceMaintenanceResponse } from '@t3/shared';
import { createLibraryBackup } from '../database/backup-restore.js';
import { createEntryContent } from '../repositories/entry-content-repository.js';
import {
  listAllEntrySources,
  listEntrySources,
  normalizeSourceUrl,
} from '../repositories/source-library-repository.js';
import {
  getItem,
  getRun,
  listItemEntries,
  setSourceStatus,
  updateRunStatus,
} from './repository.js';

/**
 * Commit service for Source maintenance (plan §16). Network search and the
 * formal write are strictly separated: a commit re-verifies every accepted
 * item against the live database, takes a real backup first, then appends
 * new `Source URL` Contents and the group invalid annotation in ONE SQLite
 * transaction. Old Content is never replaced, rewritten or deleted; any
 * stale snapshot, foreign URL or conflict aborts the whole batch with zero
 * writes.
 */

export class CommitStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitStaleError';
  }
}

export class CommitConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitConflictError';
  }
}

export interface CommitRunOptions {
  database: T3Database;
  /** Live database file path — the backup is taken from it before writing. */
  databasePath: string;
  dataDir?: string;
  runId: number;
  /** Test seam: invoked inside the transaction to force a rollback. */
  injectFailure?: () => void;
}

interface AcceptedItem {
  entryId: number;
  selectedUrl: string;
}

export async function commitSourceMaintenanceRun(
  options: CommitRunOptions,
): Promise<CommitSourceMaintenanceResponse> {
  const { database, runId } = options;
  const run = getRun(database, runId);
  if (run === null) throw new CommitStaleError(`run ${runId} does not exist`);
  if (run.status !== 'review') {
    throw new CommitConflictError(`run ${runId} is ${run.status}; only a finished review can commit`);
  }

  const items = listItemEntries(database, runId);
  const accepted: AcceptedItem[] = [];
  for (const entry of items) {
    if (entry.decision !== 'accept') continue;
    if (entry.selectedUrl === null) {
      throw new CommitConflictError(`accepted item ${entry.entryId} has no selected URL`);
    }
    accepted.push({ entryId: entry.entryId, selectedUrl: entry.selectedUrl });
  }

  // 1-3. Re-read every accepted Entry; stale title or origin snapshots abort.
  for (const item of accepted) {
    const stored = getItem(database, runId, item.entryId);
    if (stored === null) throw new CommitStaleError(`item ${item.entryId} disappeared from the run`);
    const row = database.prepare('SELECT title FROM entries WHERE id = ?')
      .pluck().get(item.entryId) as string | undefined;
    if (row === undefined) throw new CommitStaleError(`Entry ${item.entryId} no longer exists`);
    if (row !== stored.entryTitleSnapshot) {
      throw new CommitStaleError(`Entry ${item.entryId} title changed since the review started`);
    }
    const currentOriginUrls = listEntrySources(database, item.entryId)
      .filter((source) => source.sourceKey === run.originSourceKey)
      .map((source) => source.url);
    if (currentOriginUrls.join('\n') !== stored.originUrls.join('\n')) {
      throw new CommitStaleError(`Entry ${item.entryId} origin sources changed since the review started`);
    }
  }

  // 4-5. Normalize and pin every selected URL to the adapter target origin.
  const normalized = accepted.map((item) => {
    const url = normalizeSourceUrl(item.selectedUrl);
    if (url === null) {
      throw new CommitConflictError(`selected URL is not usable: ${item.selectedUrl}`);
    }
    if (run.targetOrigin !== '' && new URL(url).origin !== run.targetOrigin) {
      throw new CommitConflictError(`selected URL ${url} does not belong to the target origin ${run.targetOrigin}`);
    }
    return { entryId: item.entryId, url };
  });

  // 6. One URL must never be selected for two Entries in the same batch.
  const seen = new Map<string, number>();
  for (const item of normalized) {
    const other = seen.get(item.url);
    if (other !== undefined) {
      throw new CommitConflictError(`Entries ${other} and ${item.entryId} selected the same URL ${item.url}`);
    }
    seen.set(item.url, item.entryId);
  }

  // 7. Full-library ownership scan: same Entry → idempotent skip, other
  //    Entry → hard conflict with zero writes.
  const ownership = new Map<string, Set<number>>();
  for (const source of listAllEntrySources(database)) {
    const owners = ownership.get(source.url) ?? new Set<number>();
    owners.add(source.entryId);
    ownership.set(source.url, owners);
  }
  const toWrite: Array<{ entryId: number; url: string }> = [];
  let skippedCount = 0;
  for (const item of normalized) {
    const owners = ownership.get(item.url);
    if (owners === undefined) {
      toWrite.push(item);
      continue;
    }
    if (owners.has(item.entryId) && owners.size === 1) {
      skippedCount += 1;
      continue;
    }
    throw new CommitConflictError(`URL ${item.url} already belongs to another Entry`);
  }

  // 8. Backup before the transaction; a failed backup prevents all writes.
  let backupDir: string;
  try {
    const backup = await createLibraryBackup({
      databasePath: options.databasePath,
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    });
    backupDir = backup.backupDir;
  } catch (cause) {
    throw new Error(
      `commit aborted: backup failed (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }

  // 9. Single transaction: new Contents, optional group annotation, run state.
  const unresolvedCount = items.filter((item) => item.decision !== 'accept').length;
  database.transaction(() => {
    for (const item of toWrite) {
      const nextSortOrder = database.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) + 1
        FROM entry_contents
        WHERE entry_id = ?
      `).pluck().get(item.entryId) as number;
      createEntryContent(database, {
        entryId: item.entryId,
        contentType: 'Source URL',
        content: item.url,
        sortOrder: nextSortOrder,
      });
    }
    options.injectFailure?.();
    if (run.markOriginInvalid) {
      setSourceStatus(database, run.originSourceKey, 'invalid',
        'Origin replaced by a committed Source maintenance batch');
    }
    updateRunStatus(database, runId, 'committed');
  })();

  // 10. Source rows are a read-time projection; the new Contents are live
  // immediately. Counts describe exactly what the batch did.
  return {
    runId,
    status: 'committed',
    createdCount: toWrite.length,
    skippedCount,
    unresolvedCount,
    originMarkedInvalid: run.markOriginInvalid,
    backupDir,
  };
}
