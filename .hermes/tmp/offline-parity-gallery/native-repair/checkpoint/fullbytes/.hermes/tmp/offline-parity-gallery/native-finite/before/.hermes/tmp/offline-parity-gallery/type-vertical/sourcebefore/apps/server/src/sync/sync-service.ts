import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { T3Database } from '../database/connection.js';
import type { SyncAckRequest, SyncChangesQuery, SyncCapabilities, SyncSnapshot, SyncSnapshotPayload } from '@t3/shared';
import { syncSnapshotPayloadSchema } from '@t3/shared';
import { applyAllMigrations } from '../database/migrations.js';

/**
 * Offline sync identity and read-only snapshot (plan §24). The snapshot is
 * captured inside ONE immediate SQLite transaction together with the
 * `snapshot_seq` bump, so a snapshot can never mix data from before and
 * after a concurrent write, and the monotonic seq always describes exactly
 * the rows it ships with.
 */

export const SNAPSHOT_FORMAT_VERSION = 2;
export const SYNC_PROTOCOL_VERSION = 1;

interface SyncMetadataRow {
  library_id: string;
  sync_epoch: string;
  snapshot_seq: number;
  protocol_version: number;
}

function ensureSyncMetadata(database: T3Database): SyncMetadataRow {
  const row = database.prepare(`
    SELECT library_id, sync_epoch, snapshot_seq, protocol_version
    FROM sync_metadata WHERE id = 1
  `).get() as SyncMetadataRow | undefined;
  if (row !== undefined) return row;
  database.prepare(`
    INSERT INTO sync_metadata (id, library_id, sync_epoch, snapshot_seq, protocol_version)
    VALUES (1, ?, ?, 0, ?)
  `).run(randomUUID(), randomUUID(), SYNC_PROTOCOL_VERSION);
  return database.prepare(`
    SELECT library_id, sync_epoch, snapshot_seq, protocol_version
    FROM sync_metadata WHERE id = 1
  `).get() as SyncMetadataRow;
}

export class SyncFeedConflict extends Error {}

function feedIdentity(database: T3Database, input: SyncChangesQuery | SyncAckRequest) {
  const metadata = ensureSyncMetadata(database);
  if (input.libraryId !== metadata.library_id || input.syncEpoch !== metadata.sync_epoch
    || input.protocolVersion !== metadata.protocol_version) {
    throw new SyncFeedConflict('Sync identity, epoch or protocol mismatch');
  }
  return metadata;
}

/** Reading records the largest cursor actually served, in the same SQLite transaction. */
export function readSyncChanges(database: T3Database, input: SyncChangesQuery) {
  return database.transaction(() => {
    const identity = feedIdentity(database, input);
    const highWaterSeq = Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());
    const cursor = database.prepare(`
      SELECT ack_seq AS ackSeq, served_seq AS servedSeq FROM sync_feed_cursors
      WHERE library_id = ? AND sync_epoch = ? AND client_id = ?
    `).get(input.libraryId, input.syncEpoch, input.clientId) as { ackSeq: number; servedSeq: number } | undefined;
    if (input.afterSeq > highWaterSeq || (cursor ? input.afterSeq > cursor.servedSeq : input.afterSeq !== 0)) {
      throw new SyncFeedConflict('Cursor was not previously served');
    }
    if (cursor && input.afterSeq < cursor.ackSeq) throw new SyncFeedConflict('Cursor precedes acknowledged progress');
    // A new client may bootstrap at an atomic snapshot cursor; merely claiming an
    // arbitrary cursor never grants permission to acknowledge it.
    const rows = database.prepare(`
      SELECT seq, entity_kind AS entityKind, entity_uid AS entityUid,
        change_kind AS changeKind, resource_version AS resourceVersion, record_json AS recordJson
      FROM sync_changes WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?
    `).all(input.afterSeq, highWaterSeq, input.limit) as Array<{
      seq: number; entityKind: string; entityUid: string; changeKind: 'create' | 'update' | 'delete';
      resourceVersion: number; recordJson: string | null;
    }>;
    const nextSeq = rows.length ? rows[rows.length - 1]!.seq : input.afterSeq;
    database.prepare(`
      INSERT INTO sync_feed_cursors (library_id, sync_epoch, client_id, served_seq)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(library_id, sync_epoch, client_id) DO UPDATE SET
        served_seq = MAX(served_seq, excluded.served_seq)
    `).run(identity.library_id, identity.sync_epoch, input.clientId, nextSeq);
    return {
      changes: rows.map(({ recordJson, ...row }) => ({ ...row, record: recordJson === null ? null : JSON.parse(recordJson) as unknown })),
      nextSeq, highWaterSeq, ackSeq: cursor?.ackSeq ?? 0,
    };
  })();
}

