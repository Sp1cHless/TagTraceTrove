import { createHash } from 'node:crypto';
import {
  syncReplayResultSchema,
  type SyncReplayOperation,
  type SyncReplayResult,
} from '@t3/shared';
import type { T3Database } from '../database/connection.js';
import { createEntry, updateEntry, type UpdateEntryInput } from '../repositories/entry-repository.js';
import { setEntryRating } from '../repositories/rating-repository.js';
import { addViewLaterEntry, removeViewLaterEntry } from '../repositories/view-later-repository.js';
import { likeEntry, recordEntryView } from '../repositories/usage-repository.js';
import { getSyncIdentity } from './sync-service.js';

interface EntrySyncRow {
  id: number;
  syncVersion: number;
  title: string;
  uploadDate: string | null;
  pageCount: number | null;
}

interface ReceiptRow {
  requestHash: string;
  resultJson: string;
}

type EntryUpdateOperation = Extract<SyncReplayOperation, { operationKind: 'entry.update' }>;
type EntryCreateOperation = Extract<SyncReplayOperation, { operationKind: 'entry.create' }>;

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function operationHash(operation: SyncReplayOperation): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(operation))).digest('hex');
}

function currentValues(
  row: EntrySyncRow,
  payload: EntryUpdateOperation['payload'],
): EntryUpdateOperation['baseValues'] {
  return {
    ...('title' in payload ? { title: row.title } : {}),
    ...('uploadDate' in payload ? { uploadDate: row.uploadDate } : {}),
    ...('pageCount' in payload ? { pageCount: row.pageCount } : {}),
  };
}

function valuesMatch(
  left: EntryUpdateOperation['baseValues'],
  right: EntryUpdateOperation['baseValues'],
): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function invalidCreateReason(database: T3Database, operation: EntryCreateOperation): string | null {
  if (!database.prepare('SELECT 1 FROM entries WHERE type = ? LIMIT 1').get(operation.payload.type)) {
    return 'Offline creation requires an existing Gallery';
  }
  const seen = new Set<number>();
  for (const rating of operation.payload.ratings) {
    if (seen.has(rating.slotId)) return 'A rating slot may only appear once';
    seen.add(rating.slotId);
    if (!database.prepare(`
      SELECT 1 FROM rating_slots
      WHERE id = ? AND subject_kind = 'entry' AND entry_type = ?
    `).get(rating.slotId, operation.payload.type)) {
      return `Rating slot ${rating.slotId} does not belong to this Gallery`;
    }
  }
  return null;
}

function maxServerSeq(database: T3Database): number {
  return Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());
}

function saveReceipt(
  database: T3Database,
  operation: SyncReplayOperation,
  requestHash: string,
  result: SyncReplayResult,
): SyncReplayResult {
  database.prepare(`
    INSERT INTO sync_operation_receipts (op_id, request_hash, result_json, server_seq)
    VALUES (?, ?, ?, ?)
  `).run(
    operation.opId,
    requestHash,
    JSON.stringify(result),
    'serverSeq' in result ? result.serverSeq : null,
  );
  return result;
}

/**
 * Replay exactly one allowlisted operation. Receipt lookup, optimistic conflict
 * checks, mutation, trigger-maintained journal writes, and receipt persistence
 * all share one SQLite transaction.
 */
