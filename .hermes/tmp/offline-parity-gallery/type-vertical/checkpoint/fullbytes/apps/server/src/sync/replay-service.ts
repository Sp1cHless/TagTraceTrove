import { collectionCommonTagContext, applyCollectionCommonTag } from './collection-common-tag.js';
import { collectionDeleteIdentity } from './collection-delete.js';
import { setGalleryOrder } from '../repositories/gallery-order-repository.js';
import { createHash } from 'node:crypto';
import { normalizeTag, type SyncEntryMediaOperation, type SyncReplayRequest } from '@t3/shared';
import {
  syncReplayResultSchema,
  type SyncReplayOperation,
  type SyncReplayResult,
} from '@t3/shared';
import type { T3Database } from '../database/connection.js';
import { createEntry, updateEntry, type UpdateEntryInput } from '../repositories/entry-repository.js';
import { onlineEntryCreateHash } from './online-entry-create.js';
import { updateProducer, type UpdateProducerInput } from '../repositories/producer-repository.js';
import { setEntryRating, setProducerRating } from '../repositories/rating-repository.js';
import { galleryTypeForProducer } from '../repositories/producer-tag-repository.js';
import { addViewLaterEntry, removeViewLaterEntry, addViewLaterProducer, removeViewLaterProducer } from '../repositories/view-later-repository.js';
import { likeEntry, recordEntryView } from '../repositories/usage-repository.js';
import { applyEntryMediaOrder, entryMediaRefs } from '../import/media.js';
import { getSyncIdentity, OFFLINE_ENTRY_CONTENT_APPEND_ENABLED } from './sync-service.js';
import { resolveTaxonomyName } from '../repositories/taxonomy-repository.js';

interface EntrySyncRow {
  id: number;
  syncVersion: number;
  title: string;
  uploadDate: string | null;
  pageCount: number | null;
  durationSeconds: number | null;
}

interface ReceiptRow {
  requestHash: string;
  resultJson: string;
}

type EntryUpdateOperation = Extract<SyncReplayOperation, { operationKind: 'entry.update' }>;
type EntryCreateOperation = Extract<SyncReplayOperation, { operationKind: 'entry.create' }>;
type ProducerUpdateOperation = Extract<SyncReplayOperation, { operationKind: 'producer.update' }>;
type ProducerTagsOperation = Extract<SyncReplayOperation, { operationKind: 'producer.tags.set' }>;
type AuthorDirectoriesOperation = Extract<SyncReplayOperation, { operationKind: 'author.directories.set' }>;
type RatingLayoutOperation = Extract<SyncReplayOperation, { operationKind: 'rating-layout.slots.set' }>;
type ProducerTagValue = ProducerTagsOperation['payload']['tags'][number];
type ProducerDirectoryState = AuthorDirectoriesOperation['payload']['directories'];
type ProducerDirectoryValue = ProducerDirectoryState[number];
type ProducerDirectoryEntry = ProducerDirectoryValue['entries'][number];
type RatingLayoutSlotValue = RatingLayoutOperation['payload']['slots'][number];

type EntryTagsOperation = Extract<SyncReplayOperation, { operationKind: 'entry.tags.set' }>;


type EntryTagValue = EntryTagsOperation['payload']['tags'][number];
interface ResolvedEntryTagValue { name: string; facetId: number }

function entryTagsForOwner(database: T3Database, entryId: number): ResolvedEntryTagValue[] {
  const tags = database.prepare(`
    SELECT tag.name, assignment.facet_id AS facetId
    FROM entry_tags AS assignment JOIN tags AS tag ON tag.id = assignment.tag_id
    WHERE assignment.entry_id = ? ORDER BY tag.normalized_name
  `).all(entryId) as ResolvedEntryTagValue[];
  return tags.sort((left, right) => normalizeTag(left.name).localeCompare(normalizeTag(right.name)));
}

function canonicalEntryTags(
  database: T3Database,
  tags: EntryTagValue[],
  createdTagIds = new Map<string, number>(),
  createdFacetIds = new Map<string, number>(),
): ResolvedEntryTagValue[] | null {
  const result: ResolvedEntryTagValue[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    let name = tag.name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    let normalized = normalizeTag(name);
    const alias = database.prepare(`
      SELECT canonical_name AS name FROM taxonomy_aliases
      WHERE vocabulary = 'entry' AND normalized_alias = ? AND normalized_canonical <> ''
    `).get(normalized) as { name: string } | undefined;
    if (alias) {
      name = alias.name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
      normalized = normalizeTag(name);
    }
    if (!normalized || seen.has(normalized)) return null;
    seen.add(normalized);
    const stableTagId = tag.tagUid === undefined ? undefined : createdTagIds.get(tag.tagUid.toLowerCase());
    if (tag.tagUid !== undefined && stableTagId === undefined) return null;
    const existing = stableTagId === undefined
      ? database.prepare('SELECT name, normalized_name AS normalizedName FROM tags WHERE normalized_name = ?').get(normalized) as { name: string; normalizedName: string } | undefined
      : database.prepare('SELECT name, normalized_name AS normalizedName FROM tags WHERE id = ?').get(stableTagId) as { name: string; normalizedName: string } | undefined;
    if (stableTagId !== undefined && (existing === undefined || existing.normalizedName !== normalized)) return null;
    const facetId = tag.facetId ?? (tag.facetUid === undefined
      ? undefined : createdFacetIds.get(tag.facetUid.toLowerCase()));
    if (facetId === undefined) return null;
    result.push({ name: existing?.name ?? name, facetId });
  }
  return result.sort((left, right) => normalizeTag(left.name).localeCompare(normalizeTag(right.name)));
}

interface ProducerSyncRow {
  id: number;
  syncVersion: number;
  name: string;
  occupation: string | null;
  artworkRef: string | null;
  content: string | null;
  galleryAnchor: string | null;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function operationHash(operation: SyncReplayRequest): string {
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
    ...('durationSeconds' in payload ? { durationSeconds: row.durationSeconds } : {}),
  };
}

function currentProducerValues(
  row: ProducerSyncRow,
  payload: ProducerUpdateOperation['payload'],
): ProducerUpdateOperation['baseValues'] {
  return {
    ...('name' in payload ? { name: row.name } : {}),
    ...('occupation' in payload ? { occupation: row.occupation } : {}),
    ...('artworkRef' in payload ? { artworkRef: row.artworkRef } : {}),
    ...('content' in payload ? { content: row.content } : {}),
    ...('galleryAnchor' in payload ? { galleryAnchor: row.galleryAnchor } : {}),
  };
}

function producerTagsForOwner(database: T3Database, producerId: number): ProducerTagValue[] {
  return database.prepare(`
    SELECT tag.sync_uid AS syncUid, tag.name
    FROM producer_tag_assignments AS assignment
    JOIN producer_tags AS tag ON tag.id = assignment.tag_id
    WHERE assignment.producer_id = ?
    ORDER BY tag.sync_uid
  `).all(producerId) as ProducerTagValue[];
}

function normalizedProducerTagName(name: string): { name: string; normalizedName: string } {
  const displayName = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return { name: displayName, normalizedName: normalizeTag(displayName) };
}

function applyProducerTags(
  database: T3Database,
  producerId: number,
  currentTags: ProducerTagValue[],
  desiredTags: ProducerTagValue[],
): string | null {
  const currentByUid = new Map(currentTags.map((tag) => [tag.syncUid, tag]));
  const desiredByUid = new Map(desiredTags.map((tag) => [tag.syncUid, tag]));
  const prepared: Array<{ syncUid: string; name: string; normalizedName: string; id: number | null }> = [];
  const normalizedNames = new Set<string>();
  for (const tag of desiredTags) {
    const normalized = normalizedProducerTagName(tag.name);
    if (normalized.normalizedName === '' || normalizedNames.has(normalized.normalizedName)) {
      return 'Author tags must have unique, non-empty names';
    }
    normalizedNames.add(normalized.normalizedName);
    const existingByUid = database.prepare(`
      SELECT id, name FROM producer_tags WHERE sync_uid = ?
    `).get(tag.syncUid) as { id: number; name: string } | undefined;
    if (existingByUid !== undefined && existingByUid.name !== normalized.name) {
      return `Author tag identity ${tag.syncUid} was renamed; refresh the offline copy`;
    }
    const priorOwnerTag = currentByUid.get(tag.syncUid);
    if (priorOwnerTag !== undefined && priorOwnerTag.name !== normalized.name) {
      return `Author tag identity ${tag.syncUid} cannot be renamed in place`;
    }
    const existingByName = database.prepare(`
      SELECT id FROM producer_tags WHERE normalized_name = ?
    `).get(normalized.normalizedName) as { id: number } | undefined;
    if (existingByName !== undefined && existingByUid === undefined) {
      return `Author tag "${normalized.name}" was created elsewhere; refresh before retrying`;
    }
    prepared.push({
      syncUid: tag.syncUid,
      name: normalized.name,
      normalizedName: normalized.normalizedName,
      id: existingByUid?.id ?? null,
    });
  }

  const currentIds = new Map<string, number>();
  for (const tag of currentTags) {
    const row = database.prepare('SELECT id FROM producer_tags WHERE sync_uid = ?').get(tag.syncUid) as { id: number } | undefined;
    if (row === undefined) return `Author tag identity ${tag.syncUid} no longer exists`;
    currentIds.set(tag.syncUid, row.id);
  }

  for (const tag of currentTags) {
    if (desiredByUid.has(tag.syncUid)) continue;
    const tagId = currentIds.get(tag.syncUid);
    if (tagId === undefined) continue;
    database.prepare('DELETE FROM producer_tag_assignments WHERE producer_id = ? AND tag_id = ?')
      .run(producerId, tagId);
    database.prepare(`
      DELETE FROM producer_tags WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM producer_tag_assignments WHERE tag_id = ?)
    `).run(tagId, tagId);
  }

  for (const tag of prepared) {
    let tagId = tag.id;
    if (tagId === null) {
      database.prepare(`
        INSERT INTO producer_tags (sync_uid, name, normalized_name) VALUES (?, ?, ?)
      `).run(tag.syncUid, tag.name, tag.normalizedName);
      tagId = Number(database.prepare('SELECT id FROM producer_tags WHERE sync_uid = ?').pluck().get(tag.syncUid));
    }
    if (currentIds.has(tag.syncUid)) continue;
    database.prepare('INSERT INTO producer_tag_assignments (producer_id, tag_id) VALUES (?, ?)')
      .run(producerId, tagId);
  }
  return null;
}

function ratingLayoutSlots(database: T3Database, layoutId: number): RatingLayoutSlotValue[] {
  return database.prepare(`
    SELECT sync_uid AS syncUid, name, sort_order AS sortOrder
    FROM rating_slots
    WHERE (subject_kind, entry_type) = (
      SELECT subject_kind, entry_type FROM rating_slot_layouts WHERE id = ?
    )
    ORDER BY sort_order, id
  `).all(layoutId) as RatingLayoutSlotValue[];
}

function expectedRatingLayoutDelta(
  base: RatingLayoutOperation['baseValues']['slots'],
  desired: RatingLayoutOperation['payload']['slots'],
): number {
  const baseByUid = new Map(base.map((slot) => [slot.syncUid, slot]));
  let delta = base.filter(slot => !desired.some(row => row.syncUid === slot.syncUid)).length;
  for (const slot of desired) {
    const previous = baseByUid.get(slot.syncUid);
    if (previous === undefined || previous.sortOrder !== slot.sortOrder) delta += 1;
  }
  return delta;
}