export function ackSyncChanges(database: T3Database, input: SyncAckRequest) {
  return database.transaction(() => {
    feedIdentity(database, input);
    const cursor = database.prepare(`
      SELECT ack_seq AS ackSeq, served_seq AS servedSeq FROM sync_feed_cursors
      WHERE library_id = ? AND sync_epoch = ? AND client_id = ?
    `).get(input.libraryId, input.syncEpoch, input.clientId) as { ackSeq: number; servedSeq: number } | undefined;
    const highWaterSeq = Number(database.prepare('SELECT COALESCE(MAX(seq), 0) FROM sync_changes').pluck().get());
    if (!cursor || input.cursorSeq < cursor.ackSeq || input.cursorSeq > cursor.servedSeq || input.cursorSeq > highWaterSeq) {
      throw new SyncFeedConflict('Acknowledgement exceeds served cursor or regresses');
    }
    database.prepare(`
      UPDATE sync_feed_cursors SET ack_seq = ?
      WHERE library_id = ? AND sync_epoch = ? AND client_id = ?
    `).run(input.cursorSeq, input.libraryId, input.syncEpoch, input.clientId);
    return { ackSeq: input.cursorSeq };
  })();
}

export function getSyncIdentity(database: T3Database): { libraryId: string; syncEpoch: string } {
  const row = ensureSyncMetadata(database);
  return { libraryId: row.library_id, syncEpoch: row.sync_epoch };
}

/** Backup restore calls this: a restore point must rotate the epoch so a
 * stale client can never mistake the restored sequence for a continuation. */
export function rotateSyncEpoch(database: T3Database): string {
  ensureSyncMetadata(database);
  const epoch = randomUUID();
  database.prepare(`
    UPDATE sync_metadata SET sync_epoch = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1
  `).run(epoch);
  return epoch;
}

export const OFFLINE_ENTRY_CONTENT_APPEND_ENABLED = true;