export function replaySyncOperation(
  database: T3Database,
  operation: SyncReplayOperation,
): SyncReplayResult {
  const identity = getSyncIdentity(database);
  if (operation.libraryId !== identity.libraryId) {
    return { opId: operation.opId, status: 'resnapshot-required', reason: 'library-mismatch' };
  }
  if (operation.syncEpoch !== identity.syncEpoch) {
    return { opId: operation.opId, status: 'resnapshot-required', reason: 'epoch-mismatch' };
  }

  const replay = database.transaction((): SyncReplayResult => {
    const requestHash = operationHash(operation);
    const receipt = database.prepare(`
      SELECT request_hash AS requestHash, result_json AS resultJson
      FROM sync_operation_receipts WHERE op_id = ?
    `).get(operation.opId) as ReceiptRow | undefined;
    if (receipt !== undefined) {
      if (receipt.requestHash !== requestHash) {
        return {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'operation-id-collision',
          detail: 'Operation ID was already used for different content',
        };
      }
      return syncReplayResultSchema.parse(JSON.parse(receipt.resultJson));
    }

    if (operation.operationKind === 'entry.create') {
      const existingId = database.prepare('SELECT id FROM entries WHERE sync_uid = ?')
        .pluck().get(operation.entityUid) as number | undefined;
      if (existingId !== undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'entity-already-exists',
          detail: 'Entry sync identity already exists without this operation receipt',
        });
      }
      const invalidReason = invalidCreateReason(database, operation);
      if (invalidReason !== null) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'invalid-create',
          detail: invalidReason,
        });
      }
      const entry = createEntry(database, {
        title: operation.payload.title,
        type: operation.payload.type,
        syncUid: operation.entityUid,
        uploadDate: operation.payload.uploadDate,
        pageCount: operation.payload.pageCount,
      });
      for (const rating of operation.payload.ratings) {
        setEntryRating(database, { entryId: entry.id, ...rating }, { touchEntry: false });
      }
      if (operation.payload.viewLater) addViewLaterEntry(database, entry.id, false);
      const resourceVersion = Number(database.prepare(
        'SELECT sync_version FROM entries WHERE id = ?',
      ).pluck().get(entry.id));
      const result: SyncReplayResult = {
        opId: operation.opId,
        status: 'applied',
        entityId: entry.id,
        resourceVersion,
        serverSeq: maxServerSeq(database),
      };
      saveReceipt(database, operation, requestHash, result);
      database.prepare(`
        INSERT INTO sync_offline_created_entries (entry_uid, create_op_id)
        VALUES (?, ?)
      `).run(operation.entityUid, operation.opId);
      return result;
    }

    if (operation.operationKind === 'entry.usage') {
      const entry = database.prepare(`
        SELECT id FROM entries WHERE sync_uid = ?
      `).get(operation.entityUid) as { id: number } | undefined;
      if (entry === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'entity-not-found',
          detail: 'Entry no longer exists',
        });
      }

      if (operation.payload.event === 'view') {
        recordEntryView(database, entry.id, operation.clientCreatedAt);
      } else {
        likeEntry(database, entry.id);
      }
      // Usage is a child projection of Entry. Touching an allowlisted Entry
      // column with its current value advances the existing resource version
      // and change journal without pretending the metadata changed.
      database.prepare(`
        UPDATE entries SET updated_at = updated_at WHERE id = ?
      `).run(entry.id);
      const resourceVersion = Number(database.prepare(`
        SELECT sync_version FROM entries WHERE id = ?
      `).pluck().get(entry.id));
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId,
        status: 'applied',
        resourceVersion,
        serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'entry.rating.set') {
      const entry = database.prepare(`
        SELECT id, type, sync_version AS syncVersion FROM entries WHERE sync_uid = ?
      `).get(operation.entityUid) as { id: number; type: string; syncVersion: number } | undefined;
      if (entry === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'entity-not-found',
          detail: 'Entry no longer exists',
        });
      }
      const slot = database.prepare(`
        SELECT id FROM rating_slots
        WHERE sync_uid = ? AND subject_kind = 'entry' AND entry_type = ?
      `).get(operation.payload.slotUid, entry.type) as { id: number } | undefined;
      if (slot === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'invalid-rating',
          detail: `Rating slot ${operation.payload.slotUid} no longer belongs to this Gallery`,
        });
      }
      const value = database.prepare(`
        SELECT stars FROM entry_rating_values WHERE entry_id = ? AND slot_id = ?
      `).get(entry.id, slot.id) as { stars: number | null } | undefined;
      const currentStars = value?.stars ?? null;
      if (currentStars === operation.payload.stars) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'applied',
          resourceVersion: entry.syncVersion,
          serverSeq: maxServerSeq(database),
        });
      }
      const staleAndConflicting = entry.syncVersion < operation.baseVersion
        || currentStars !== operation.baseValues.stars;
      if (staleAndConflicting) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'conflict',
          currentVersion: entry.syncVersion,
          currentValues: { slotUid: operation.payload.slotUid, stars: currentStars },
          serverSeq: maxServerSeq(database),
        });
      }
      setEntryRating(database, {
        entryId: entry.id,
        slotId: slot.id,
        stars: operation.payload.stars,
      });
      const resourceVersion = Number(database.prepare(`
        SELECT sync_version FROM entries WHERE id = ?
      `).pluck().get(entry.id));
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId,
        status: 'applied',
        resourceVersion,
        serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'entry.view-later.set') {
      const entry = database.prepare(`
        SELECT id, sync_version AS syncVersion FROM entries WHERE sync_uid = ?
      `).get(operation.entityUid) as { id: number; syncVersion: number } | undefined;
      if (entry === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'entity-not-found',
          detail: 'Entry no longer exists',
        });
      }
      const present = Boolean(database.prepare(`
        SELECT 1 FROM view_later_entries WHERE entry_id = ?
      `).get(entry.id));
      if (present === operation.payload.present) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'applied',
          resourceVersion: entry.syncVersion,
          serverSeq: maxServerSeq(database),
        });
      }
      if (entry.syncVersion !== operation.baseVersion) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'conflict',
          currentVersion: entry.syncVersion,
          currentValues: { present },
          serverSeq: maxServerSeq(database),
        });
      }
      if (operation.payload.present) addViewLaterEntry(database, entry.id);
      else removeViewLaterEntry(database, entry.id);
      const resourceVersion = Number(database.prepare(`
        SELECT sync_version FROM entries WHERE id = ?
      `).pluck().get(entry.id));
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId,
        status: 'applied',
        resourceVersion,
        serverSeq: maxServerSeq(database),
      });
    }

    const row = database.prepare(`
      SELECT id, sync_version AS syncVersion, title,
             upload_date AS uploadDate, page_count AS pageCount
      FROM entries WHERE sync_uid = ?
    `).get(operation.entityUid) as EntrySyncRow | undefined;
    if (row === undefined) {
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId,
        status: 'failed',
        errorCode: 'entity-not-found',
        detail: 'Entry no longer exists',
      });
    }

    const values = currentValues(row, operation.payload);
    const staleAndConflicting = row.syncVersion < operation.baseVersion
      || (row.syncVersion > operation.baseVersion && !valuesMatch(values, operation.baseValues));
    if (staleAndConflicting) {
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId,
        status: 'conflict',
        currentVersion: row.syncVersion,
        currentValues: values,
        serverSeq: maxServerSeq(database),
      });
    }

    updateEntry(database, row.id, operation.payload as UpdateEntryInput);
    const resourceVersion = Number(database.prepare(`
      SELECT sync_version FROM entries WHERE id = ?
    `).pluck().get(row.id));
    return saveReceipt(database, operation, requestHash, {
      opId: operation.opId,
      status: 'applied',
      resourceVersion,
      serverSeq: maxServerSeq(database),
    });
  });
  return replay();
}