function producerDirectoryState(database: T3Database, producerId: number): ProducerDirectoryState {
  const directories = database.prepare(`
    SELECT id, sync_uid AS syncUid, title, description, sort_order AS sortOrder
    FROM author_directories WHERE producer_id = ? ORDER BY sort_order, id
  `).all(producerId) as Array<{
    id: number; syncUid: string; title: string; description: string; sortOrder: number;
  }>;
  return directories.map((directory) => ({
    syncUid: directory.syncUid,
    title: directory.title,
    description: directory.description,
    sortOrder: directory.sortOrder,
    entries: database.prepare(`
      SELECT entry.sync_uid AS syncUid, membership.sort_order AS sortOrder
      FROM author_directory_entries AS membership
      JOIN entries AS entry ON entry.id = membership.entry_id
      WHERE membership.directory_id = ? AND membership.producer_id = ?
      ORDER BY membership.sort_order, membership.entry_id
    `).all(directory.id, producerId) as ProducerDirectoryEntry[],
  }));
}

function expectedProducerDirectoryDelta(
  base: ProducerDirectoryState,
  desired: ProducerDirectoryState,
): number {
  const baseDirectories = new Map(base.map((directory) => [directory.syncUid, directory]));
  let delta = 0;
  for (const directory of desired) {
    const previous = baseDirectories.get(directory.syncUid);
    if (previous === undefined
      || previous.title !== directory.title
      || previous.description !== directory.description
      || previous.sortOrder !== directory.sortOrder) {
      delta += 1;
    }
  }
  const baseMemberships = new Map<string, number>();
  const desiredMemberships = new Map<string, number>();
  const addMemberships = (target: Map<string, number>, directories: ProducerDirectoryState): void => {
    for (const directory of directories) {
      for (const entry of directory.entries) {
        target.set(`${directory.syncUid}\\0${entry.syncUid}`, entry.sortOrder);
      }
    }
  };
  addMemberships(baseMemberships, base);
  addMemberships(desiredMemberships, desired);
  for (const [identity, sortOrder] of baseMemberships) {
    const desiredSortOrder = desiredMemberships.get(identity);
    if (desiredSortOrder === undefined) delta += 1;
    else if (desiredSortOrder !== sortOrder) delta += 1;
  }
  for (const identity of desiredMemberships.keys()) {
    if (!baseMemberships.has(identity)) delta += 1;
  }
  return delta;
}

function expectedEntryAuthorsDelta(base: string[], desired: string[]): number {
  const baseSet = new Set(base);
  const desiredSet = new Set(desired);
  return [...baseSet].filter((uid) => !desiredSet.has(uid)).length
    + [...desiredSet].filter((uid) => !baseSet.has(uid)).length;
}

function entryProducerUids(database: T3Database, entryId: number): string[] {
  return (database.prepare(`
    SELECT producer.sync_uid AS syncUid
    FROM entry_producers AS relation
    JOIN producers AS producer ON producer.id = relation.producer_id
    WHERE relation.entry_id = ?
    ORDER BY producer.sync_uid
      `).all(entryId) as Array<{ syncUid: string }>).map((row) => row.syncUid.toLowerCase()).sort();
}

function valuesMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function invalidCreateReason(database: T3Database, operation: EntryCreateOperation): string | null {
  const seenSlots = new Set<number>();
  for (const rating of operation.payload.ratings) {
    const slot = rating.slotUid === undefined
      ? database.prepare(`
          SELECT id FROM rating_slots WHERE id = ? AND subject_kind = 'entry' AND entry_type = ?
        `).get(rating.slotId, operation.payload.type) as { id: number } | undefined
      : database.prepare(`
          SELECT id FROM rating_slots WHERE sync_uid = ? AND subject_kind = 'entry' AND entry_type = ?
        `).get(rating.slotUid, operation.payload.type) as { id: number } | undefined;
    if (slot === undefined) {
      return `Rating slot ${rating.slotUid ?? rating.slotId} does not belong to this Gallery`;
    }
    if (seenSlots.has(slot.id)) return 'A rating slot may only appear once';
    seenSlots.add(slot.id);
  }
  return null;
}

function maxServerSeq(database: T3Database): number {
  return Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());
}