export function buildSyncCapabilities(database: T3Database, serverBuild: string): SyncCapabilities {
  const identity = getSyncIdentity(database);
  const sqliteSchemaVersion = applyAllMigrations(database).currentVersion;
  return {
    libraryId: identity.libraryId,
    syncEpoch: identity.syncEpoch,
    sqliteSchemaVersion,
    snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
    syncProtocolVersion: SYNC_PROTOCOL_VERSION,
    serverBuild,
    featureFlags: {
      readOnlySnapshot: true,
      completeSnapshotDelta: sqliteSchemaVersion >= 31,
      offlineMutations: true,
      offlineEntryUpdate: true,
      offlineEntryDelete: sqliteSchemaVersion >= 16,
      offlinePendingEntryMetadata: sqliteSchemaVersion >= 23,
      offlineEntryCreate: true,
      onlineEntryCreateClaim: sqliteSchemaVersion >= 32,
      onlineEntryCreateCommand: sqliteSchemaVersion >= 32,
      offlineEntryInitialContents: true,
      offlineEntryContentAppend: OFFLINE_ENTRY_CONTENT_APPEND_ENABLED,
      offlineMediaUpload: true,
      existingEntryMedia: true,
      offlineMediaMultiplePreviews: true,
      offlineUsageEvents: true,
      offlineEntryViewLater: true,
      offlineEntryRating: true,
      offlineEntryContents: true,
      offlinePendingEntryContents: sqliteSchemaVersion >= 23,
      offlineProducerViewLater: true,
      offlineProducerRating: true,
      offlineEntryDuration: sqliteSchemaVersion >= 38,
      offlineRatingSlotDelete: sqliteSchemaVersion >= 39,
      offlineProducerProfile: true,
      offlineProducerTags: true,
      offlineRatingSlotLayout: true,
      offlineCollectionProducerMembership: true,
      offlineCollectionManagement: true,
      offlineCollectionDelete: sqliteSchemaVersion >= 37,
      offlineCollectionCommonTag: sqliteSchemaVersion >= 37,
      offlineGalleryOrder: sqliteSchemaVersion >= 37,
      /** The author's own rating class and their stored Gallery anchor (`039`/`040`). */
      offlineAuthorSelfRatings: sqliteSchemaVersion >= 39,
      offlineAuthorDirectories: true,
      offlineEntryAuthors: true,
      offlinePendingEntryAuthors: sqliteSchemaVersion >= 29,
      offlinePendingEntryAuthorCreate: sqliteSchemaVersion >= 29,
      offlineCrossEntryPendingAuthors: sqliteSchemaVersion >= 33,
      offlineAuthorCreate: sqliteSchemaVersion >= 29,
      offlineStandaloneAuthorCreate: sqliteSchemaVersion >= 33,
      offlineStandaloneAuthorDirectorySeed: sqliteSchemaVersion >= 42,
      offlineAuthorDelete: sqliteSchemaVersion >= 33,
      offlineEntryTags: sqliteSchemaVersion >= 30,
      offlinePendingEntryTags: sqliteSchemaVersion >= 30,
      offlineEntryTagVocabulary: sqliteSchemaVersion >= 34,
      offlineEntryMediaOrder: sqliteSchemaVersion >= 36,
      offlineEntryFacetCreate: sqliteSchemaVersion >= 34,
      offlinePendingEntryTagCreation: sqliteSchemaVersion >= 34,
    },
  };
}

interface RawRows {
  [key: string]: unknown[];
}

