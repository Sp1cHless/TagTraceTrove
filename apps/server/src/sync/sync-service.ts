import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { T3Database } from '../database/connection.js';
import type { SyncCapabilities, SyncSnapshot, SyncSnapshotPayload } from '@t3/shared';
import { syncSnapshotPayloadSchema } from '@t3/shared';
import { applyAllMigrations } from '../database/migrations.js';

/**
 * Offline sync identity and read-only snapshot (plan §24). The snapshot is
 * captured inside ONE immediate SQLite transaction together with the
 * `snapshot_seq` bump, so a snapshot can never mix data from before and
 * after a concurrent write, and the monotonic seq always describes exactly
 * the rows it ships with.
 */

export const SNAPSHOT_FORMAT_VERSION = 1;
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
      offlineMutations: false,
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
    SELECT id, title, type, cover_ref AS coverRef, preview_ref AS previewRef,
           preview_refs AS previewRefs, page_count AS pageCount, upload_date AS uploadDate,
           created_at AS createdAt, updated_at AS updatedAt
    FROM entries ORDER BY id
  `);
  read('producers', `
    SELECT id, name, occupation, artwork_ref AS artworkRef, content
    FROM producers ORDER BY id
  `);
  read('entryProducers', `
    SELECT entry_id AS entryId, producer_id AS producerId
    FROM entry_producers ORDER BY entry_id, producer_id
  `);
  read('tags', `
    SELECT id, name, normalized_name AS normalizedName FROM tags ORDER BY id
  `);
  read('tagGroups', `
    SELECT id, entry_type AS entryType, name, group_kind AS groupKind,
           parent_id AS parentId, sort_order AS sortOrder
    FROM tag_groups ORDER BY id
  `);
  read('entryTags', `
    SELECT entry_id AS entryId, tag_id AS tagId, facet_id AS facetId
    FROM entry_tags ORDER BY entry_id, tag_id
  `);
  read('producerTags', `
    SELECT id, name, normalized_name AS normalizedName FROM producer_tags ORDER BY id
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
    SELECT id, entry_id AS entryId, content_type AS contentType, content, sort_order AS sortOrder
    FROM entry_contents ORDER BY entry_id, sort_order, id
  `);
  read('ratingSlots', `
    SELECT id, subject_kind AS subjectKind, entry_type AS entryType, name, sort_order AS sortOrder
    FROM rating_slots ORDER BY subject_kind, entry_type, sort_order, id
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
    SELECT id, kind, title, description, nsfw, parent_id AS parentId, sort_order AS sortOrder
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
    SELECT id, producer_id AS producerId, title, description, sort_order AS sortOrder
    FROM author_directories ORDER BY id
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