function saveReceipt(
  database: T3Database,
  operation: SyncReplayRequest,
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
/**
 * Media is the one replayed operation with file side effects, so it cannot run
 * inside the synchronous replay transaction: the files move first, then the
 * stored list and the receipt are written together. A failure before that
 * write leaves the receipt absent, and the op stays retryable.
 */
export async function replayEntryMediaOperation(
  database: T3Database,
  assetRoot: string,
  operation: SyncEntryMediaOperation,
): Promise<SyncReplayResult> {
  const identity = getSyncIdentity(database);
  if (operation.libraryId !== identity.libraryId) {
    return { opId: operation.opId, status: 'resnapshot-required', reason: 'library-mismatch' };
  }
  if (operation.syncEpoch !== identity.syncEpoch) {
    return { opId: operation.opId, status: 'resnapshot-required', reason: 'epoch-mismatch' };
  }
  const requestHash = operationHash(operation);
  const receipt = database.prepare(`
    SELECT request_hash AS requestHash, result_json AS resultJson
    FROM sync_operation_receipts WHERE op_id = ?
  `).get(operation.opId) as ReceiptRow | undefined;
  if (receipt !== undefined) {
    if (receipt.requestHash !== requestHash) {
      return { opId: operation.opId, status: 'failed', errorCode: 'operation-id-collision', detail: 'Operation ID was already used for different content' };
    }
    return syncReplayResultSchema.parse(JSON.parse(receipt.resultJson));
  }
  const entry = database.prepare(`
    SELECT id, sync_version AS syncVersion, cover_ref AS coverRef, preview_refs AS previewRefs
    FROM entries WHERE sync_uid = ?
  `).get(operation.entityUid) as {
    id: number; syncVersion: number; coverRef: string | null; previewRefs: string;
  } | undefined;
  if (entry === undefined) {
    return saveReceipt(database, operation, requestHash, {
      opId: operation.opId, status: 'failed', errorCode: 'entity-not-found', detail: 'Entry no longer exists',
    });
  }
  const current = entryMediaRefs({ coverRef: entry.coverRef, previewRefs: JSON.parse(entry.previewRefs) as string[] });
  const version = (): number => Number(database.prepare(
    'SELECT sync_version FROM entries WHERE id = ?',
  ).pluck().get(entry.id));
  // A positional URL is not picture identity. Only an exact stored receipt
  // (checked above) authorizes an unchanged retry after the owner advances.
  // Even an apparently satisfied desired list must first pass the reviewed
  // revision/base check, otherwise a peer's different bytes become false success.
  if (entry.syncVersion !== operation.baseVersion
    || JSON.stringify(current) !== JSON.stringify(operation.baseValues.refs)) {
    return saveReceipt(database, operation, requestHash, {
      opId: operation.opId, status: 'conflict', currentVersion: version(),
      currentValues: { refs: current }, serverSeq: maxServerSeq(database),
    });
  }
  if (JSON.stringify(current) === JSON.stringify(operation.payload.refs)) {
    return saveReceipt(database, operation, requestHash, {
      opId: operation.opId, status: 'applied', entityId: entry.id,
      resourceVersion: version(), serverSeq: maxServerSeq(database),
    });
  }
  try {
    await applyEntryMediaOrder(database, assetRoot, entry.id, operation.payload.refs);
  } catch (error) {
    return saveReceipt(database, operation, requestHash, {
      opId: operation.opId, status: 'failed', errorCode: 'invalid-media',
      detail: error instanceof Error ? error.message : 'Entry media could not be reordered',
    });
  }
  return saveReceipt(database, operation, requestHash, {
    opId: operation.opId, status: 'applied', entityId: entry.id,
    resourceVersion: version(), serverSeq: maxServerSeq(database),
  });
}

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
      const result = syncReplayResultSchema.parse(JSON.parse(receipt.resultJson));
      // Old receipts predate the causal registry. Reconstruct only from an
      // exact, hash-verified creation envelope, never from numeric coincidence.
      if (operation.operationKind === 'entry.author.create-and-link' && result.status === 'applied'
        && database.prepare('SELECT id FROM producers WHERE sync_uid = ? COLLATE NOCASE').pluck().get(operation.payload.producerUid) === result.entityId) {
        database.prepare(`INSERT OR IGNORE INTO sync_offline_created_producers
          (producer_uid, producer_id, create_op_id, client_id, library_id, sync_epoch) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(operation.payload.producerUid, result.entityId, operation.opId, operation.clientId, operation.libraryId, operation.syncEpoch);
      }
      return result;
    }

    if (operation.operationKind === 'entry.delete') {
      const owner = database.prepare('SELECT id, sync_version AS syncVersion FROM entries WHERE sync_uid = ? COLLATE NOCASE')
        .get(operation.entityUid) as {id:number; syncVersion:number} | undefined;
      if (!owner) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'failed', errorCode: 'entity-not-found', detail: 'Entry is absent; only an exact original receipt proves this deletion',
      });
      if (owner.syncVersion !== operation.baseVersion) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'conflict', currentVersion: owner.syncVersion, currentValues: {}, serverSeq: maxServerSeq(database),
      });
      // Cascades remove relations; shared Author/vocabulary rows remain stored.
      database.prepare('DELETE FROM entries WHERE id = ?').run(owner.id);
      const tombstone = database.prepare("SELECT deleted_version AS version, change_seq AS seq FROM sync_tombstones WHERE entity_kind = 'entry' AND entity_uid = ? COLLATE NOCASE")
        .get(operation.entityUid) as {version:number;seq:number} | undefined;
      if (!tombstone) throw new Error('Entry deletion did not produce a durable tombstone');
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', entityId: owner.id, resourceVersion: tombstone.version, serverSeq: tombstone.seq,
      });
    }

    if (operation.operationKind === 'producer.delete') {
      const owner = database.prepare('SELECT id, sync_version AS syncVersion FROM producers WHERE sync_uid = ? COLLATE NOCASE')
        .get(operation.entityUid) as {id:number; syncVersion:number} | undefined;
      if (!owner) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'failed', errorCode: 'entity-not-found', detail: 'Author is absent; only an exact original receipt proves this deletion',
      });
      if (owner.syncVersion !== operation.baseVersion) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'conflict', currentVersion: owner.syncVersion, currentValues: {}, serverSeq: maxServerSeq(database),
      });
      // Cascades remove relations; works and shared vocabulary rows remain stored.
      database.prepare('DELETE FROM producers WHERE id = ?').run(owner.id);
      const tombstone = database.prepare("SELECT deleted_version AS version, change_seq AS seq FROM sync_tombstones WHERE entity_kind = 'producer' AND entity_uid = ? COLLATE NOCASE")
        .get(operation.entityUid) as {version:number;seq:number} | undefined;
      if (!tombstone) throw new Error('Author deletion did not produce a durable tombstone');
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', entityId: owner.id, resourceVersion: tombstone.version, serverSeq: tombstone.seq,
      });
    }

    if (operation.operationKind === 'producer.create') {
      if (database.prepare('SELECT id FROM producers WHERE sync_uid = ? COLLATE NOCASE').get(operation.entityUid)) {
        return saveReceipt(database, operation, requestHash, {opId:operation.opId,status:'failed',errorCode:'entity-already-exists',detail:'Author UUID is already owned'});
      }
      if (operation.payload.directorySetUid !== undefined && (operation.payload.directorySetUid === operation.entityUid || database.prepare('SELECT 1 FROM author_directory_sets WHERE sync_uid = ? COLLATE NOCASE').get(operation.payload.directorySetUid))) {
        return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'failed',errorCode:'entity-already-exists',detail:'Directory-set UUID is already owned or is not independent'});
      }
      const id = Number(database.prepare('INSERT INTO producers (name, occupation, artwork_ref, content, sync_uid, directory_set_seed_uid) VALUES (?, ?, ?, ?, ?, ?)')
        .run(operation.payload.name, operation.payload.occupation, operation.payload.artworkRef, operation.payload.content, operation.entityUid, operation.payload.directorySetUid ?? null).lastInsertRowid);
      database.prepare('INSERT INTO sync_offline_created_producers (producer_uid, producer_id, create_op_id, client_id, library_id, sync_epoch) VALUES (?, ?, ?, ?, ?, ?)')
        .run(operation.entityUid,id,operation.opId,operation.clientId,operation.libraryId,operation.syncEpoch);
      return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'applied',entityId:id,resourceVersion:1,serverSeq:maxServerSeq(database)});
    }

    if (operation.operationKind === 'producer.view-later.set') {
      const producer = database.prepare(`
        SELECT id, sync_version AS syncVersion FROM producers WHERE sync_uid = ?
      `).get(operation.entityUid) as { id: number; syncVersion: number } | undefined;
      if (producer === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'entity-not-found',
          detail: 'Author no longer exists',
        });
      }
      const present = Boolean(database.prepare(`
        SELECT 1 FROM view_later_producers WHERE producer_id = ?
      `).get(producer.id));
      if (present === operation.payload.present) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'applied',
          resourceVersion: producer.syncVersion,
          serverSeq: maxServerSeq(database),
        });
      }
      if (producer.syncVersion !== operation.baseVersion
        || present !== operation.baseValues.present) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'conflict',
          currentVersion: producer.syncVersion,
          currentValues: { present },
          serverSeq: maxServerSeq(database),
        });
      }
      if (operation.payload.present) addViewLaterProducer(database, producer.id);
      else removeViewLaterProducer(database, producer.id);
      const resourceVersion = Number(database.prepare(`
        SELECT sync_version FROM producers WHERE id = ?
      `).pluck().get(producer.id));
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId,
        status: 'applied',
        resourceVersion,
        serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'producer.rating.set') {
      const producer = database.prepare(`
        SELECT id, sync_version AS syncVersion FROM producers WHERE sync_uid = ?
      `).get(operation.entityUid) as { id: number; syncVersion: number } | undefined;
      if (producer === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'entity-not-found',
          detail: 'Author no longer exists',
        });
      }
      const galleryType = galleryTypeForProducer(database, producer.id);
      const slot = galleryType === null ? undefined : database.prepare(`
        SELECT id FROM rating_slots
        WHERE sync_uid = ? AND subject_kind = ? AND entry_type = ?
      `).get(operation.payload.slotUid, operation.payload.subjectKind ?? 'producer', galleryType) as { id: number } | undefined;
      if (slot === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'invalid-rating',
          detail: `Rating slot ${operation.payload.slotUid} no longer belongs to this Author's dominant Gallery`,
        });
      }
      const value = database.prepare(`
        SELECT stars FROM producer_rating_values WHERE producer_id = ? AND slot_id = ?
      `).get(producer.id, slot.id) as { stars: number | null } | undefined;
      const currentStars = value?.stars ?? null;
      if (currentStars === operation.payload.stars) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'applied',
          resourceVersion: producer.syncVersion,
          serverSeq: maxServerSeq(database),
        });
      }
      if (producer.syncVersion < operation.baseVersion || currentStars !== operation.baseValues.stars) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'conflict',
          currentVersion: producer.syncVersion,
          currentValues: { slotUid: operation.payload.slotUid, stars: currentStars },
          serverSeq: maxServerSeq(database),
        });
      }
      setProducerRating(database, {
        producerId: producer.id,
        slotId: slot.id,
        stars: operation.payload.stars,
      });
      const resourceVersion = Number(database.prepare(`
        SELECT sync_version FROM producers WHERE id = ?
      `).pluck().get(producer.id));
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId,
        status: 'applied',
        resourceVersion,
        serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'producer.update') {
      const producer = database.prepare(`
        SELECT id, sync_version AS syncVersion, name, occupation,
               artwork_ref AS artworkRef, content, gallery_anchor AS galleryAnchor
        FROM producers WHERE sync_uid = ?
      `).get(operation.entityUid) as ProducerSyncRow | undefined;
      if (producer === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'entity-not-found',
          detail: 'Author no longer exists',
        });
      }
      const values = currentProducerValues(producer, operation.payload);
      if (valuesMatch(values, operation.payload)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'applied',
          resourceVersion: producer.syncVersion,
          serverSeq: maxServerSeq(database),
        });
      }
      if (producer.syncVersion < operation.baseVersion || !valuesMatch(values, operation.baseValues)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'conflict',
          currentVersion: producer.syncVersion,
          currentValues: values,
          serverSeq: maxServerSeq(database),
        });
      }
      updateProducer(database, producer.id, operation.payload as UpdateProducerInput);
      const resourceVersion = Number(database.prepare(
        'SELECT sync_version FROM producers WHERE id = ?',
      ).pluck().get(producer.id));
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId,
        status: 'applied',
        resourceVersion,
        serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'producer.tags.set') {
      const producer = database.prepare(`
        SELECT id, sync_version AS syncVersion FROM producers WHERE sync_uid = ?
      `).get(operation.entityUid) as { id: number; syncVersion: number } | undefined;
      if (producer === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'entity-not-found',
          detail: 'Author no longer exists',
        });
      }
      const currentTags = producerTagsForOwner(database, producer.id);
      if (valuesMatch({ tags: currentTags }, operation.payload)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'applied',
          resourceVersion: producer.syncVersion,
          serverSeq: maxServerSeq(database),
        });
      }
      if (producer.syncVersion < operation.baseVersion
        || !valuesMatch({ tags: currentTags }, operation.baseValues)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'conflict',
          currentVersion: producer.syncVersion,
          currentValues: { tags: currentTags },
          serverSeq: maxServerSeq(database),
        });
      }
      const invalidReason = applyProducerTags(
        database,
        producer.id,
        currentTags,
        operation.payload.tags,
      );
      if (invalidReason !== null) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'invalid-author-data',
          detail: invalidReason,
        });
      }
      const resourceVersion = Number(database.prepare(
        'SELECT sync_version FROM producers WHERE id = ?',
      ).pluck().get(producer.id));
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId,
        status: 'applied',
        resourceVersion,
        serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'rating-layout.slots.set') {
      const layout = database.prepare(`
        SELECT id, sync_version AS syncVersion, subject_kind AS subjectKind, entry_type AS entryType
        FROM rating_slot_layouts WHERE sync_uid = ?
      `).get(operation.entityUid) as {
        id: number; syncVersion: number; subjectKind: string; entryType: string;
      } | undefined;
      if (layout === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'entity-not-found',
          detail: 'Rating slot layout no longer exists; refresh the offline copy',
        });
      }
      if ((operation.payload.subjectKind !== undefined && operation.payload.subjectKind !== layout.subjectKind) || (layout.subjectKind === 'author_self' && operation.payload.subjectKind !== 'author_self')) {
        return saveReceipt(database, operation, requestHash, { opId: operation.opId, status: 'failed', errorCode: 'invalid-rating', detail: 'Rating layout class marker disagrees with the authoritative partition' });
      }
      const currentSlots = ratingLayoutSlots(database, layout.id);
      const currentValues = { slots: currentSlots };
      const expectedDelta = expectedRatingLayoutDelta(operation.baseValues.slots, operation.payload.slots);
      if (valuesMatch(currentValues, { slots: operation.payload.slots })) {
        for (let index = 0; index < expectedDelta; index += 1) {
          database.prepare(`
            UPDATE rating_slot_layouts SET sync_version = sync_version + 1 WHERE id = ?
          `).run(layout.id);
        }
        const resourceVersion = Number(database.prepare(
          'SELECT sync_version FROM rating_slot_layouts WHERE id = ?',
        ).pluck().get(layout.id));
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'applied',
          resourceVersion,
          serverSeq: maxServerSeq(database),
        });
      }
      if (layout.syncVersion < operation.baseVersion || !valuesMatch(currentValues, operation.baseValues)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'conflict',
          currentVersion: layout.syncVersion,
          currentValues,
          serverSeq: maxServerSeq(database),
        });
      }

      const currentByUid = new Map(currentSlots.map((slot) => [slot.syncUid, slot]));
      const desiredNames = new Set<string>();
      for (const desired of operation.payload.slots) {
        if (desiredNames.has(desired.name)) {
          return saveReceipt(database, operation, requestHash, {
            opId: operation.opId, status: 'failed', errorCode: 'invalid-rating',
            detail: 'Rating slot names must be unique within a layout',
          });
        }
        desiredNames.add(desired.name);
        const current = currentByUid.get(desired.syncUid);
        if (current !== undefined) continue;
        const reusedIdentity = database.prepare(`
          SELECT subject_kind AS subjectKind, entry_type AS entryType
          FROM rating_slots WHERE sync_uid = ?
        `).get(desired.syncUid) as { subjectKind: string; entryType: string } | undefined;
        if (reusedIdentity !== undefined) {
          return saveReceipt(database, operation, requestHash, {
            opId: operation.opId, status: 'failed', errorCode: 'invalid-rating',
            detail: 'Rating slot identity already belongs to another row',
          });
        }
        const duplicateName = database.prepare(`
          SELECT 1 FROM rating_slots WHERE subject_kind = ? AND entry_type = ? AND name = ?
        `).get(layout.subjectKind, layout.entryType, desired.name);
        if (duplicateName !== undefined) {
          return saveReceipt(database, operation, requestHash, {
            opId: operation.opId, status: 'failed', errorCode: 'invalid-rating',
            detail: 'A rating slot with this name was created elsewhere; refresh before retrying',
          });
        }
      }

      for (const uid of operation.payload.deletedSlotUids ?? []) {
        database.prepare('DELETE FROM rating_slots WHERE sync_uid = ? AND subject_kind = ? AND entry_type = ?').run(uid, layout.subjectKind, layout.entryType);
      }
      for (const desired of operation.payload.slots) {
        const current = currentByUid.get(desired.syncUid);
        if (current === undefined) {
          database.prepare(`
            INSERT INTO rating_slots (subject_kind, entry_type, sync_uid, name, sort_order)
            VALUES (?, ?, ?, ?, ?)
          `).run(layout.subjectKind, layout.entryType, desired.syncUid, desired.name, desired.sortOrder);
        } else if (current.sortOrder !== desired.sortOrder) {
          database.prepare('UPDATE rating_slots SET sort_order = ? WHERE sync_uid = ?')
            .run(desired.sortOrder, desired.syncUid);
        }
      }
      const resourceVersion = Number(database.prepare(
        'SELECT sync_version FROM rating_slot_layouts WHERE id = ?',
      ).pluck().get(layout.id));
      if (resourceVersion !== layout.syncVersion + expectedDelta) {
        throw new Error('rating layout revision delta did not match the applied slot changes');
      }
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId,
        status: 'applied',
        resourceVersion,
        serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'collection.common-tag.add') {
      const id=database.prepare('SELECT id FROM collections WHERE sync_uid=? COLLATE NOCASE').pluck().get(operation.entityUid) as number|undefined;
      if(id===undefined)return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'failed',errorCode:'entity-not-found',detail:'Collection missing'});
      const current=collectionCommonTagContext(database,id,operation.payload.name);
      if(current.syncVersion!==operation.baseVersion || JSON.stringify(current.baseValues)!==JSON.stringify(operation.baseValues))return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'conflict',currentVersion:current.syncVersion,currentValues:{},serverSeq:maxServerSeq(database)});
      const collectionCommonTag=applyCollectionCommonTag(database,id,operation);
      return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'applied',entityId:id,resourceVersion:operation.baseVersion+1,serverSeq:maxServerSeq(database),collectionCommonTag});
    }
    if (operation.operationKind === 'collection.delete') {
      const id=database.prepare('SELECT id FROM collections WHERE sync_uid=? COLLATE NOCASE').pluck().get(operation.entityUid) as number|undefined;
      if (id===undefined) return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'failed',errorCode:'entity-not-found',detail:'Collection is absent; only the original immutable receipt proves deletion'});
      const identity=collectionDeleteIdentity(database,id)!;
      const normalized=(scope:typeof identity.scope)=>({...scope,parentUid:scope.parentUid?.toLowerCase()??null,children:scope.children.map(row=>({...row,syncUid:row.syncUid.toLowerCase()})).sort((a,b)=>a.syncUid.localeCompare(b.syncUid))});
      if (identity.syncVersion!==operation.baseVersion || JSON.stringify(normalized(identity.scope))!==JSON.stringify(normalized(operation.baseValues))) return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'conflict',currentVersion:identity.syncVersion,currentValues:{},serverSeq:maxServerSeq(database)});
      const owners=[identity,...identity.scope.children.map(child=>({id:Number(database.prepare('SELECT id FROM collections WHERE sync_uid=? COLLATE NOCASE').pluck().get(child.syncUid)),syncUid:child.syncUid,syncVersion:child.syncVersion}))];
      database.prepare('DELETE FROM collections WHERE id=?').run(id);
      const collectionDeleteJournal=owners.map(owner=>{
        const row=database.prepare("SELECT deleted_version AS resourceVersion,change_seq AS serverSeq FROM sync_tombstones WHERE entity_kind='collection' AND entity_uid=? COLLATE NOCASE").get(owner.syncUid) as {resourceVersion:number;serverSeq:number}|undefined;
        if (!row || row.resourceVersion!==owner.syncVersion+1) throw new Error('Collection cascade missing its own immutable delete journal');
        return {id:owner.id,syncUid:owner.syncUid,...row};
      });
      return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'applied',entityId:id,resourceVersion:collectionDeleteJournal[0]!.resourceVersion,serverSeq:Math.max(...collectionDeleteJournal.map(row=>row.serverSeq)),collectionDeleteJournal});
    }

    if (operation.operationKind === 'collection.update') {
      const collection = database.prepare(`
        SELECT id, kind, sync_version AS syncVersion, title, description, nsfw
        FROM collections WHERE sync_uid = ?
      `).get(operation.entityUid) as {
        id: number; kind: string; syncVersion: number; title: string; description: string; nsfw: number;
      } | undefined;
      if (collection === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'entity-not-found',
          detail: 'Collection no longer exists; refresh the offline copy',
        });
      }
      const allValues = {
        title: collection.title, description: collection.description, nsfw: collection.nsfw === 1,
      };
      const currentValues = Object.fromEntries(Object.keys(operation.payload).map((key) => (
        [key, allValues[key as keyof typeof allValues]]
      )));
      if (collection.syncVersion >= operation.baseVersion && valuesMatch(currentValues, operation.payload)) {
        database.prepare('UPDATE collections SET sync_version = sync_version + 1 WHERE id = ?')
          .run(collection.id);
        const resourceVersion = Number(database.prepare(
          'SELECT sync_version FROM collections WHERE id = ?',
        ).pluck().get(collection.id));
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'applied', resourceVersion,
          serverSeq: maxServerSeq(database),
        });
      }
      if (collection.syncVersion < operation.baseVersion || !valuesMatch(currentValues, operation.baseValues)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'conflict', currentVersion: collection.syncVersion,
          currentValues, serverSeq: maxServerSeq(database),
        });
      }
      const assignments: string[] = [];
      const parameters: Array<string | number> = [];
      if (operation.payload.title !== undefined) {
        assignments.push('title = ?');
        parameters.push(operation.payload.title.trim());
      }
      if (operation.payload.description !== undefined) {
        assignments.push('description = ?');
        parameters.push(operation.payload.description.trim());
      }
      if (operation.payload.nsfw !== undefined) {
        assignments.push('nsfw = ?');
        parameters.push(operation.payload.nsfw ? 1 : 0);
      }
      database.prepare(`
        UPDATE collections SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(...parameters, collection.id);
      const resourceVersion = Number(database.prepare(
        'SELECT sync_version FROM collections WHERE id = ?',
      ).pluck().get(collection.id));
      if (resourceVersion !== collection.syncVersion + 1) {
        throw new Error('Collection revision delta did not match its metadata edit');
      }
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', resourceVersion,
        serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'collection.create') {
      const existing = database.prepare('SELECT id FROM collections WHERE sync_uid = ?')
        .get(operation.entityUid) as { id: number } | undefined;
      if (existing !== undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'entity-already-exists',
          detail: 'Collection identity is already in use; refresh the offline copy',
        });
      }
      let parentId: number | null = null;
      let galleryType = operation.payload.galleryType;
      if (operation.payload.parentUid !== null) {
        const parent = database.prepare(`
          SELECT id, kind, parent_id AS parentId, gallery_type AS galleryType
          FROM collections WHERE sync_uid = ?
        `).get(operation.payload.parentUid) as {
          id: number; kind: string; parentId: number | null; galleryType: string | null;
        } | undefined;
        if (parent === undefined) {
          return saveReceipt(database, operation, requestHash, {
            opId: operation.opId, status: 'failed', errorCode: 'entity-not-found',
            detail: 'Parent Collection no longer exists; refresh the offline copy',
          });
        }
        if (operation.payload.kind !== 'entry' || parent.kind !== 'entry' || parent.parentId !== null
          || (galleryType !== null && galleryType !== parent.galleryType)) {
          return saveReceipt(database, operation, requestHash, {
            opId: operation.opId, status: 'failed', errorCode: 'invalid-collection-data',
            detail: 'Nested Collections must be Entry folders one level below a top-level Entry Collection',
          });
        }
        parentId = parent.id;
        galleryType = parent.galleryType;
      }
      const maxOrder = Number(database.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) FROM collections
        WHERE kind = ? AND parent_id IS ?
      `).pluck().get(operation.payload.kind, parentId));
      const inserted = database.prepare(`
        INSERT INTO collections (
          kind, title, description, nsfw, parent_id, sort_order, gallery_type, sync_uid
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.payload.kind,
        operation.payload.title.trim(),
        operation.payload.description.trim(),
        operation.payload.nsfw ? 1 : 0,
        parentId,
        maxOrder + 1,
        galleryType,
        operation.entityUid,
      );
      const collectionId = Number(inserted.lastInsertRowid);
      const resourceVersion = Number(database.prepare(
        'SELECT sync_version FROM collections WHERE id = ?',
      ).pluck().get(collectionId));
      if (resourceVersion !== 1) throw new Error('new Collection must start at revision 1');
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', resourceVersion,
        serverSeq: maxServerSeq(database), entityId: collectionId,
      });
    }

    if (operation.operationKind === 'gallery.order.set') {
      const scope = database.prepare('SELECT sync_version AS version FROM gallery_order_scope WHERE sync_uid=?').get(operation.entityUid) as { version: number };
      const orderedTypes = database.prepare(`SELECT e.type FROM entries e LEFT JOIN gallery_order o ON o.entry_type=e.type
        GROUP BY e.type ORDER BY CASE WHEN o.sort_order IS NULL THEN 1 ELSE 0 END, o.sort_order, e.type COLLATE NOCASE`).pluck().all() as string[];
      const currentValues = { orderedTypes };
      if (scope.version !== operation.baseVersion || !valuesMatch(currentValues, operation.baseValues)) {
        return saveReceipt(database, operation, requestHash, { opId: operation.opId, status: 'conflict',
          currentVersion: scope.version, currentValues, serverSeq: maxServerSeq(database) });
      }
      setGalleryOrder(database, operation.payload.orderedTypes);
      return saveReceipt(database, operation, requestHash, { opId: operation.opId, status: 'applied',
        resourceVersion: scope.version + 1, serverSeq: maxServerSeq(database) });
    }

    if (operation.operationKind === 'collection.order.set') {
      const readOrder = () => database.prepare(`
        SELECT sync_uid AS syncUid, sync_version AS syncVersion, sort_order AS sortOrder
        FROM collections WHERE kind = ? AND parent_id IS NULL ORDER BY sort_order, id
      `).all(operation.payload.kind) as Array<{
        syncUid: string | null; syncVersion: number; sortOrder: number;
      }>;
      const currentRows = readOrder();
      if (currentRows.some((row) => row.syncUid === null)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-collection-data',
          detail: 'A top-level Collection is missing its stable identity; refresh the offline copy',
        });
      }
      const currentValues = {
        kind: operation.payload.kind,
        collections: currentRows.map((row) => ({
          syncUid: row.syncUid!, syncVersion: row.syncVersion, sortOrder: row.sortOrder,
        })),
      };
      const currentVersion = currentValues.collections.reduce((sum, row) => sum + row.syncVersion, 0);
      const baseByUid = new Map(operation.baseValues.collections.map((row) => [row.syncUid, row]));
      const expectedAfter = {
        kind: operation.payload.kind,
        collections: operation.payload.orderedCollectionUids.map((syncUid, sortOrder) => {
          const base = baseByUid.get(syncUid);
          if (base === undefined) throw new Error('validated reorder omitted a base Collection');
          const changed = base.sortOrder !== sortOrder;
          return { syncUid, syncVersion: base.syncVersion + (changed ? 1 : 0), sortOrder };
        }),
      };
      if (valuesMatch(currentValues, expectedAfter)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'applied', resourceVersion: currentVersion,
          serverSeq: maxServerSeq(database),
        });
      }
      if (currentVersion !== operation.baseVersion || !valuesMatch(currentValues, operation.baseValues)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'conflict', currentVersion,
          currentValues, serverSeq: maxServerSeq(database),
        });
      }
      const updateSortOrder = database.prepare(
        'UPDATE collections SET sort_order = ? WHERE sync_uid = ?',
      );
      for (const [sortOrder, syncUid] of operation.payload.orderedCollectionUids.entries()) {
        const base = baseByUid.get(syncUid);
        if (base === undefined) throw new Error('validated reorder omitted a base Collection');
        if (base.sortOrder !== sortOrder) updateSortOrder.run(sortOrder, syncUid);
      }
      const updatedValues = {
        kind: operation.payload.kind,
        collections: readOrder().map((row) => ({
          syncUid: row.syncUid!, syncVersion: row.syncVersion, sortOrder: row.sortOrder,
        })),
      };
      const updatedVersion = updatedValues.collections.reduce((sum, row) => sum + row.syncVersion, 0);
      if (!valuesMatch(updatedValues, expectedAfter)) {
        throw new Error('Collection order revision vector did not match the reordered scope');
      }
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', resourceVersion: updatedVersion,
        serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'collection.entry.set') {
      const collection = database.prepare(`
        SELECT id, kind, sync_version AS syncVersion
        FROM collections WHERE sync_uid = ?
      `).get(operation.entityUid) as { id: number; kind: string; syncVersion: number } | undefined;
      if (collection === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'entity-not-found',
          detail: 'Collection no longer exists; refresh the offline copy',
        });
      }
      if (collection.kind !== 'entry') {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-collection-data',
          detail: 'Collection does not accept Entry members',
        });
      }
      const entry = database.prepare('SELECT id FROM entries WHERE sync_uid = ?')
        .get(operation.payload.entryUid) as { id: number } | undefined;
      if (entry === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'entity-not-found',
          detail: 'Entry no longer exists; refresh the offline copy',
        });
      }
      const present = database.prepare(`
        SELECT 1 FROM collection_entries WHERE collection_id = ? AND entry_id = ?
      `).get(collection.id, entry.id) !== undefined;
      if (present === operation.payload.present) {
        database.prepare('UPDATE collections SET sync_version = sync_version + 1 WHERE id = ?')
          .run(collection.id);
        const resourceVersion = Number(database.prepare(
          'SELECT sync_version FROM collections WHERE id = ?',
        ).pluck().get(collection.id));
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'applied', resourceVersion,
          serverSeq: maxServerSeq(database),
        });
      }
      if (collection.syncVersion < operation.baseVersion || present !== operation.baseValues.present) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'conflict', currentVersion: collection.syncVersion,
          currentValues: { present }, serverSeq: maxServerSeq(database),
        });
      }
      if (operation.payload.present) {
        database.prepare(`
          INSERT INTO collection_entries (collection_id, entry_id) VALUES (?, ?)
        `).run(collection.id, entry.id);
      } else {
        database.prepare(`
          DELETE FROM collection_entries WHERE collection_id = ? AND entry_id = ?
        `).run(collection.id, entry.id);
      }
      const resourceVersion = Number(database.prepare(
        'SELECT sync_version FROM collections WHERE id = ?',
      ).pluck().get(collection.id));
      if (resourceVersion !== collection.syncVersion + 1) {
        throw new Error('Collection revision delta did not match the Entry membership change');
      }
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', resourceVersion,
        serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'collection.producer.set') {
      const collection = database.prepare(`
        SELECT id, kind, sync_version AS syncVersion
        FROM collections WHERE sync_uid = ?
      `).get(operation.entityUid) as { id: number; kind: string; syncVersion: number } | undefined;
      if (collection === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'entity-not-found',
          detail: 'Collection no longer exists; refresh the offline copy',
        });
      }
      if (collection.kind !== 'producer') {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-author-data',
          detail: 'Collection does not accept Author members',
        });
      }
      const producer = database.prepare(
        'SELECT id FROM producers WHERE sync_uid = ?',
      ).get(operation.payload.producerUid) as { id: number } | undefined;
      if (producer === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'entity-not-found',
          detail: 'Author no longer exists; refresh the offline copy',
        });
      }
      const present = database.prepare(`
        SELECT 1 FROM collection_producers WHERE collection_id = ? AND producer_id = ?
      `).get(collection.id, producer.id) !== undefined;
      if (present === operation.payload.present) {
        database.prepare('UPDATE collections SET sync_version = sync_version + 1 WHERE id = ?')
          .run(collection.id);
        const resourceVersion = Number(database.prepare(
          'SELECT sync_version FROM collections WHERE id = ?',
        ).pluck().get(collection.id));
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'applied', resourceVersion,
          serverSeq: maxServerSeq(database),
        });
      }
      if (collection.syncVersion < operation.baseVersion || present !== operation.baseValues.present) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'conflict', currentVersion: collection.syncVersion,
          currentValues: { present }, serverSeq: maxServerSeq(database),
        });
      }
      if (operation.payload.present) {
        database.prepare(`
          INSERT INTO collection_producers (collection_id, producer_id) VALUES (?, ?)
        `).run(collection.id, producer.id);
      } else {
        database.prepare(`
          DELETE FROM collection_producers WHERE collection_id = ? AND producer_id = ?
        `).run(collection.id, producer.id);
      }
      const resourceVersion = Number(database.prepare(
        'SELECT sync_version FROM collections WHERE id = ?',
      ).pluck().get(collection.id));
      if (resourceVersion !== collection.syncVersion + 1) {
        throw new Error('Collection revision delta did not match the membership change');
      }
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', resourceVersion,
        serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'author.directories.set') {
      const directorySet = database.prepare(`
        SELECT id, producer_id AS producerId, sync_version AS syncVersion
        FROM author_directory_sets WHERE sync_uid = ?
      `).get(operation.entityUid) as { id: number; producerId: number; syncVersion: number } | undefined;
      if (directorySet === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'entity-not-found',
          detail: 'Author Directory set no longer exists; refresh the offline copy',
        });
      }
      const producerId = directorySet.producerId;
      for (const dependency of operation.payload.producerCreates ?? []) {
        const origin = database.prepare(`SELECT origin.producer_id AS producerId, receipt.result_json AS resultJson
          FROM sync_offline_created_producers AS origin
          JOIN producers AS producer ON producer.id=origin.producer_id AND producer.sync_uid=origin.producer_uid COLLATE NOCASE
          JOIN sync_operation_receipts AS receipt ON receipt.op_id=origin.create_op_id COLLATE NOCASE
          WHERE origin.producer_uid=? COLLATE NOCASE AND origin.create_op_id=? COLLATE NOCASE AND origin.client_id=? AND origin.library_id=? AND origin.sync_epoch=? AND producer.directory_set_seed_uid=? COLLATE NOCASE`)
          .get(dependency.producerUid,dependency.createOpId,operation.clientId,operation.libraryId,operation.syncEpoch,operation.entityUid) as {producerId:number;resultJson:string}|undefined;
        const receipt = origin ? syncReplayResultSchema.parse(JSON.parse(origin.resultJson)) : undefined;
        if (!origin || origin.producerId!==producerId || receipt?.status!=='applied' || receipt.opId.toLowerCase()!==dependency.createOpId.toLowerCase() || receipt.entityId!==producerId) return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'failed',errorCode:'entity-not-found',detail:'Directory creation origin is missing or foreign'});
      }
      const currentDirectories = producerDirectoryState(database, producerId);
      const currentValues = { directories: currentDirectories };
      const expectedDelta = expectedProducerDirectoryDelta(
        operation.baseValues.directories,
        operation.payload.directories,
      );
      if (valuesMatch(currentValues, operation.payload)) {
        for (let index = 0; index < expectedDelta; index += 1) {
          database.prepare('UPDATE author_directory_sets SET sync_version = sync_version + 1 WHERE id = ?')
            .run(directorySet.id);
        }
        const resourceVersion = Number(database.prepare(
          'SELECT sync_version FROM author_directory_sets WHERE id = ?',
        ).pluck().get(directorySet.id));
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'applied', resourceVersion,
          serverSeq: maxServerSeq(database),
        });
      }
      if (directorySet.syncVersion < operation.baseVersion || !valuesMatch(currentValues, operation.baseValues)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'conflict', currentVersion: directorySet.syncVersion,
          currentValues, serverSeq: maxServerSeq(database),
        });
      }

      const currentDirectoryIds = new Map((database.prepare(`
        SELECT id, sync_uid AS syncUid FROM author_directories WHERE producer_id = ?
      `).all(producerId) as Array<{ id: number; syncUid: string }>).map((row) => [row.syncUid, row.id]));
      for (const directory of operation.payload.directories) {
        if (!currentDirectoryIds.has(directory.syncUid)) {
          const elsewhere = database.prepare(
            'SELECT 1 FROM author_directories WHERE sync_uid = ?',
          ).get(directory.syncUid);
          if (elsewhere !== undefined) {
            return saveReceipt(database, operation, requestHash, {
              opId: operation.opId, status: 'failed', errorCode: 'invalid-author-data',
              detail: 'Directory identity already belongs to another Author',
            });
          }
        }
        for (const entry of directory.entries) {
          if (!database.prepare(`
            SELECT 1 FROM entries AS entry
            JOIN entry_producers AS relation ON relation.entry_id = entry.id
            WHERE entry.sync_uid = ? AND relation.producer_id = ?
          `).get(entry.syncUid, producerId)) {
            return saveReceipt(database, operation, requestHash, {
              opId: operation.opId, status: 'failed', errorCode: 'invalid-author-data',
              detail: `Entry ${entry.syncUid} is not linked to this Author`,
            });
          }
        }
      }
      const baseDirectoryUids = new Set(operation.baseValues.directories.map((directory) => directory.syncUid));
      for (const directory of operation.payload.directories) {
        const id = currentDirectoryIds.get(directory.syncUid);
        if (id === undefined) {
          if (baseDirectoryUids.has(directory.syncUid)) {
            return saveReceipt(database, operation, requestHash, {
              opId: operation.opId, status: 'conflict', currentVersion: directorySet.syncVersion,
              currentValues, serverSeq: maxServerSeq(database),
            });
          }
          database.prepare(`
            INSERT INTO author_directories (producer_id, sync_uid, title, description, sort_order)
            VALUES (?, ?, ?, ?, ?)
          `).run(producerId, directory.syncUid, directory.title, directory.description, directory.sortOrder);
        } else {
          const previous = operation.baseValues.directories.find((item) => item.syncUid === directory.syncUid);
          if (previous !== undefined && (
            previous.title !== directory.title || previous.description !== directory.description
            || previous.sortOrder !== directory.sortOrder
          )) {
            database.prepare(`
              UPDATE author_directories SET title = ?, description = ?, sort_order = ? WHERE id = ?
            `).run(directory.title, directory.description, directory.sortOrder, id);
          }
        }
      }

      const currentMemberships = database.prepare(`
        SELECT directory.sync_uid AS directoryUid, entry.sync_uid AS entryUid,
               membership.sort_order AS sortOrder, membership.directory_id AS directoryId,
               membership.entry_id AS entryId
        FROM author_directory_entries AS membership
        JOIN author_directories AS directory ON directory.id = membership.directory_id
        JOIN entries AS entry ON entry.id = membership.entry_id
        WHERE membership.producer_id = ?
      `).all(producerId) as Array<{
        directoryUid: string; entryUid: string; sortOrder: number; directoryId: number; entryId: number;
      }>;
      const desiredMemberships = new Map<string, { directoryUid: string; sortOrder: number }>();
      for (const directory of operation.payload.directories) {
        for (const entry of directory.entries) {
          desiredMemberships.set(entry.syncUid, { directoryUid: directory.syncUid, sortOrder: entry.sortOrder });
        }
      }
      const currentByEntry = new Map(currentMemberships.map((membership) => [membership.entryUid, membership]));
      for (const current of currentMemberships) {
        const desired = desiredMemberships.get(current.entryUid);
        if (desired === undefined || desired.directoryUid !== current.directoryUid) {
          database.prepare(`
            DELETE FROM author_directory_entries
            WHERE directory_id = ? AND producer_id = ? AND entry_id = ?
          `).run(current.directoryId, producerId, current.entryId);
        } else if (desired.sortOrder !== current.sortOrder) {
          database.prepare(`
            UPDATE author_directory_entries SET sort_order = ?
            WHERE directory_id = ? AND producer_id = ? AND entry_id = ?
          `).run(desired.sortOrder, current.directoryId, producerId, current.entryId);
        }
      }
      for (const directory of operation.payload.directories) {
        const directoryId = currentDirectoryIds.get(directory.syncUid)
          ?? Number(database.prepare('SELECT id FROM author_directories WHERE sync_uid = ?')
            .pluck().get(directory.syncUid));
        for (const entry of directory.entries) {
          const current = currentByEntry.get(entry.syncUid);
          if (current === undefined || current.directoryUid !== directory.syncUid) {
            const entryId = Number(database.prepare('SELECT id FROM entries WHERE sync_uid = ?')
              .pluck().get(entry.syncUid));
            database.prepare(`
              INSERT INTO author_directory_entries (directory_id, producer_id, entry_id, sort_order)
              VALUES (?, ?, ?, ?)
            `).run(directoryId, producerId, entryId, entry.sortOrder);
          }
        }
      }
      const resourceVersion = Number(database.prepare(
        'SELECT sync_version FROM author_directory_sets WHERE id = ?',
      ).pluck().get(directorySet.id));
      if (resourceVersion !== directorySet.syncVersion + expectedDelta) {
        throw new Error(`Author Directory revision delta mismatch: expected ${expectedDelta}, got ${resourceVersion - directorySet.syncVersion}`);
      }
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', resourceVersion,
        serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'entry.create') {
      const existingId = database.prepare('SELECT id FROM entries WHERE sync_uid = ?')
        .pluck().get(operation.entityUid) as number | undefined;
      // A matching online claim is the only proof that an existing Entry belongs
      // to this offline fallback. A matching title alone is never sufficient.
      const claim = existingId === undefined ? undefined : database.prepare(`
        SELECT claim.request_hash AS requestHash, claim.adopted_op_id AS adoptedOpId,
          claim.entry_version AS entryVersion, entry.sync_version AS currentVersion
        FROM sync_online_entry_creates AS claim
        JOIN entries AS entry ON entry.sync_uid = claim.entry_uid
        WHERE claim.entry_uid = ?
      `).get(operation.entityUid) as {
        requestHash: string; adoptedOpId: string | null; entryVersion: number; currentVersion: number;
      } | undefined;
      const tombstoned = database.prepare(`
        SELECT 1 FROM sync_tombstones WHERE entity_kind = 'entry' AND entity_uid = ?
      `).get(operation.entityUid) !== undefined;
      if (tombstoned || (existingId !== undefined && (claim === undefined || claim.adoptedOpId !== null
        || claim.entryVersion !== claim.currentVersion
        || claim.requestHash !== onlineEntryCreateHash(operation.payload)))) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'failed',
          errorCode: 'entity-already-exists',
          detail: 'Entry sync identity already exists without a matching unused online creation claim',
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
      for (const content of operation.payload.contents ?? []) {
        if (database.prepare('SELECT 1 FROM entry_contents WHERE sync_uid = ?').get(content.syncUid)) {
          return saveReceipt(database, operation, requestHash, {
            opId: operation.opId,
            status: 'failed',
            errorCode: 'invalid-content',
            detail: 'Content identity belongs to another Entry',
          });
        }
      }
      const entryId = existingId ?? createEntry(database, {
        title: operation.payload.title,
        type: operation.payload.type,
        syncUid: operation.entityUid,
        uploadDate: operation.payload.uploadDate,
        pageCount: operation.payload.pageCount,
        ...(operation.payload.durationSeconds !== undefined ? { durationSeconds: operation.payload.durationSeconds } : {}),
      }).id;
      if (existingId !== undefined) {
        database.prepare(`
          UPDATE sync_online_entry_creates SET adopted_op_id = ?
          WHERE entry_uid = ? AND adopted_op_id IS NULL
        `).run(operation.opId, operation.entityUid);
      }
      for (const content of operation.payload.contents ?? []) {
        database.prepare(`
          INSERT INTO entry_contents (entry_id, sync_uid, content_type, content, sort_order)
          VALUES (?, ?, ?, ?, ?)
        `).run(entryId, content.syncUid, content.contentType, content.content, content.sortOrder);
      }
      for (const rating of operation.payload.ratings) {
        const slotId = rating.slotUid === undefined
          ? rating.slotId!
          : Number(database.prepare('SELECT id FROM rating_slots WHERE sync_uid = ?').pluck().get(rating.slotUid));
        setEntryRating(database, { entryId, slotId, stars: rating.stars }, { touchEntry: false });
      }
      if (operation.payload.viewLater) addViewLaterEntry(database, entryId, false);
      const resourceVersion = Number(database.prepare(
        'SELECT sync_version FROM entries WHERE id = ?',
      ).pluck().get(entryId));
      const result: SyncReplayResult = {
        opId: operation.opId,
        status: 'applied',
        entityId: entryId,
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

    if (operation.operationKind === 'entry.content.append') {
      if (!OFFLINE_ENTRY_CONTENT_APPEND_ENABLED) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-content', detail: 'Content append capability is unavailable',
        });
      }
      const parent = database.prepare(`
        SELECT receipt.result_json AS resultJson, entry.id AS entryId,
               entry.sync_version AS syncVersion
        FROM sync_offline_created_entries AS created
        JOIN entries AS entry ON entry.sync_uid = created.entry_uid
        JOIN sync_operation_receipts AS receipt ON receipt.op_id = created.create_op_id
        WHERE created.entry_uid = ? AND created.create_op_id = ?
      `).get(operation.entityUid, operation.payload.parentCreateOpId) as {
        resultJson: string; entryId: number; syncVersion: number;
      } | undefined;
      // An absent receipt can mean the create is still queued: leave this operation
      // unreceipted so it remains retryable once its immutable parent succeeds.
      if (parent === undefined) {
        return { opId: operation.opId, status: 'failed', errorCode: 'entity-not-found', detail: 'Parent create receipt is not available yet' };
      }
      const createResult = syncReplayResultSchema.parse(JSON.parse(parent.resultJson));
      if (createResult.status !== 'applied' || createResult.entityId !== parent.entryId) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-content', detail: 'Parent create identity does not match its receipt',
        });
      }
      const content = operation.payload.content;
      const existing = database.prepare('SELECT entry_id AS entryId FROM entry_contents WHERE sync_uid = ?')
        .get(content.syncUid) as { entryId: number } | undefined;
      if (existing !== undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'conflict', currentVersion: parent.syncVersion,
          currentValues: { contents: [] }, serverSeq: maxServerSeq(database),
        });
      }
      const sortOrder = Number(database.prepare(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 FROM entry_contents WHERE entry_id = ?',
      ).pluck().get(parent.entryId));
      database.prepare(`
        INSERT INTO entry_contents (entry_id, sync_uid, content_type, content, sort_order)
        VALUES (?, ?, ?, ?, ?)
      `).run(parent.entryId, content.syncUid, content.contentType, content.content, sortOrder);
      // Content insert journals its own row; the Entry owner revision and journal
      // advance once as for the existing full-list Content mutation.
      database.prepare('UPDATE entries SET updated_at = updated_at WHERE id = ?').run(parent.entryId);
      const resourceVersion = Number(database.prepare(
        'SELECT sync_version FROM entries WHERE id = ?',
      ).pluck().get(parent.entryId));
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', entityId: parent.entryId,
        resourceVersion, serverSeq: maxServerSeq(database),
      });
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

    if (operation.operationKind === 'entry.contents.set') {
      const pending = operation.baseVersion === 0;
      if (pending) {
        const parent = database.prepare(`
          SELECT receipt.result_json AS resultJson, entry.id AS entryId
          FROM sync_offline_created_entries AS created
          JOIN entries AS entry ON entry.sync_uid = created.entry_uid
          JOIN sync_operation_receipts AS receipt ON receipt.op_id = created.create_op_id
          WHERE created.entry_uid = ? AND created.create_op_id = ?
        `).get(operation.entityUid, operation.payload.parentCreateOpId) as { resultJson: string; entryId: number } | undefined;
        if (parent === undefined) return { opId: operation.opId, status: 'failed', errorCode: 'entity-not-found', detail: 'Parent create receipt is not available yet' };
        const result = syncReplayResultSchema.parse(JSON.parse(parent.resultJson));
        if (result.status !== 'applied' || result.entityId !== parent.entryId) return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-content', detail: 'Parent create identity does not match its receipt',
        });
      }
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
      const readContents = (): Array<{
        syncUid: string; contentType: string; content: string; sortOrder: number;
      }> => database.prepare(`
        SELECT sync_uid AS syncUid, content_type AS contentType,
               content, sort_order AS sortOrder
        FROM entry_contents WHERE entry_id = ?
        ORDER BY sort_order, id
      `).all(entry.id) as Array<{
        syncUid: string; contentType: string; content: string; sortOrder: number;
      }>;
      const currentContents = readContents();
      if (pending && operation.payload.contents.some(content => !operation.baseValues.contents.some(base => base.syncUid === content.syncUid))) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-content', detail: 'Pending Content may only replace or remove captured rows',
        });
      }
      const currentValues = { contents: currentContents };
      if (valuesMatch(currentValues, { contents: operation.payload.contents })) {
        if (pending) return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'applied', entityId: entry.id,
          resourceVersion: entry.syncVersion, serverSeq: maxServerSeq(database),
        });
        // Even a convergent no-op consumes one predicted Entry revision
        // later operation in this Outbox chain keeps its expected base version.
        database.prepare('UPDATE entries SET updated_at = updated_at WHERE id = ?').run(entry.id);
        const resourceVersion = Number(database.prepare(
          'SELECT sync_version FROM entries WHERE id = ?',
        ).pluck().get(entry.id));
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'applied', ...(operation.baseVersion === 0 ? { entityId: entry.id } : {}),
          resourceVersion,
          serverSeq: maxServerSeq(database),
        });
      }
      if (entry.syncVersion < operation.baseVersion
        || !valuesMatch(currentValues, operation.baseValues)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId,
          status: 'conflict',
          currentVersion: entry.syncVersion,
          currentValues,
          serverSeq: maxServerSeq(database),
        });
      }

      const currentByUid = new Map(currentContents.map((content) => [content.syncUid, content]));
      for (const desired of operation.payload.contents) {
        const existing = database.prepare(`
          SELECT entry_id AS entryId FROM entry_contents WHERE sync_uid = ?
        `).get(desired.syncUid) as { entryId: number } | undefined;
        if (existing !== undefined && existing.entryId !== entry.id) {
          return saveReceipt(database, operation, requestHash, {
            opId: operation.opId,
            status: 'failed',
            errorCode: 'invalid-content',
            detail: 'Content identity belongs to a different Entry',
          });
        }
      }
      const desiredUids = new Set(operation.payload.contents.map((content) => content.syncUid));
      for (const existing of currentContents) {
        if (!desiredUids.has(existing.syncUid)) {
          database.prepare('DELETE FROM entry_contents WHERE sync_uid = ?').run(existing.syncUid);
        }
      }
      for (const desired of operation.payload.contents) {
        const existing = currentByUid.get(desired.syncUid);
        if (existing === undefined) {
          database.prepare(`
            INSERT INTO entry_contents (entry_id, sync_uid, content_type, content, sort_order)
            VALUES (?, ?, ?, ?, ?)
          `).run(entry.id, desired.syncUid, desired.contentType, desired.content, desired.sortOrder);
        } else if (!valuesMatch(existing, desired)) {
          database.prepare(`
            UPDATE entry_contents
            SET content_type = ?, content = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
            WHERE sync_uid = ? AND entry_id = ?
          `).run(desired.contentType, desired.content, desired.sortOrder, desired.syncUid, entry.id);
        }
      }
      database.prepare('UPDATE entries SET updated_at = updated_at WHERE id = ?').run(entry.id);
      const resourceVersion = Number(database.prepare(
        'SELECT sync_version FROM entries WHERE id = ?',
      ).pluck().get(entry.id));
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId,
        status: 'applied', ...(operation.baseVersion === 0 ? { entityId: entry.id } : {}),
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

    if (operation.operationKind === 'entry.tag.create') {
      const typedName = operation.payload.name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
      const canonicalName = resolveTaxonomyName(database, 'entry', typedName)
        .normalize('NFKC').trim().replace(/\s+/gu, ' ');
      const normalized = normalizeTag(canonicalName);
      if (!normalized) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'failed', errorCode: 'invalid-tag-data', detail: 'Tag name is empty after normalization',
      });
      const uidCollision = database.prepare(`
        SELECT id, normalized_name AS normalizedName FROM tags WHERE sync_uid = ? COLLATE NOCASE
      `).get(operation.entityUid) as { id: number; normalizedName: string } | undefined;
      if (uidCollision !== undefined && uidCollision.normalizedName !== normalized) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'conflict', currentVersion: 1,
          currentValues: { name: database.prepare('SELECT name FROM tags WHERE id = ?').pluck().get(uidCollision.id) as string },
          serverSeq: maxServerSeq(database),
        });
      }
      let tagId = uidCollision?.id;
      if (tagId === undefined) {
        const existing = database.prepare('SELECT id FROM tags WHERE normalized_name = ?')
          .get(normalized) as { id: number } | undefined;
        tagId = existing?.id;
      }
      if (tagId === undefined) {
        tagId = Number(database.prepare(`
          INSERT INTO tags (name, normalized_name, sync_uid) VALUES (?, ?, ?)
        `).run(canonicalName, normalized, operation.entityUid).lastInsertRowid);
      }
      database.prepare(`
        INSERT INTO sync_offline_created_entry_tags
          (tag_uid, tag_id, create_op_id, client_id, library_id, sync_epoch)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(operation.entityUid, tagId, operation.opId, operation.clientId, operation.libraryId, operation.syncEpoch);
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', entityId: tagId,
        resourceVersion: 1, serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'entry.facet.create') {
      const name = operation.payload.name.trim();
      const section = database.prepare(`
        SELECT id, entry_type AS entryType FROM tag_groups
        WHERE sync_uid = ? COLLATE NOCASE AND group_kind = 'section'
      `).get(operation.payload.sectionUid) as { id: number; entryType: string } | undefined;
      if (section === undefined || section.entryType !== operation.payload.entryType) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-tag-data',
          detail: 'Facet Section is unavailable or belongs to another Entry type',
        });
      }
      const layout = database.prepare(`
        SELECT sync_version AS syncVersion FROM entry_tag_layouts WHERE entry_type = ?
      `).get(operation.payload.entryType) as { syncVersion: number } | undefined;
      if (layout === undefined) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'failed', errorCode: 'invalid-tag-data', detail: 'Entry Tag layout is unavailable',
      });
      // This operation inserts one child, never replaces a captured layout.
      // A newer shared revision therefore merges disjoint insertions/reorders;
      // a revision from the future cannot describe this library generation.
      if (operation.baseVersion > layout.syncVersion) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'conflict', currentVersion: layout.syncVersion,
        currentValues: {}, serverSeq: maxServerSeq(database),
      });
      const uidCollision = database.prepare(`
        SELECT id, parent_id AS sectionId, entry_type AS entryType, name
        FROM tag_groups WHERE sync_uid = ? COLLATE NOCASE
      `).get(operation.entityUid) as { id: number; sectionId: number | null; entryType: string; name: string } | undefined;
      if (uidCollision !== undefined
        && (uidCollision.sectionId !== section.id || uidCollision.entryType !== section.entryType || uidCollision.name !== name)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'conflict', currentVersion: layout.syncVersion,
          currentValues: { name: uidCollision.name }, serverSeq: maxServerSeq(database),
        });
      }
      let facetId = uidCollision?.id;
      if (facetId === undefined) {
        const existing = database.prepare(`
          SELECT id FROM tag_groups
          WHERE parent_id = ? AND group_kind = 'facet' AND name = ?
        `).get(section.id, name) as { id: number } | undefined;
        facetId = existing?.id;
      }
      if (facetId === undefined) {
        facetId = Number(database.prepare(`
          INSERT INTO tag_groups (entry_type, name, group_kind, parent_id, sort_order, sync_uid)
          VALUES (?, ?, 'facet', ?, 0, ?)
        `).run(section.entryType, name, section.id, operation.entityUid).lastInsertRowid);
      }
      database.prepare(`
        INSERT INTO sync_offline_created_entry_facets
          (facet_uid, facet_id, entry_type, create_op_id, client_id, library_id, sync_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(operation.entityUid, facetId, section.entryType, operation.opId,
        operation.clientId, operation.libraryId, operation.syncEpoch);
      const resourceVersion = Number(database.prepare(`
        SELECT sync_version FROM entry_tag_layouts WHERE entry_type = ?
      `).pluck().get(section.entryType));
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', entityId: facetId,
        resourceVersion, serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'entry.tags.set') {
      const createdTagIds = new Map<string, number>();
      for (const dependency of operation.payload.tagCreates ?? []) {
        const origin = database.prepare(`
          SELECT origin.tag_id AS tagId, receipt.result_json AS resultJson
          FROM sync_offline_created_entry_tags AS origin
          JOIN tags AS tag ON tag.id = origin.tag_id
          JOIN sync_operation_receipts AS receipt ON receipt.op_id = origin.create_op_id COLLATE NOCASE
          WHERE origin.tag_uid = ? COLLATE NOCASE AND origin.create_op_id = ? COLLATE NOCASE
            AND origin.client_id = ? AND origin.library_id = ? AND origin.sync_epoch = ?
        `).get(dependency.tagUid, dependency.createOpId, operation.clientId,
          operation.libraryId, operation.syncEpoch) as { tagId: number; resultJson: string } | undefined;
        if (origin === undefined) return {
          opId: operation.opId, status: 'failed', errorCode: 'entity-not-found',
          detail: 'Entry Tag creation dependency is unavailable',
        };
        const receipt = syncReplayResultSchema.parse(JSON.parse(origin.resultJson));
        if (receipt.status !== 'applied' || receipt.opId.toLowerCase() !== dependency.createOpId.toLowerCase()
          || receipt.entityId !== origin.tagId) return {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-tag-data',
          detail: 'Entry Tag creation receipt identity mismatch',
        };
        createdTagIds.set(dependency.tagUid.toLowerCase(), origin.tagId);
      }
      const createdFacetIds = new Map<string, number>();
      for (const dependency of operation.payload.facetCreates ?? []) {
        const origin = database.prepare(`
          SELECT origin.facet_id AS facetId, receipt.result_json AS resultJson
          FROM sync_offline_created_entry_facets AS origin
          JOIN tag_groups AS facet ON facet.id = origin.facet_id AND facet.group_kind = 'facet' AND facet.entry_type = origin.entry_type
          JOIN sync_operation_receipts AS receipt ON receipt.op_id = origin.create_op_id COLLATE NOCASE
          WHERE origin.facet_uid = ? COLLATE NOCASE AND origin.create_op_id = ? COLLATE NOCASE
            AND origin.client_id = ? AND origin.library_id = ? AND origin.sync_epoch = ?
        `).get(dependency.facetUid, dependency.createOpId, operation.clientId,
          operation.libraryId, operation.syncEpoch) as { facetId: number; resultJson: string } | undefined;
        if (origin === undefined) return {
          opId: operation.opId, status: 'failed', errorCode: 'entity-not-found',
          detail: 'Facet creation dependency is unavailable',
        };
        const receipt = syncReplayResultSchema.parse(JSON.parse(origin.resultJson));
        if (receipt.status !== 'applied' || receipt.opId.toLowerCase() !== dependency.createOpId.toLowerCase()
          || receipt.entityId !== origin.facetId) return {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-tag-data',
          detail: 'Facet creation receipt identity mismatch',
        };
        createdFacetIds.set(dependency.facetUid.toLowerCase(), origin.facetId);
      }
      const pending = operation.baseVersion === 0;
      if (pending) {
        const parent = database.prepare(`
          SELECT receipt.result_json AS resultJson, entry.id AS entryId
          FROM sync_offline_created_entries AS created
          JOIN entries AS entry ON entry.sync_uid = created.entry_uid
          JOIN sync_operation_receipts AS receipt ON receipt.op_id = created.create_op_id
          WHERE created.entry_uid = ? AND created.create_op_id = ?
        `).get(operation.entityUid, operation.payload.parentCreateOpId) as { resultJson: string; entryId: number } | undefined;
        if (!parent) return {
          opId: operation.opId, status: 'failed', errorCode: 'entity-not-found', detail: 'Parent create receipt is not available yet',
        };
        const createResult = syncReplayResultSchema.parse(JSON.parse(parent.resultJson));
        if (createResult.status !== 'applied' || createResult.entityId !== parent.entryId) return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-tag-data', detail: 'Parent create identity does not match its receipt',
        });
      }
      const entry = database.prepare(`SELECT id, type, sync_version AS syncVersion FROM entries WHERE sync_uid = ?`)
        .get(operation.entityUid) as { id: number; type: string; syncVersion: number } | undefined;
      if (!entry) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'failed', errorCode: 'entity-not-found', detail: 'Entry no longer exists',
      });
      const currentValues = { tags: entryTagsForOwner(database, entry.id) };
      const base = canonicalEntryTags(database, operation.baseValues.tags, createdTagIds, createdFacetIds);
      const desired = canonicalEntryTags(database, operation.payload.tags, createdTagIds, createdFacetIds);
      if (base === null || desired === null) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'failed', errorCode: 'invalid-tag-data', detail: 'Duplicate or empty normalized Entry Tag identity',
      });
      // Validate the entire desired set before creating a single tag or changing an assignment.
      for (const tag of desired) {
        if (pending && !database.prepare('SELECT 1 FROM tags WHERE normalized_name = ?').get(normalizeTag(tag.name))) return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-tag-data', detail: 'Pending Entry Tags must use existing vocabulary',
        });
        const facet = database.prepare(`SELECT 1 FROM tag_groups WHERE id = ? AND group_kind = 'facet' AND entry_type = ?`)
          .get(tag.facetId, entry.type);
        if (!facet) return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-tag-data', detail: `Facet ${tag.facetId} does not belong to this Entry type`,
        });
      }
      if (valuesMatch(currentValues, { tags: desired })) {
        const previous = new Map(base.map((tag) => [normalizeTag(tag.name), tag.facetId]));
        const next = new Map(desired.map((tag) => [normalizeTag(tag.name), tag.facetId]));
        const delta = [...previous].filter(([name, facetId]) => !next.has(name) || next.get(name) !== facetId).length
          + [...next.keys()].filter((name) => !previous.has(name)).length;
        for (let version = entry.syncVersion; !pending && version < operation.baseVersion + delta; version += 1) {
          database.prepare('UPDATE entries SET updated_at = updated_at WHERE id = ?').run(entry.id);
        }
        const resourceVersion = Number(database.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id));
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'applied', ...(pending ? { entityId: entry.id } : {}), resourceVersion, serverSeq: maxServerSeq(database),
        });
      }
      if (entry.syncVersion < operation.baseVersion || !valuesMatch(currentValues, { tags: base })) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'conflict', currentVersion: entry.syncVersion,
          currentValues, serverSeq: maxServerSeq(database),
        });
      }
      const desiredNames = new Set(desired.map((tag) => normalizeTag(tag.name)));
      for (const tag of currentValues.tags) {
        if (!desiredNames.has(normalizeTag(tag.name))) database.prepare(`
          DELETE FROM entry_tags WHERE entry_id = ? AND tag_id = (SELECT id FROM tags WHERE normalized_name = ?)
        `).run(entry.id, normalizeTag(tag.name));
      }
      for (const tag of desired) {
        const normalized = normalizeTag(tag.name);
        database.prepare(`INSERT INTO tags (name, normalized_name) VALUES (?, ?) ON CONFLICT(normalized_name) DO NOTHING`)
          .run(tag.name, normalized);
        const id = database.prepare('SELECT id FROM tags WHERE normalized_name = ?').pluck().get(normalized) as number;
        const previous = database.prepare('SELECT facet_id FROM entry_tags WHERE entry_id = ? AND tag_id = ?')
          .pluck().get(entry.id, id) as number | undefined;
        if (previous === undefined) database.prepare('INSERT INTO entry_tags (entry_id, tag_id, facet_id) VALUES (?, ?, ?)')
          .run(entry.id, id, tag.facetId);
        else if (previous !== tag.facetId) database.prepare('UPDATE entry_tags SET facet_id = ? WHERE entry_id = ? AND tag_id = ?')
          .run(tag.facetId, entry.id, id);
      }
      const resourceVersion = Number(database.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id));
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', ...(pending ? { entityId: entry.id } : {}), resourceVersion, serverSeq: maxServerSeq(database),
      });
    }

    if (operation.operationKind === 'entry.author.create-and-link') {
      if (operation.payload.parentCreateOpId !== undefined) {
        const parent = database.prepare(`
          SELECT receipt.result_json AS resultJson, entry.id AS entryId
          FROM sync_offline_created_entries AS created
          JOIN entries AS entry ON entry.sync_uid = created.entry_uid COLLATE NOCASE
          JOIN sync_operation_receipts AS receipt ON receipt.op_id = created.create_op_id COLLATE NOCASE
          WHERE created.entry_uid = ? COLLATE NOCASE AND created.create_op_id = ? COLLATE NOCASE
        `).get(operation.entityUid, operation.payload.parentCreateOpId) as { resultJson: string; entryId: number } | undefined;
        if (!parent) return {
          opId: operation.opId, status: 'failed', errorCode: 'entity-not-found', detail: 'Parent create receipt is not available yet',
        };
        const createResult = syncReplayResultSchema.parse(JSON.parse(parent.resultJson));
        if (createResult.status !== 'applied' || createResult.entityId !== parent.entryId) return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-author-data', detail: 'Parent create identity does not match its receipt',
        });
      }
      const entry = database.prepare(`
        SELECT id, sync_version AS syncVersion FROM entries WHERE sync_uid = ? COLLATE NOCASE
      `).get(operation.entityUid) as { id: number; syncVersion: number } | undefined;
      if (entry === undefined) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'failed', errorCode: 'entity-not-found', detail: 'Entry no longer exists',
      });
      const currentValues = { producerUids: entryProducerUids(database, entry.id) };
      const baseValues = { producerUids: operation.baseValues.producerUids.map(uid => uid.toLowerCase()).sort() };
      if (entry.syncVersion < operation.baseVersion || !valuesMatch(currentValues, baseValues)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'conflict', currentVersion: entry.syncVersion,
          currentValues, serverSeq: maxServerSeq(database),
        });
      }
      const name = operation.payload.name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
      const normalized = normalizeTag(name);
      const canonical = resolveTaxonomyName(database, 'producer', name);
      const alreadyNamed = (database.prepare('SELECT name FROM producers').pluck().all() as string[])
        .some((existing) => normalizeTag(existing) === normalized);
      const alreadyUid = database.prepare('SELECT 1 FROM producers WHERE sync_uid = ? COLLATE NOCASE').get(operation.payload.producerUid);
      // Never silently retarget a name typed offline. Alias graph edits or an
      // independently created Author require a fresh explicit selection.
      if (alreadyNamed || alreadyUid || normalizeTag(canonical) !== normalized) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'conflict', currentVersion: entry.syncVersion,
          currentValues, serverSeq: maxServerSeq(database),
        });
      }
      const producerId = Number(database.prepare(`
        INSERT INTO producers (name, sync_uid) VALUES (?, ?)
      `).run(name, operation.payload.producerUid).lastInsertRowid);
      database.prepare('INSERT INTO entry_producers (entry_id, producer_id) VALUES (?, ?)').run(entry.id, producerId);
      database.prepare(`INSERT INTO sync_offline_created_producers (producer_uid, producer_id, create_op_id, client_id, library_id, sync_epoch) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(operation.payload.producerUid, producerId, operation.opId, operation.clientId, operation.libraryId, operation.syncEpoch);
      const resourceVersion = Number(database.prepare('SELECT sync_version FROM entries WHERE id = ?').pluck().get(entry.id));
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', resourceVersion,
        serverSeq: maxServerSeq(database), entityId: producerId,
      });
    }

    if (operation.operationKind === 'entry.authors.set') {
      for (const dependency of operation.payload.producerCreates ?? []) {
        const origin = database.prepare(`SELECT origin.producer_id AS producerId, receipt.result_json AS resultJson
          FROM sync_offline_created_producers AS origin
          JOIN producers AS producer ON producer.sync_uid = origin.producer_uid COLLATE NOCASE AND producer.id = origin.producer_id
          JOIN sync_operation_receipts AS receipt ON receipt.op_id = origin.create_op_id COLLATE NOCASE
          WHERE origin.producer_uid = ? COLLATE NOCASE AND origin.create_op_id = ? COLLATE NOCASE AND origin.client_id = ? AND origin.library_id = ? AND origin.sync_epoch = ?`)
          .get(dependency.producerUid, dependency.createOpId, operation.clientId, operation.libraryId, operation.syncEpoch) as {producerId:number;resultJson:string} | undefined;
        if (!origin) return {opId:operation.opId,status:'failed',errorCode:'entity-not-found',detail:'Producer creation dependency is unavailable'};
        const receipt = syncReplayResultSchema.parse(JSON.parse(origin.resultJson));
        if (receipt.status !== 'applied' || receipt.opId.toLowerCase() !== dependency.createOpId.toLowerCase() || receipt.entityId !== origin.producerId) return {opId:operation.opId,status:'failed',errorCode:'invalid-author-data',detail:'Producer creation receipt identity mismatch'};
      }
      const pending = operation.baseVersion === 0;
      if (pending) {
        const parent = database.prepare(`
          SELECT receipt.result_json AS resultJson, entry.id AS entryId
          FROM sync_offline_created_entries AS created
          JOIN entries AS entry ON entry.sync_uid = created.entry_uid COLLATE NOCASE
          JOIN sync_operation_receipts AS receipt ON receipt.op_id = created.create_op_id COLLATE NOCASE
          WHERE created.entry_uid = ? COLLATE NOCASE AND created.create_op_id = ? COLLATE NOCASE
        `).get(operation.entityUid, operation.payload.parentCreateOpId) as { resultJson: string; entryId: number } | undefined;
        if (!parent) return {
          opId: operation.opId, status: 'failed', errorCode: 'entity-not-found', detail: 'Parent create receipt is not available yet',
        };
        const createResult = syncReplayResultSchema.parse(JSON.parse(parent.resultJson));
        if (createResult.status !== 'applied' || createResult.entityId !== parent.entryId) return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'invalid-author-data', detail: 'Parent create identity does not match its receipt',
        });
      }

      const entry = database.prepare(`
        SELECT id, sync_version AS syncVersion FROM entries WHERE sync_uid = ? COLLATE NOCASE
      `).get(operation.entityUid) as { id: number; syncVersion: number } | undefined;
      if (entry === undefined) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'failed', errorCode: 'entity-not-found',
          detail: 'Entry no longer exists',
        });
      }
      const currentValues = { producerUids: entryProducerUids(database, entry.id) };
      const baseValues = { producerUids: operation.baseValues.producerUids.map(uid => uid.toLowerCase()).sort() };
      const payload = { producerUids: operation.payload.producerUids.map(uid => uid.toLowerCase()).sort() };
      const expectedDelta = expectedEntryAuthorsDelta(baseValues.producerUids, payload.producerUids);
      if (valuesMatch(currentValues, payload)) {
        const targetVersion = operation.baseVersion + expectedDelta;
        for (let version = entry.syncVersion; !pending && version < targetVersion; version += 1) {
          database.prepare('UPDATE entries SET updated_at = updated_at WHERE id = ?').run(entry.id);
        }
        const resourceVersion = Number(database.prepare(
          'SELECT sync_version FROM entries WHERE id = ?',
        ).pluck().get(entry.id));
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'applied', ...(pending || operation.payload.producerCreates !== undefined ? { entityId: entry.id } : {}), resourceVersion,
          serverSeq: maxServerSeq(database),
        });
      }
      if (entry.syncVersion < operation.baseVersion || !valuesMatch(currentValues, baseValues)) {
        return saveReceipt(database, operation, requestHash, {
          opId: operation.opId, status: 'conflict', currentVersion: entry.syncVersion,
          currentValues, serverSeq: maxServerSeq(database),
        });
      }

      const desiredProducerIds = new Map<string, number>();
      for (const producerUid of payload.producerUids) {
        const producer = database.prepare('SELECT id FROM producers WHERE sync_uid = ? COLLATE NOCASE')
          .get(producerUid) as { id: number } | undefined;
        if (producer === undefined) {
          return saveReceipt(database, operation, requestHash, {
            opId: operation.opId, status: 'failed', errorCode: 'invalid-author-data',
            detail: `Author ${producerUid} no longer exists; refresh the offline copy`,
          });
        }
        desiredProducerIds.set(producerUid, producer.id);
      }

      const currentUids = new Set(currentValues.producerUids);
      const desiredUids = new Set(payload.producerUids);
      for (const producerUid of currentUids) {
        if (desiredUids.has(producerUid)) continue;
        const producerId = Number(database.prepare('SELECT id FROM producers WHERE sync_uid = ? COLLATE NOCASE')
          .pluck().get(producerUid));
        database.prepare('DELETE FROM entry_producers WHERE entry_id = ? AND producer_id = ?')
          .run(entry.id, producerId);
      }
      for (const producerUid of desiredUids) {
        if (currentUids.has(producerUid)) continue;
        database.prepare('INSERT INTO entry_producers (entry_id, producer_id) VALUES (?, ?)')
          .run(entry.id, desiredProducerIds.get(producerUid));
      }
      const resourceVersion = Number(database.prepare(
        'SELECT sync_version FROM entries WHERE id = ?',
      ).pluck().get(entry.id));
      if (resourceVersion !== entry.syncVersion + expectedDelta) {
        throw new Error(`Entry Author-link revision delta mismatch: expected ${expectedDelta}, got ${resourceVersion - entry.syncVersion}`);
      }
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', ...(pending || operation.payload.producerCreates !== undefined ? { entityId: entry.id } : {}), resourceVersion,
        serverSeq: maxServerSeq(database),
      });
    }

    const pending = operation.baseVersion === 0;
    if (pending) {
      const parent = database.prepare(`
        SELECT receipt.result_json AS resultJson, entry.id AS entryId
        FROM sync_offline_created_entries AS created
        JOIN entries AS entry ON entry.sync_uid = created.entry_uid
        JOIN sync_operation_receipts AS receipt ON receipt.op_id = created.create_op_id
        WHERE created.entry_uid = ? AND created.create_op_id = ?
      `).get(operation.entityUid, operation.payload.parentCreateOpId) as { resultJson: string; entryId: number } | undefined;
      if (!parent) return {
        opId: operation.opId, status: 'failed', errorCode: 'entity-not-found', detail: 'Parent create receipt is not available yet',
      };
      const createResult = syncReplayResultSchema.parse(JSON.parse(parent.resultJson));
      if (createResult.status !== 'applied' || createResult.entityId !== parent.entryId) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'failed', errorCode: 'invalid-create', detail: 'Parent create identity does not match its receipt',
      });
    }

    const row = database.prepare(`
      SELECT id, sync_version AS syncVersion, title,
             upload_date AS uploadDate, page_count AS pageCount, duration_seconds AS durationSeconds
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
    const desiredValues = {
      ...('title' in operation.payload ? { title: operation.payload.title } : {}),
      ...('uploadDate' in operation.payload ? { uploadDate: operation.payload.uploadDate } : {}),
      ...('pageCount' in operation.payload ? { pageCount: operation.payload.pageCount } : {}),
      ...('durationSeconds' in operation.payload ? { durationSeconds: operation.payload.durationSeconds } : {}),
    };
    if (pending && valuesMatch(values, desiredValues)) {
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', entityId: row.id,
        resourceVersion: row.syncVersion, serverSeq: maxServerSeq(database),
      });
    }
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

    updateEntry(database, row.id, desiredValues as UpdateEntryInput);
    const resourceVersion = Number(database.prepare(`
      SELECT sync_version FROM entries WHERE id = ?
    `).pluck().get(row.id));
    return saveReceipt(database, operation, requestHash, {
      opId: operation.opId,
      status: 'applied',
      ...(pending ? { entityId: row.id } : {}),
      resourceVersion,
      serverSeq: maxServerSeq(database),
    });
  });
  return replay();
}