function readPayload(database: T3Database, media: 'none' | 'thumbnails'): SyncSnapshotPayload {
  const payload: RawRows = {};
  const read = (key: string, sql: string): void => {
    payload[key] = database.prepare(sql).all() as unknown[];
  };

  read('entries', `
    SELECT id, sync_uid AS syncUid, sync_version AS syncVersion,
           title, type, cover_ref AS coverRef, preview_ref AS previewRef,
           preview_refs AS previewRefs, page_count AS pageCount, duration_seconds AS durationSeconds, upload_date AS uploadDate,
           created_at AS createdAt, updated_at AS updatedAt
    FROM entries ORDER BY id
  `);
  read('producers', `
    SELECT id, sync_uid AS syncUid, sync_version AS syncVersion,
           name, occupation, artwork_ref AS artworkRef, content, gallery_anchor AS galleryAnchor
    FROM producers ORDER BY id
  `);
  read('entryProducers', `
    SELECT entry_id AS entryId, producer_id AS producerId
    FROM entry_producers ORDER BY entry_id, producer_id
  `);
  read('tags', `
    SELECT id, sync_uid AS syncUid, name, normalized_name AS normalizedName FROM tags ORDER BY id
  `);
  read('tagGroups', `
    SELECT id, sync_uid AS syncUid, entry_type AS entryType, name, group_kind AS groupKind,
           parent_id AS parentId, sort_order AS sortOrder
    FROM tag_groups ORDER BY id
  `);
  read('entryTagLayouts', `
    SELECT entry_type AS entryType, sync_uid AS syncUid, sync_version AS syncVersion
    FROM entry_tag_layouts ORDER BY entry_type
  `);
  read('entryTags', `
    SELECT entry_id AS entryId, tag_id AS tagId, facet_id AS facetId
    FROM entry_tags ORDER BY entry_id, tag_id
  `);
  read('producerTags', `
    SELECT id, sync_uid AS syncUid, name, normalized_name AS normalizedName FROM producer_tags ORDER BY id
  `);
  read('producerTagAssignments', `
    SELECT producer_id AS producerId, tag_id AS tagId
    FROM producer_tag_assignments ORDER BY producer_id, tag_id
  `);
  read('taxonomyAliases', `
    SELECT id, vocabulary, partition, alias_name AS aliasName,
           normalized_alias AS normalizedAlias, canonical_name AS canonicalName,
           normalized_canonical AS normalizedCanonical
    FROM taxonomy_aliases ORDER BY vocabulary, partition, normalized_alias, id
  `);
  read('entryContents', `
    SELECT id, entry_id AS entryId, sync_uid AS syncUid, sync_version AS syncVersion,
           content_type AS contentType, content, sort_order AS sortOrder
    FROM entry_contents ORDER BY entry_id, sort_order, id
  `);
  read('ratingSlots', `
    SELECT id, sync_uid AS syncUid, subject_kind AS subjectKind, entry_type AS entryType,
           name, sort_order AS sortOrder
    FROM rating_slots ORDER BY subject_kind, entry_type, sort_order, id
  `);
  read('ratingLayouts', `
    SELECT sync_uid AS syncUid, sync_version AS syncVersion,
           subject_kind AS subjectKind, entry_type AS entryType
    FROM rating_slot_layouts ORDER BY subject_kind, entry_type
  `);
  read('entryRatingValues', `
    SELECT slot_id AS slotId, entry_id AS entryId, stars
    FROM entry_rating_values ORDER BY slot_id, entry_id
  `);
  read('producerRatingValues', `
    SELECT slot_id AS slotId, producer_id AS producerId, stars
    FROM producer_rating_values ORDER BY slot_id, producer_id
  `);
  read('collections', `
    SELECT id, sync_uid AS syncUid, sync_version AS syncVersion,
           kind, title, description, nsfw, parent_id AS parentId, sort_order AS sortOrder,
           gallery_type AS galleryType
    FROM collections ORDER BY id
  `);
  read('collectionMembers', `
    SELECT collection_id AS collectionId, entry_id AS entryId, NULL AS producerId,
           ROW_NUMBER() OVER (
             PARTITION BY collection_id ORDER BY created_at, entry_id
           ) - 1 AS position
    FROM collection_entries
    UNION ALL
    SELECT collection_id AS collectionId, NULL AS entryId, producer_id AS producerId,
           ROW_NUMBER() OVER (
             PARTITION BY collection_id ORDER BY created_at, producer_id
           ) - 1 AS position
    FROM collection_producers
    ORDER BY collectionId, position
  `);
  read('authorDirectories', `
    SELECT id, sync_uid AS syncUid, producer_id AS producerId, title, description, sort_order AS sortOrder
    FROM author_directories ORDER BY id
  `);
  read('authorDirectorySets', `
    SELECT producer_id AS producerId, sync_uid AS syncUid, sync_version AS syncVersion
    FROM author_directory_sets ORDER BY producer_id
  `);
  read('authorDirectoryEntries', `
    SELECT directory_id AS directoryId, producer_id AS producerId, entry_id AS entryId,
           sort_order AS sortOrder
    FROM author_directory_entries ORDER BY directory_id, sort_order, entry_id
  `);
  read('entryUsage', `
    SELECT entry_id AS entryId, view_count AS viewCount, like_count AS likeCount, last_viewed_at AS lastViewedAt
    FROM entry_usage ORDER BY entry_id
  `);
  read('viewLaterEntries', `
    SELECT entry_id AS subjectId, position FROM view_later_entries ORDER BY position
  `);
  read('viewLaterProducers', `
    SELECT producer_id AS subjectId, position FROM view_later_producers ORDER BY position
  `);
  read('gallerySettings', `
    SELECT entry_type AS entryType, nsfw FROM gallery_settings ORDER BY entry_type
  `);
  const galleryScope = database.prepare('SELECT sync_uid AS syncUid, sync_version AS syncVersion FROM gallery_order_scope WHERE id=1').get();
  const galleryOrder = { ...(galleryScope as object), orderedTypes: database.prepare(`
    SELECT e.type FROM entries e LEFT JOIN gallery_order o ON o.entry_type=e.type
    GROUP BY e.type ORDER BY CASE WHEN o.sort_order IS NULL THEN 1 ELSE 0 END, o.sort_order, e.type COLLATE NOCASE
  `).pluck().all() };
  payload.mediaRefs = [];

  const entries: Array<Record<string, unknown> & { previewRefs: unknown[] }> = (
    payload.entries as Array<Record<string, unknown>>
  ).map((row) => {
    let previewRefs: unknown[] = [];
    try {
      const parsed = JSON.parse(String(row.previewRefs ?? '[]')) as unknown;
      if (Array.isArray(parsed)) previewRefs = parsed;
    } catch {
      previewRefs = [];
    }
    return { ...row, previewRefs };
  });
  const collections = (payload.collections as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    nsfw: row.nsfw === 1,
  }));
  const gallerySettings = (payload.gallerySettings as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    nsfw: row.nsfw === 1,
  }));
  const collectionMembers = (payload.collectionMembers as Array<Record<string, unknown>>).map((row) => {
    const member: Record<string, unknown> = {
      collectionId: row.collectionId,
      position: row.position,
    };
    if (typeof row.entryId === 'number') member.entryId = row.entryId;
    if (typeof row.producerId === 'number') member.producerId = row.producerId;
    return member;
  });

  const mediaRefs = media === 'none' ? [] : [...new Set([
    ...entries.flatMap((entry) => [entry.coverRef, entry.previewRef, ...(entry.previewRefs as unknown[])]),
    ...(payload.producers as Array<Record<string, unknown>>).map((producer) => producer.artworkRef),
  ].filter((ref): ref is string => typeof ref === 'string' && ref.length > 0))].sort();

  return syncSnapshotPayloadSchema.parse({
    ...payload,
    entries,
    collections,
    gallerySettings,
    galleryOrder,
    collectionMembers,
    mediaRefs,
  });
}

function checksumOf(headerWithoutChecksum: { [key: string]: unknown }, payload: SyncSnapshotPayload): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(headerWithoutChecksum));
  hash.update(JSON.stringify(payload));
  return hash.digest('hex');
}

export function buildSyncSnapshot(
  database: T3Database,
  options: { media?: 'none' | 'thumbnails' } = {},
): SyncSnapshot {
  const tx = database.transaction((): SyncSnapshot => {
    ensureSyncMetadata(database);
    const metadata = database.prepare(`
      SELECT library_id, sync_epoch, snapshot_seq, protocol_version
      FROM sync_metadata WHERE id = 1
    `).get() as SyncMetadataRow;
    // IMMEDIATE transaction: the seq bump and the reads share one lock, so
    // seq N always ships exactly the rows visible at bump time.
    database.prepare(`
      UPDATE sync_metadata SET snapshot_seq = snapshot_seq + 1 WHERE id = 1
    `).run();
    const snapshotSeq = metadata.snapshot_seq + 1;
    // Export stable empty partitions too: first offline author-self slot must not invent an identity.
    const types = database.prepare('SELECT type AS entryType FROM entries UNION SELECT gallery_anchor AS entryType FROM producers WHERE gallery_anchor IS NOT NULL').all() as Array<{ entryType: string }>;
    for (const { entryType } of types) for (const kind of ['entry', 'producer', 'author_self']) {
      database.prepare(`INSERT OR IGNORE INTO rating_slot_layouts (sync_uid, subject_kind, entry_type)
        VALUES (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-8' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), ?, ?)`).run(kind, entryType);
    }
    const changeSeq = database.prepare(`
      SELECT COALESCE(MAX(seq), 0) FROM sync_changes
    `).pluck().get() as number;

    const payload = readPayload(database, options.media ?? 'none');
    const counts = {
      entries: payload.entries.length,
      producers: payload.producers.length,
      entryContents: payload.entryContents.length,
      entryTags: payload.entryTags.length,
      collections: payload.collections.length,
    };
    const header = {
      libraryId: metadata.library_id,
      syncEpoch: metadata.sync_epoch,
      snapshotSeq,
      changeSeq,
      generatedAt: new Date().toISOString(),
      sqliteSchemaVersion: applyAllMigrations(database).currentVersion,
      snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
      counts,
    };
    const checksum = checksumOf(header, payload);
    return { header: { ...header, checksum }, payload };
  });
  return tx.immediate();
}
