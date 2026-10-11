import {
  normalizeTag,
  producerSuggestionQuerySchema,
  tagSuggestionQuerySchema,
  COLLECTION_ORDER_SCOPE_UIDS,
  entryContentRecordSchema,
  syncReplayRequestSchema,
  type EntryRecordDto,
  type EntryTagAssignment,
  type RatingRow,
  type SyncEntryMediaOperation,
  type SyncReplayRequest,
  type SyncSnapshot,
  type UpdateProducerRequest,
  type UpdateEntryRequest,
  type UsageInfo,
  type ViewLaterState,
} from '@t3/shared';
import type {
  GalleryApi,
  OfflineEntryCreateRequest,
  PendingOfflineEntryCreate,
  PendingOfflineEntryContentValue,
  PendingOfflineEntryTagValue,
  PendingOfflineEntryTagOptions,
  PendingOfflineEntryAuthorOptions,
} from '../api/gallery.js';
import { ApiError } from '../api/client.js';
import { isOfflineTransportError } from '../api/transport-error.js';
import { createOfflineLibrary, type OfflineLibrary } from './offline-library.js';
import { mediaQueueIdentity, type MediaOutboxStore, type StagedMediaUpload } from './media-outbox-store.js';
import {
  createPendingSyncOperation,
  operationFingerprint,
  type OutboxStore,
  type PendingSyncOperation,
} from './outbox-store.js';
import { fetchSnapshotCandidate, acknowledgeSnapshotCandidate, retryPendingSnapshotAck } from './snapshot-delta.js';
import { randomUuid } from './random-id.js';
import { mutationQueuePlan, missingForegroundMutationCapabilities, referencedEntityKeys, newlyCreatedRatingSlotUids, referencedRatingSlotUids } from './sync-mutation-plan.js';
import { getClientIdentity, readSnapshotMediaMode } from './client-identity.js';
import { evictEntryMediaRefs } from './offline-media.js';
import { cachedMediaObjectUrls } from './cached-media-object-urls.js';
import {
  ACTIVE_GENERATION_KEY,
  applySnapshot,
  readActiveSnapshot,
  type SnapshotStore,
} from './snapshot-store.js';

/** Online remains authoritative. Read calls may fall back to a verified snapshot.
 * Offline mutation allowlist: Entry scalar fields, Entry Content lists, usage,
 * View later, Entry/Author-owned Producer profile and tag data, ratings, and
 * staged manual Entry create. */
export interface OfflineMutationDiagnostic {
  at: string;
  action: 'view' | 'like' | 'view-later-add' | 'view-later-remove'
    | 'producer-view-later-add' | 'producer-view-later-remove' | 'producer-rating-set'
    | 'producer-profile-update' | 'producer-tags-set' | 'rating-set' | 'contents-set'
    | 'rating-layout-set' | 'collection-producer-set' | 'collection-management-set' | 'author-directories-set'
    | 'entry-authors-set' | 'entry-author-by-name' | 'entry-tags-set';
  modeBefore: 'online' | 'offline';
  modeAfter: 'online' | 'offline';
  capability: string | null;
  result: 'running' | 'online-or-noop' | 'queued' | 'error';
  transportClassified: boolean | null;
  errorName: string | null;
  errorMessage: string | null;
}

export interface OfflineApiState {
  mode: 'online' | 'offline';
  lastFallbackAt: string | null;
  connectionPhase?: 'checking' | 'opening-copy' | 'switching' | 'no-copy' | null;
  /** Last uncached IndexedDB generation read + validation + projection (milliseconds). */
  lastLocalLoadMs?: number | null;
  pendingCount?: number;
  conflictCount?: number;
  failedCount?: number;
  lastReplayError?: string | null;
  lastCapabilityProbe?: {
    at: string;
    status: 'success' | 'error';
    serverBuild: string | null;
    offlineUsageEvents: boolean | null;
    offlineEntryViewLater: boolean | null;
    offlineEntryRating: boolean | null;
    offlineEntryAuthors?: boolean | null;
    offlinePendingEntryMetadata?: boolean | null;
    offlinePendingEntryAuthors?: boolean | null;
    offlinePendingEntryAuthorCreate?: boolean | null;
    offlineAuthorCreate?: boolean | null;
    offlineEntryTags?: boolean | null;
    offlineEntryContents: boolean | null;
    offlineProducerViewLater: boolean | null;
    offlineProducerRating: boolean | null;
    offlineProducerProfile: boolean | null;
    offlineProducerTags: boolean | null;
    offlineRatingSlotLayout: boolean | null;
    offlineCollectionProducerMembership: boolean | null;
    offlineCollectionManagement: boolean | null;
    offlineAuthorDirectories: boolean | null;
    error: string | null;
  } | null;
  lastSuccessfulCapabilityProbe?: {
    at: string;
    serverBuild: string;
    offlineUsageEvents: boolean;
    offlineEntryViewLater: boolean;
    offlineEntryRating: boolean;
    offlineEntryAuthors?: boolean;
    offlinePendingEntryMetadata?: boolean;
    offlinePendingEntryAuthors?: boolean;
    offlinePendingEntryAuthorCreate?: boolean;
    offlineAuthorCreate?: boolean;
    offlineEntryTags?: boolean;
    offlineEntryContents: boolean;
    offlineProducerViewLater: boolean;
    offlineProducerRating: boolean;
    offlineProducerProfile: boolean;
    offlineProducerTags: boolean;
    offlineRatingSlotLayout: boolean;
    offlineCollectionProducerMembership: boolean;
    offlineCollectionManagement: boolean;
    offlineAuthorDirectories: boolean;
  } | null;
  lastMutationDiagnostic?: OfflineMutationDiagnostic | null;
  /** Incremented after a replay is covered by a newly installed snapshot. */
  lastReplaySnapshotSeq?: number | null;
  reconciledAuthorIds?: Record<string, number>;
  mutationDiagnostics?: OfflineMutationDiagnostic[];
}

import { preparePendingWork, type AtomicPendingWorkStore } from './pending-work-restore.js';

export type OfflineStore = SnapshotStore & Partial<OutboxStore> & Partial<MediaOutboxStore>;

interface OfflineApiOptions {
  state?: OfflineApiState;
  randomUUID?: () => string;
  clientId?: string;
  nativeTransfers?: { allocateUploadId?():Promise<string>; authorizePreviewCancel?(media:StagedMediaUpload[]):Promise<void>; inspectPreviewCancel?(media:StagedMediaUpload[]):Promise<boolean>; handoff(): Promise<void>; pause(opIds?: string[]): Promise<void>; reconcile(): Promise<unknown>; resume?(): Promise<{active:number;completed:number;held:number;remainingOperations:number;standaloneMedia?:number;foregroundMedia?:number;dependencyHeld?:number;capabilityHeld?:number;foregroundReason?:string}> };
  /** Deadline for safe reads only. Never infer a failed write from elapsed time. */
  onlineReadTimeoutMs?: number;
  /**
   * The native shell's currently paired library identity, when running inside
   * one. A local snapshot from a different library must never serve offline:
   * it would show the wrong collection and queue edits against wrong IDs.
   */
  nativeShellLibraryId?: () => Promise<string | null>;
  /** Shown when the fallback above refuses a foreign-library snapshot. */
  fallbackLibraryMismatchMessage?: string;
}

class OfflineReadTimeout extends Error {
  constructor() {
    super('The desktop server did not respond in time');
    this.name = 'OfflineReadTimeout';
  }
}

async function boundedRead<T>(read: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new OfflineReadTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}


const ENTRY_CREATE_CAPABILITY_KEY = 'capability.offlineEntryCreate';
const ENTRY_INITIAL_CONTENTS_CAPABILITY_KEY = 'capability.offlineEntryInitialContents';
const PENDING_ENTRY_CONTENT_APPEND_CAPABILITY_KEY = 'capability.offlineEntryContentAppend';
const MEDIA_UPLOAD_CAPABILITY_KEY = 'capability.offlineMediaUpload';
const MEDIA_MULTIPLE_PREVIEWS_CAPABILITY_KEY = 'capability.offlineMediaMultiplePreviews';
const USAGE_EVENTS_CAPABILITY_KEY = 'capability.offlineUsageEvents';
const ENTRY_VIEW_LATER_CAPABILITY_KEY = 'capability.offlineEntryViewLater';
const ENTRY_RATING_CAPABILITY_KEY = 'capability.offlineEntryRating';
const ENTRY_AUTHORS_CAPABILITY_KEY = 'capability.offlineEntryAuthors';
const PENDING_ENTRY_AUTHORS_CAPABILITY_KEY = 'capability.offlinePendingEntryAuthors';
const AUTHOR_CREATE_CAPABILITY_KEY = 'capability.offlineAuthorCreate';
const PENDING_ENTRY_TAGS_CAPABILITY_KEY = 'capability.offlinePendingEntryTags';
const ENTRY_TAGS_CAPABILITY_KEY = 'capability.offlineEntryTags';
const ENTRY_TAG_VOCABULARY_CAPABILITY_KEY = 'capability.offlineEntryTagVocabulary';
const ENTRY_CONTENTS_CAPABILITY_KEY = 'capability.offlineEntryContents';
const PRODUCER_VIEW_LATER_CAPABILITY_KEY = 'capability.offlineProducerViewLater';
const PRODUCER_RATING_CAPABILITY_KEY = 'capability.offlineProducerRating';
const PRODUCER_PROFILE_CAPABILITY_KEY = 'capability.offlineProducerProfile';
const PRODUCER_TAGS_CAPABILITY_KEY = 'capability.offlineProducerTags';
const RATING_LAYOUT_CAPABILITY_KEY = 'capability.offlineRatingSlotLayout';
const ENTRY_MEDIA_ORDER_CAPABILITY_KEY = 'capability.offlineEntryMediaOrder';
const COLLECTION_PRODUCER_MEMBERSHIP_CAPABILITY_KEY = 'capability.offlineCollectionProducerMembership';
const GALLERY_ORDER_CAPABILITY_KEY = 'capability.offlineGalleryOrder';
const COLLECTION_MANAGEMENT_CAPABILITY_KEY = 'capability.offlineCollectionManagement';
const AUTHOR_DIRECTORIES_CAPABILITY_KEY = 'capability.offlineAuthorDirectories';
const MAX_STAGED_MEDIA_BYTES = 20 * 1024 * 1024;

// A presentation-only negative ID must survive partial replay and app restart.
// Hash the complete stable UUID (not the position in the remaining outbox).
export function localCollectionId(uid: string): number {
  let hash = 0xcbf29ce484222325n;
  for (const char of uid) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(char.charCodeAt(0))) * 0x100000001b3n);
  }
  return -Number(hash % BigInt(Number.MAX_SAFE_INTEGER) + 1n);
}

const collectionReconciliationListeners = new WeakMap<GalleryApi, Set<(ids: ReadonlyMap<number, number>) => void>>();
/** Scoped to one facade; callers must unsubscribe when their view unmounts. */
export function subscribeCollectionReconciliation(
  api: GalleryApi,
  listener: (ids: ReadonlyMap<number, number>) => void,
): () => void {
  const listeners = collectionReconciliationListeners.get(api);
  if (listeners === undefined) return () => undefined;
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const ALLOWED_MEDIA_TYPES = new Set<StagedMediaUpload['mimeType']>([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function hasOutbox(store: OfflineStore): store is SnapshotStore & OutboxStore {
  return typeof store.enqueue === 'function'
    && typeof store.list === 'function'
    && typeof store.remove === 'function';
}

function hasMediaOutbox(store: OfflineStore): store is OfflineStore & OutboxStore & MediaOutboxStore {
  return hasOutbox(store)
    && typeof (store as OfflineStore).enqueueEntryCreate === 'function'
    && typeof (store as OfflineStore).listMedia === 'function'
    && typeof (store as OfflineStore).updateMedia === 'function'
    && typeof (store as OfflineStore).removeMedia === 'function';
}

function wireFields(operation: PendingSyncOperation): Record<string, unknown> {
  return {
    opId: operation.opId,
    clientId: operation.clientId,
    libraryId: operation.libraryId,
    syncEpoch: operation.syncEpoch,
    entityKind: operation.entityKind,
    entityUid: operation.entityUid,
    operationKind: operation.operationKind,
    baseVersion: operation.baseVersion,
    baseValues: operation.baseValues,
    payload: operation.payload,
    clientCreatedAt: operation.clientCreatedAt,
  };
}

function transportOperation(operation: PendingSyncOperation): SyncReplayRequest {
  return syncReplayRequestSchema.parse(wireFields(operation));
}

/**
 * Media order is not part of the replay union the rest of the overlay parses
 * (it moves files on the server), so it gets its own read of the same outbox.
 */
function parsedMediaOrderOperations(operations: PendingSyncOperation[]): SyncEntryMediaOperation[] {
  return operations.flatMap((operation) => {
    if (operation.operationKind !== 'entry.media.set') return [];
    try {
      const parsed = syncReplayRequestSchema.parse(wireFields(operation));
      return parsed.operationKind === 'entry.media.set' ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

/** Predict the server's positional rename without treating a URL as byte identity.
 * This is used only when creating a NEW successor envelope, never on retries. */
function renamedEntryMediaRefs(entryId: number, refs: string[]): string[] {
  return refs.map((ref, position) => {
    const extension = ref.slice(ref.lastIndexOf('.') + 1);
    const name = position === 0 ? 'cover' : position === 1 ? 'preview' : `preview-${position}`;
    return `/api/assets/entries/${entryId}/${name}.${extension}`;
  });
}

function resolveOfflineAuthorByName(
  snapshot: SyncSnapshot,
  name: string,
): { id: number; name: string; matchedAlias?: string } | null {
  const normalized = normalizeTag(name);
  if (normalized === '') throw new Error('Author name cannot be empty');
  const exact = snapshot.payload.producers.filter((producer) => normalizeTag(producer.name) === normalized);
  const canonicalNames = new Set((snapshot.payload.taxonomyAliases ?? [])
    .filter((alias) => alias.vocabulary === 'producer' && alias.partition === 'authors'
      && alias.normalizedAlias === normalized)
    .map((alias) => alias.normalizedCanonical));
  const candidates = exact.length > 0 ? exact : snapshot.payload.producers.filter((producer) => (
    canonicalNames.has(normalizeTag(producer.name))
  ));
  if (candidates.length > 1) throw new Error('Multiple saved Authors match this name; select one explicitly');
  const candidate = candidates[0];
  if (candidate === undefined) return null;
  return { id: candidate.id, name: candidate.name,
    ...(exact.length === 0 ? { matchedAlias: name } : {}) };
}

function canonicalOfflineAuthorName(snapshot: SyncSnapshot, rawName: string): string {
  let name = rawName.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  const visited = new Set<string>();
  while (!visited.has(normalizeTag(name))) {
    const normalized = normalizeTag(name);
    visited.add(normalized);
    const alias = (snapshot.payload.taxonomyAliases ?? []).find((row) => (
      row.vocabulary === 'producer' && row.partition === 'authors'
      && row.normalizedAlias === normalized && row.normalizedCanonical !== ''
    ));
    if (alias === undefined) break;
    name = alias.canonicalName.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  }
  return name;
}

/** Semantic projection only: never send this view or rewrite a durable envelope. */
function authorIdentityView(operation: SyncReplayRequest): SyncReplayRequest {
  if (operation.operationKind === 'entry.authors.set') return {...operation, entityUid:operation.entityUid.toLowerCase(),
    baseValues:{producerUids:operation.baseValues.producerUids.map(uid=>uid.toLowerCase())},
    payload:{...operation.payload,producerUids:operation.payload.producerUids.map(uid=>uid.toLowerCase()),
      ...(operation.payload.producerCreates ? {producerCreates:operation.payload.producerCreates.map(row=>({...row,producerUid:row.producerUid.toLowerCase()}))} : {})}};
  if (operation.operationKind === 'entry.author.create-and-link') return {...operation,entityUid:operation.entityUid.toLowerCase(),
    baseValues:{producerUids:operation.baseValues.producerUids.map(uid=>uid.toLowerCase())},payload:{...operation.payload,producerUid:operation.payload.producerUid.toLowerCase()}};
  return operation;
}

function parsedEntryOperations(operations: PendingSyncOperation[]): SyncReplayRequest[] {
  return operations.flatMap((operation) => {
    try {
      return [authorIdentityView(transportOperation(operation))];
    } catch {
      return [];
    }
  });
}

type EntryUpdateOperation = Extract<SyncReplayRequest, { operationKind: 'entry.update' }>;
type EntryAuthorsOperation = Extract<SyncReplayRequest, { operationKind: 'entry.authors.set' }>;
type EntryAuthorCreateOperation = Extract<SyncReplayRequest, { operationKind: 'entry.author.create-and-link' }>;
type EntryTagsOperation = Extract<SyncReplayRequest, { operationKind: 'entry.tags.set' }>;
type EntryUsageOperation = Extract<SyncReplayRequest, { operationKind: 'entry.usage' }>;
type EntryViewLaterOperation = Extract<SyncReplayRequest, { operationKind: 'entry.view-later.set' }>;
type EntryRatingOperation = Extract<SyncReplayRequest, { operationKind: 'entry.rating.set' }>;
type EntryContentsOperation = Extract<SyncReplayRequest, { operationKind: 'entry.contents.set' }>;
type ProducerViewLaterOperation = Extract<SyncReplayRequest, { operationKind: 'producer.view-later.set' }>;
type ProducerRatingOperation = Extract<SyncReplayRequest, { operationKind: 'producer.rating.set' }>;
type ProducerUpdateOperation = Extract<SyncReplayRequest, { operationKind: 'producer.update' }>;
type ProducerTagsOperation = Extract<SyncReplayRequest, { operationKind: 'producer.tags.set' }>;
type AuthorDirectoriesOperation = Extract<SyncReplayRequest, { operationKind: 'author.directories.set' }>;
type RatingLayoutOperation = Extract<SyncReplayRequest, { operationKind: 'rating-layout.slots.set' }>;
type CollectionProducerOperation = Extract<SyncReplayRequest, { operationKind: 'collection.producer.set' }>;
type OfflineCollectionRecord = Awaited<ReturnType<GalleryApi['createCollection']>>;

function findCollectionRecord(
  collections: OfflineCollectionRecord[],
  collectionId: number,
): OfflineCollectionRecord | undefined {
  for (const collection of collections) {
    if (collection.id === collectionId) return collection;
    const nested = findCollectionRecord(collection.children, collectionId);
    if (nested !== undefined) return nested;
  }
  return undefined;
}



function isCollectionManagementOperation(operation: SyncReplayRequest): boolean {
  return operation.operationKind === 'collection.create'
    || operation.operationKind === 'collection.update'
    || operation.operationKind === 'collection.entry.set'
    || operation.operationKind === 'collection.order.set';
}





type SnapshotContentRow = SyncSnapshot['payload']['entryContents'][number];
function compareContentRows(left: SnapshotContentRow, right: SnapshotContentRow): number {
  const bySortOrder = left.sortOrder - right.sortOrder;
  if (bySortOrder !== 0) return bySortOrder;
  const leftLocal = left.id < 0;
  const rightLocal = right.id < 0;
  if (leftLocal !== rightLocal) return leftLocal ? 1 : -1;
  return leftLocal ? Math.abs(left.id) - Math.abs(right.id) : left.id - right.id;
}

function isEntryUpdateOperation(
  operation: SyncReplayRequest,
): operation is EntryUpdateOperation {
  return operation.operationKind === 'entry.update';
}

function isEntryUsageOperation(
  operation: SyncReplayRequest,
): operation is EntryUsageOperation {
  return operation.operationKind === 'entry.usage';
}

function isEntryViewLaterOperation(
  operation: SyncReplayRequest,
): operation is EntryViewLaterOperation {
  return operation.operationKind === 'entry.view-later.set';
}

function isEntryRatingOperation(
  operation: SyncReplayRequest,
): operation is EntryRatingOperation {
  return operation.operationKind === 'entry.rating.set';
}

function isEntryContentsOperation(
  operation: SyncReplayRequest,
): operation is EntryContentsOperation {
  return operation.operationKind === 'entry.contents.set';
}

function isProducerViewLaterOperation(
  operation: SyncReplayRequest,
): operation is ProducerViewLaterOperation {
  return operation.operationKind === 'producer.view-later.set';
}

function isProducerRatingOperation(
  operation: SyncReplayRequest,
): operation is ProducerRatingOperation {
  return operation.operationKind === 'producer.rating.set';
}

function isProducerUpdateOperation(
  operation: SyncReplayRequest,
): operation is ProducerUpdateOperation {
  return operation.operationKind === 'producer.update';
}

function isProducerTagsOperation(
  operation: SyncReplayRequest,
): operation is ProducerTagsOperation {
  return operation.operationKind === 'producer.tags.set';
}

function ratingLayoutVersionDelta(operation: RatingLayoutOperation): number {
  const baseByUid = new Map(operation.baseValues.slots.map((slot) => [slot.syncUid, slot]));
  return operation.payload.slots.filter((slot) => {
    const base = baseByUid.get(slot.syncUid);
    return base === undefined || base.sortOrder !== slot.sortOrder;
  }).length;
}

function authorDirectorySetVersionDelta(operation: AuthorDirectoriesOperation): number {
  const baseDirectories = new Map(operation.baseValues.directories.map((directory) => [directory.syncUid, directory]));
  let delta = operation.payload.directories.filter((directory) => {
    const base = baseDirectories.get(directory.syncUid);
    return base === undefined || base.title !== directory.title
      || base.description !== directory.description || base.sortOrder !== directory.sortOrder;
  }).length;
  const memberships = (directories: AuthorDirectoriesOperation['payload']['directories']) => {
    const values = new Map<string, number>();
    for (const directory of directories) {
      for (const entry of directory.entries) values.set(`${directory.syncUid}\\0${entry.syncUid}`, entry.sortOrder);
    }
    return values;
  };
  const baseMemberships = memberships(operation.baseValues.directories);
  const desiredMemberships = memberships(operation.payload.directories);
  for (const [key, sortOrder] of baseMemberships) {
    const desiredSortOrder = desiredMemberships.get(key);
    if (desiredSortOrder === undefined || desiredSortOrder !== sortOrder) delta += 1;
  }
  for (const key of desiredMemberships.keys()) {
    if (!baseMemberships.has(key)) delta += 1;
  }
  return delta;
}

function producerVersionDelta(operation: SyncReplayRequest): number {
  if (operation.operationKind === 'producer.view-later.set'
    || operation.operationKind === 'producer.rating.set'
    || operation.operationKind === 'producer.update') return 1;
  if (operation.operationKind === 'producer.tags.set') {
    const base = new Set(operation.baseValues.tags.map((tag) => tag.syncUid));
    const desired = new Set(operation.payload.tags.map((tag) => tag.syncUid));
    return [...base].filter((uid) => !desired.has(uid)).length
      + [...desired].filter((uid) => !base.has(uid)).length;
  }
  return 0;
}

function producerVersionAdvances(operations: SyncReplayRequest[], producerUid: string): number {
  return operations
    .filter((operation) => operation.entityKind === 'producer' && operation.entityUid === producerUid)
    .reduce((total, operation) => total + producerVersionDelta(operation), 0);
}

function entryAuthorsVersionDelta(operation: EntryAuthorsOperation): number {
  const base = new Set(operation.baseValues.producerUids);
  const desired = new Set(operation.payload.producerUids);
  return [...base].filter((uid) => !desired.has(uid)).length
    + [...desired].filter((uid) => !base.has(uid)).length;
}

function entryTagsVersionDelta(operation: EntryTagsOperation): number {
  const base = new Map(operation.baseValues.tags.map((tag) => [normalizeTag(tag.name), tag.facetId]));
  const desired = new Map(operation.payload.tags.map((tag) => [normalizeTag(tag.name), tag.facetId]));
  return [...base].filter(([name, facetId]) => !desired.has(name) || desired.get(name) !== facetId).length
    + [...desired.keys()].filter((name) => !base.has(name)).length;
}

function entryVersionDelta(operation: SyncReplayRequest): number {
  if ((operation.operationKind === 'entry.update' || operation.operationKind === 'entry.contents.set')
    && operation.payload.parentCreateOpId !== undefined) return 0;
  if (operation.operationKind === 'entry.author.create-and-link') return operation.payload.parentCreateOpId === undefined ? 1 : 0;
  if (operation.operationKind === 'entry.authors.set') return operation.payload.parentCreateOpId === undefined ? entryAuthorsVersionDelta(operation) : 0;
  if (operation.operationKind === 'entry.tags.set') return operation.payload.parentCreateOpId === undefined ? entryTagsVersionDelta(operation) : 0;
  return advancesEntryVersion(operation) ? 1 : 0;
}

function advancesEntryVersion(operation: SyncReplayRequest): boolean {
  return operation.operationKind === 'entry.update'
    || operation.operationKind === 'entry.usage'
    || operation.operationKind === 'entry.view-later.set'
    || operation.operationKind === 'entry.rating.set'
    || operation.operationKind === 'entry.contents.set';
}

function applyEntryPatch<T extends SyncSnapshot['payload']['entries'][number]>(
  entry: T,
  patch: EntryUpdateOperation['payload'],
): T {
  return {
    ...entry,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.uploadDate !== undefined ? { uploadDate: patch.uploadDate } : {}),
    ...(patch.pageCount !== undefined ? { pageCount: patch.pageCount } : {}),
  };
}

function serializableTag(tag: EntryTagsOperation['payload']['tags'][number]) {
  return { name: tag.name,
    ...(tag.tagUid === undefined ? {} : { tagUid: tag.tagUid }),
    ...(tag.facetId === undefined ? {} : { facetId: tag.facetId }),
    ...(tag.facetUid === undefined ? {} : { facetUid: tag.facetUid }) };
}

function presentationFacetId(tag: EntryTagsOperation['payload']['tags'][number], groups: SyncSnapshot['payload']['tagGroups']): number {
  if (tag.facetId !== undefined) return tag.facetId;
  const facet = groups.find(row => row.groupKind === 'facet' && row.syncUid?.toLowerCase() === tag.facetUid?.toLowerCase());
  if (!facet) throw new Error('Refresh the offline copy; a stable Facet identity is missing');
  return facet.id;
}

function snapshotWithOverlays(
  snapshot: SyncSnapshot,
  operations: PendingSyncOperation[],
): SyncSnapshot {
  snapshot = {...snapshot,payload:{...snapshot.payload,
    entries:snapshot.payload.entries.map(row=>({...row,...(row.syncUid ? {syncUid:row.syncUid.toLowerCase()} : {})})),
    producers:snapshot.payload.producers.map(row=>({...row,...(row.syncUid ? {syncUid:row.syncUid.toLowerCase()} : {})}))}};
  const parsed = parsedEntryOperations(operations);
  const entryOperations = parsed.filter(isEntryUpdateOperation);
  const entryAuthorRelationOperations = parsed.filter((operation): operation is EntryAuthorsOperation | EntryAuthorCreateOperation => (
    operation.operationKind === 'entry.authors.set' || operation.operationKind === 'entry.author.create-and-link'
  ));
  const entryTagsOperations = parsed.filter((operation): operation is EntryTagsOperation => (
    operation.operationKind === 'entry.tags.set'
  ));
  const usageOperations = parsed.filter(isEntryUsageOperation);
  const viewLaterOperations = parsed.filter(isEntryViewLaterOperation);
  const ratingOperations = parsed.filter(isEntryRatingOperation);
  const contentsOperations = parsed.filter(isEntryContentsOperation);
  const producerViewLaterOperations = parsed.filter(isProducerViewLaterOperation);
  const producerRatingOperations = parsed.filter(isProducerRatingOperation);
  const producerUpdateOperations = parsed.filter(isProducerUpdateOperation);
  const producerTagsOperations = parsed.filter(isProducerTagsOperation);
  const authorDirectoryOperations = parsed.filter((operation): operation is AuthorDirectoriesOperation => (
    operation.operationKind === 'author.directories.set'
  ));
  const ratingLayoutOperations = parsed.filter((operation): operation is RatingLayoutOperation => (
    operation.operationKind === 'rating-layout.slots.set'
  ));
  const collectionCreateOperations = parsed.filter((operation): operation is Extract<SyncReplayRequest, { operationKind: 'collection.create' }> => (
    operation.operationKind === 'collection.create'
  ));
  const collectionUpdateOperations = parsed.filter((operation): operation is Extract<SyncReplayRequest, { operationKind: 'collection.update' }> => (
    operation.operationKind === 'collection.update'
  ));
  const collectionEntryOperations = parsed.filter((operation): operation is Extract<SyncReplayRequest, { operationKind: 'collection.entry.set' }> => (
    operation.operationKind === 'collection.entry.set'
  ));
  const collectionOrderOperations = parsed.filter((operation): operation is Extract<SyncReplayRequest, { operationKind: 'collection.order.set' }> => (
    operation.operationKind === 'collection.order.set'
  ));
  const collectionProducerOperations = parsed.filter((operation): operation is CollectionProducerOperation => (
    operation.operationKind === 'collection.producer.set'
  ));
  const entryCreateOperations = parsed.filter((operation): operation is Extract<SyncReplayRequest, { operationKind: 'entry.create' }> => (
    operation.operationKind === 'entry.create'
  ));
  const galleryOrderOperations = parsed.filter((operation): operation is Extract<SyncReplayRequest, {operationKind: 'gallery.order.set'}> => operation.operationKind === 'gallery.order.set');
  const galleryOrder = galleryOrderOperations.reduce((current, operation) => current === undefined ? current : ({
    ...current, syncVersion: operation.baseVersion + 1, orderedTypes: [...operation.payload.orderedTypes],
  }), snapshot.payload.galleryOrder);
  const mediaOrderOperations = parsedMediaOrderOperations(operations);
  if (entryOperations.length === 0
    && entryCreateOperations.length === 0
    && mediaOrderOperations.length === 0
    && entryAuthorRelationOperations.length === 0
    && entryTagsOperations.length === 0
    && !parsed.some(operation => operation.operationKind === 'entry.tag.create' || operation.operationKind === 'entry.facet.create')
    && usageOperations.length === 0
    && viewLaterOperations.length === 0
    && ratingOperations.length === 0
    && contentsOperations.length === 0
    && producerViewLaterOperations.length === 0
    && producerRatingOperations.length === 0
    && producerUpdateOperations.length === 0
    && producerTagsOperations.length === 0
    && authorDirectoryOperations.length === 0
    && ratingLayoutOperations.length === 0
    && collectionEntryOperations.length === 0
    && galleryOrderOperations.length === 0
    && collectionOrderOperations.length === 0
    && collectionUpdateOperations.length === 0
    && collectionCreateOperations.length === 0
    && collectionProducerOperations.length === 0) return snapshot;

  const entries = snapshot.payload.entries.map((entry) => {
    const patches = entryOperations.filter((operation) => operation.entityUid === entry.syncUid);
    return patches.reduce((current, operation) => applyEntryPatch(current, operation.payload), entry);
  });
  const producers = snapshot.payload.producers.map((producer) => {
    const patches = producerUpdateOperations.filter((operation) => operation.entityUid === producer.syncUid);
    return patches.reduce((current, operation) => ({
      ...current,
      ...(operation.payload.name === undefined ? {} : { name: operation.payload.name.trim() }),
      ...(!Object.hasOwn(operation.payload, 'occupation') ? {} : { occupation: operation.payload.occupation ?? null }),
      ...(!Object.hasOwn(operation.payload, 'artworkRef') ? {} : { artworkRef: operation.payload.artworkRef ?? null }),
      ...(!Object.hasOwn(operation.payload, 'content') ? {} : { content: operation.payload.content ?? null }),
    }), producer);
  });
  // Pending offline creates project as first-class rows with negative local
  // IDs (§27.1 local:<uuid> presentation keys): without them the composer's
  // Entry stays invisible until replay, which reads as a failed create.
  for (const operation of entryCreateOperations) {
    if (entries.some((row) => row.syncUid === operation.entityUid)) continue;
    const localId = localCollectionId(operation.entityUid);
    if (entries.some((row) => row.id === localId)) {
      throw new Error('Local Entry ID collision; cannot safely project this copy');
    }
    entries.push({
      id: localId,
      syncUid: operation.entityUid,
      syncVersion: 0,
      title: operation.payload.title,
      type: operation.payload.type,
      coverRef: null,
      previewRef: null,
      previewRefs: [],
      pageCount: operation.payload.pageCount,
      uploadDate: operation.payload.uploadDate,
      createdAt: operation.clientCreatedAt,
      updatedAt: operation.clientCreatedAt,
    });
  }
  const entryProducers = snapshot.payload.entryProducers.map((relation) => ({ ...relation }));
  const producerIdsByUid = new Map(producers.flatMap((producer) => (
    producer.syncUid === undefined ? [] : [[producer.syncUid, producer.id] as const]
  )));
  for (const operation of entryAuthorRelationOperations) {
    const entry = entries.find((row) => row.syncUid === operation.entityUid);
    if (operation.operationKind === 'entry.author.create-and-link') {
      let producerId = producerIdsByUid.get(operation.payload.producerUid);
      if (producerId === undefined) {
        producerId = localCollectionId(operation.payload.producerUid);
        if (producers.some((row) => row.id === producerId)) {
          throw new Error('Local Author ID collision; cannot safely project this copy');
        }
        producers.push({
          id: producerId, syncUid: operation.payload.producerUid, syncVersion: 1,
          name: operation.payload.name, occupation: null, artworkRef: null, content: null,
        });
        producerIdsByUid.set(operation.payload.producerUid, producerId);
      }
      if (entry !== undefined && !entryProducers.some((row) => row.entryId === entry.id && row.producerId === producerId)) {
        entryProducers.push({ entryId: entry.id, producerId });
      }
      continue;
    }
    if (entry === undefined) continue;
    const desiredProducerIds = operation.payload.producerUids.flatMap((uid) => {
      const producerId = producerIdsByUid.get(uid);
      return producerId === undefined ? [] : [producerId];
    });
    if (desiredProducerIds.length !== operation.payload.producerUids.length) continue;
    for (let index = entryProducers.length - 1; index >= 0; index -= 1) {
      if (entryProducers[index]?.entryId === entry.id) entryProducers.splice(index, 1);
    }
    for (const producerId of desiredProducerIds) entryProducers.push({ entryId: entry.id, producerId });
  }
  entryProducers.sort((left, right) => left.entryId - right.entryId || left.producerId - right.producerId);
  const tagGroups = snapshot.payload.tagGroups.map(row => ({ ...row }));
  const tags = snapshot.payload.tags.map((tag) => ({ ...tag }));
  for (const operation of parsed) {
    if (operation.operationKind === 'entry.tag.create' && !tags.some(row => row.syncUid?.toLowerCase() === operation.entityUid.toLowerCase())) {
      tags.push({ id: localCollectionId(operation.entityUid.toLowerCase()), syncUid: operation.entityUid,
        name: operation.payload.name, normalizedName: normalizeTag(operation.payload.name) });
    }
    if (operation.operationKind === 'entry.facet.create' && !tagGroups.some(row => row.syncUid?.toLowerCase() === operation.entityUid.toLowerCase())) {
      const section = tagGroups.find(row => row.syncUid?.toLowerCase() === operation.payload.sectionUid.toLowerCase()
        && row.groupKind === 'section' && row.entryType === operation.payload.entryType);
      if (!section) throw new Error('Refresh the offline copy; the new Facet owning Section is missing');
      tagGroups.push({ id: localCollectionId(operation.entityUid.toLowerCase()), syncUid: operation.entityUid,
        entryType: operation.payload.entryType, name: operation.payload.name, groupKind: 'facet', parentId: section.id,
        sortOrder: Math.max(-1, ...tagGroups.filter(row => row.parentId === section.id).map(row => row.sortOrder)) + 1 });
    }
  }
  const entryTags = snapshot.payload.entryTags.map((assignment) => ({ ...assignment }));
  const tagIdsByName = new Map(tags.map((tag) => [tag.normalizedName, tag.id]));
  let nextLocalTagId = tags.reduce((maximum, tag) => Math.max(maximum, tag.id), 0) + 1;
  for (const operation of entryTagsOperations) {
    const entry = entries.find((row) => row.syncUid === operation.entityUid);
    if (entry === undefined) continue;
    for (let index = entryTags.length - 1; index >= 0; index -= 1) {
      if (entryTags[index]?.entryId === entry.id) entryTags.splice(index, 1);
    }
    for (const desired of operation.payload.tags) {
      const normalizedName = normalizeTag(desired.name);
      let tagId = tagIdsByName.get(normalizedName);
      if (tagId === undefined) {
        tagId = nextLocalTagId++;
        tagIdsByName.set(normalizedName, tagId);
        tags.push({ id: tagId, name: desired.name, normalizedName });
      }
      const facetId = presentationFacetId(desired, tagGroups);
      entryTags.push({ entryId: entry.id, tagId, facetId });
    }
  }
  const producerTags = snapshot.payload.producerTags.map((tag) => ({ ...tag }));
  const producerTagAssignments = snapshot.payload.producerTagAssignments.map((assignment) => ({ ...assignment }));
  const tagUidToId = new Map(producerTags.flatMap((tag) => (
    tag.syncUid === undefined ? [] : [[tag.syncUid, tag.id] as const]
  )));
  let nextLocalProducerTagId = producerTags.reduce((maximum, tag) => Math.max(maximum, tag.id), 0) + 1;
  for (const operation of producerTagsOperations) {
    const producer = producers.find((row) => row.syncUid === operation.entityUid);
    if (producer === undefined) continue;
    const desiredByUid = new Map(operation.payload.tags.map((tag) => [tag.syncUid, tag]));
    const assignmentUids = new Map(producerTags.flatMap((tag) => (
      tag.syncUid === undefined ? [] : [[tag.id, tag.syncUid] as const]
    )));
    for (let index = producerTagAssignments.length - 1; index >= 0; index -= 1) {
      const assignment = producerTagAssignments[index];
      if (assignment?.producerId !== producer.id) continue;
      const tagUid = assignmentUids.get(assignment.tagId);
      if (tagUid === undefined || !desiredByUid.has(tagUid)) producerTagAssignments.splice(index, 1);
    }
    for (const desired of operation.payload.tags) {
      let tagId = tagUidToId.get(desired.syncUid);
      if (tagId === undefined) {
        tagId = nextLocalProducerTagId;
        nextLocalProducerTagId += 1;
        tagUidToId.set(desired.syncUid, tagId);
        producerTags.push({ id: tagId, syncUid: desired.syncUid, name: desired.name, normalizedName: normalizeTag(desired.name) });
      }
      if (!producerTagAssignments.some((assignment) => assignment.producerId === producer.id && assignment.tagId === tagId)) {
        producerTagAssignments.push({ producerId: producer.id, tagId });
      }
    }
  }
  const authorDirectories = snapshot.payload.authorDirectories.map((directory) => ({ ...directory }));
  const authorDirectorySets = (snapshot.payload.authorDirectorySets ?? []).map((directorySet) => ({ ...directorySet }));
  const authorDirectoryEntries = snapshot.payload.authorDirectoryEntries.map((membership) => ({ ...membership }));
  let nextLocalDirectoryId = -1;
  for (const operation of authorDirectoryOperations) {
    const directorySet = authorDirectorySets.find((row) => row.syncUid === operation.entityUid);
    const producer = directorySet === undefined ? undefined : producers.find((row) => row.id === directorySet.producerId);
    if (directorySet === undefined || producer === undefined) continue;
    const existingDirectories = authorDirectories.filter((directory) => directory.producerId === producer.id);
    const directoryIdsByUid = new Map(existingDirectories.flatMap((directory) => (
      directory.syncUid === undefined ? [] : [[directory.syncUid, directory.id] as const]
    )));
    const desiredDirectories = operation.payload.directories.map((directory) => {
      let id = directoryIdsByUid.get(directory.syncUid);
      if (id === undefined) {
        id = nextLocalDirectoryId;
        nextLocalDirectoryId -= 1;
        directoryIdsByUid.set(directory.syncUid, id);
      }
      return {
        id,
        syncUid: directory.syncUid,
        producerId: producer.id,
        title: directory.title,
        description: directory.description,
        sortOrder: directory.sortOrder,
      };
    });
    const entryIdsByUid = new Map(entries.flatMap((entry) => (
      entry.syncUid === undefined ? [] : [[entry.syncUid, entry.id] as const]
    )));
    const desiredMemberships = operation.payload.directories.flatMap((directory) => {
      const directoryId = directoryIdsByUid.get(directory.syncUid);
      if (directoryId === undefined) return [];
      return directory.entries.flatMap((entry) => {
        const entryId = entryIdsByUid.get(entry.syncUid);
        return entryId === undefined ? [] : [{
          directoryId,
          producerId: producer.id,
          entryId,
          sortOrder: entry.sortOrder,
        }];
      });
    });
    for (let index = authorDirectories.length - 1; index >= 0; index -= 1) {
      if (authorDirectories[index]?.producerId === producer.id) authorDirectories.splice(index, 1);
    }
    authorDirectories.push(...desiredDirectories);
    for (let index = authorDirectoryEntries.length - 1; index >= 0; index -= 1) {
      if (authorDirectoryEntries[index]?.producerId === producer.id) authorDirectoryEntries.splice(index, 1);
    }
    authorDirectoryEntries.push(...desiredMemberships);
    directorySet.syncVersion += authorDirectorySetVersionDelta(operation);
  }

  const collections = snapshot.payload.collections.map((collection) => ({ ...collection }));
  const collectionMembers = snapshot.payload.collectionMembers.map((member) => ({ ...member }));
  for (const operation of collectionCreateOperations) {
    if (collections.some((row) => row.syncUid === operation.entityUid)) continue;
    const parent = operation.payload.parentUid === null
      ? undefined
      : collections.find((row) => row.syncUid === operation.payload.parentUid);
    if (operation.payload.parentUid !== null && parent === undefined) continue;
    const parentId = parent?.id ?? null;
    const localId = localCollectionId(operation.entityUid);
    if (collections.some((row) => row.id === localId)) {
      throw new Error('Local Collection ID collision; cannot safely project this copy');
    }
    const sortOrder = collections.filter((row) => row.kind === operation.payload.kind && row.parentId === parentId)
      .reduce((maximum, row) => Math.max(maximum, row.sortOrder), -1) + 1;
    collections.push({
      id: localId,
      syncUid: operation.entityUid,
      syncVersion: 1,
      kind: operation.payload.kind,
      title: operation.payload.title,
      description: operation.payload.description,
      nsfw: operation.payload.nsfw,
      parentId,
      sortOrder,
      galleryType: parent?.galleryType ?? operation.payload.galleryType,
    });
  }
  for (const operation of collectionUpdateOperations) {
    const collection = collections.find((row) => row.syncUid === operation.entityUid);
    if (collection === undefined || collection.syncVersion === undefined) continue;
    if (operation.payload.title !== undefined) collection.title = operation.payload.title;
    if (operation.payload.description !== undefined) collection.description = operation.payload.description;
    if (operation.payload.nsfw !== undefined) collection.nsfw = operation.payload.nsfw;
    collection.syncVersion += 1;
  }
  for (const operation of collectionOrderOperations) {
    const baseByUid = new Map(operation.baseValues.collections.map((row) => [row.syncUid, row]));
    for (const [sortOrder, uid] of operation.payload.orderedCollectionUids.entries()) {
      const collection = collections.find((row) => row.syncUid === uid);
      if (collection === undefined || collection.syncVersion === undefined) continue;
      if (baseByUid.get(uid)?.sortOrder !== sortOrder) {
        collection.sortOrder = sortOrder;
        collection.syncVersion += 1;
      }
    }
  }
  const collectionEntryIdsByUid = new Map(entries.flatMap((entry) => (
    entry.syncUid === undefined ? [] : [[entry.syncUid, entry.id] as const]
  )));
  for (const operation of collectionEntryOperations) {
    const collection = collections.find((row) => row.syncUid === operation.entityUid);
    const entryId = collectionEntryIdsByUid.get(operation.payload.entryUid);
    if (collection === undefined || entryId === undefined || collection.syncVersion === undefined) continue;
    const index = collectionMembers.findIndex((member) => (
      member.collectionId === collection.id && 'entryId' in member && member.entryId === entryId
    ));
    if (operation.payload.present && index < 0) {
      const position = collectionMembers
        .filter((member) => member.collectionId === collection.id)
        .reduce((maximum, member) => Math.max(maximum, member.position), -1) + 1;
      collectionMembers.push({ collectionId: collection.id, entryId, position });
    } else if (!operation.payload.present && index >= 0) {
      collectionMembers.splice(index, 1);
    }
    collection.syncVersion += 1;
  }
  for (const operation of collectionProducerOperations) {
    const collection = collections.find((row) => row.syncUid === operation.entityUid);
    const producer = producers.find((row) => row.syncUid === operation.payload.producerUid);
    if (collection === undefined || producer === undefined || collection.syncVersion === undefined) continue;
    const index = collectionMembers.findIndex((member) => (
      member.collectionId === collection.id && 'producerId' in member && member.producerId === producer.id
    ));
    if (operation.payload.present && index < 0) {
      const position = collectionMembers
        .filter((member) => member.collectionId === collection.id)
        .reduce((maximum, member) => Math.max(maximum, member.position), -1) + 1;
      collectionMembers.push({ collectionId: collection.id, producerId: producer.id, position });
    } else if (!operation.payload.present && index >= 0) {
      collectionMembers.splice(index, 1);
    }
    collection.syncVersion += 1;
  }

  // A queued media order (or deletion) shows up locally the moment it is
  // queued: the copy renders the list the person just arranged.
  for (const operation of mediaOrderOperations) {
    const entry = entries.find((row) => row.syncUid === operation.entityUid);
    if (entry === undefined) continue;
    // The base is the future wire position; the current projection holds the
    // original cached picture. Resolve by the explicitly retained base ordinal.
    const currentRefs = [...(entry.coverRef ? [entry.coverRef] : []), ...entry.previewRefs];
    const visibleRefs = operation.payload.refs.map(ref => currentRefs[operation.baseValues.refs.indexOf(ref)] ?? (/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/u.test(ref) ? ref : undefined))
      .filter((ref): ref is string => ref !== undefined);
    entry.coverRef = visibleRefs[0] ?? null;
    entry.previewRefs = visibleRefs.slice(1);
    entry.previewRef = visibleRefs[1] ?? null;
    if (typeof entry.syncVersion === 'number') entry.syncVersion += 1;
  }
  const entryIdsByUid = new Map(entries.map((entry) => [entry.syncUid, entry.id]));
  const usageByEntryId = new Map(snapshot.payload.entryUsage.map((usage) => [
    usage.entryId,
    { ...usage },
  ]));
  // Pending creates carry their initial state in the create payload itself:
  // zero usage, optional View later. Without zero rows the fresh local Entry
  // reads as usage-less rather than untouched in the grid.
  for (const operation of entryCreateOperations) {
    const entryId = entryIdsByUid.get(operation.entityUid);
    if (entryId === undefined) continue;
    if (!usageByEntryId.has(entryId)) {
      usageByEntryId.set(entryId, { entryId, viewCount: 0, likeCount: 0, lastViewedAt: null });
    }
  }
  for (const operation of usageOperations) {
    const entryId = entryIdsByUid.get(operation.entityUid);
    if (entryId === undefined) continue;
    const current = usageByEntryId.get(entryId) ?? {
      entryId,
      viewCount: 0,
      likeCount: 0,
      lastViewedAt: null,
    };
    if (operation.payload.event === 'view') {
      current.viewCount += 1;
      if (current.lastViewedAt === null || operation.clientCreatedAt > current.lastViewedAt) {
        current.lastViewedAt = operation.clientCreatedAt;
      }
    } else {
      current.likeCount += 1;
    }
    usageByEntryId.set(entryId, current);
  }
  const viewLaterEntries = snapshot.payload.viewLaterEntries.map((membership) => ({ ...membership }));
  let nextViewLaterPosition = viewLaterEntries.reduce(
    (maximum, membership) => Math.max(maximum, membership.position),
    -1,
  ) + 1;
  for (const operation of viewLaterOperations) {
    const entryId = entryIdsByUid.get(operation.entityUid);
    if (entryId === undefined) continue;
    const existingIndex = viewLaterEntries.findIndex((membership) => membership.subjectId === entryId);
    if (operation.payload.present && existingIndex < 0) {
      viewLaterEntries.push({ subjectId: entryId, position: nextViewLaterPosition });
      nextViewLaterPosition += 1;
    } else if (!operation.payload.present && existingIndex >= 0) {
      viewLaterEntries.splice(existingIndex, 1);
    }
  }
  for (const operation of entryCreateOperations) {
    const entryId = entryIdsByUid.get(operation.entityUid);
    if (entryId === undefined || !operation.payload.viewLater) continue;
    if (!viewLaterEntries.some((membership) => membership.subjectId === entryId)) {
      viewLaterEntries.push({ subjectId: entryId, position: nextViewLaterPosition });
      nextViewLaterPosition += 1;
    }
  }
  const viewLaterProducers = snapshot.payload.viewLaterProducers
    .map((membership) => ({ ...membership }))
    .sort((left, right) => left.position - right.position || left.subjectId - right.subjectId);
  for (const operation of producerViewLaterOperations) {
    const producer = snapshot.payload.producers.find((row) => row.syncUid === operation.entityUid);
    if (producer === undefined) continue;
    const existingIndex = viewLaterProducers.findIndex((membership) => membership.subjectId === producer.id);
    if (operation.payload.present && existingIndex < 0) {
      const nextPosition = viewLaterProducers.reduce(
        (maximum, membership) => Math.max(maximum, membership.position), -1,
      ) + 1;
      viewLaterProducers.push({ subjectId: producer.id, position: nextPosition });
    } else if (!operation.payload.present && existingIndex >= 0) {
      viewLaterProducers.splice(existingIndex, 1);
      viewLaterProducers.forEach((membership, position) => { membership.position = position; });
    }
  }
  const ratingSlots = snapshot.payload.ratingSlots.map((slot) => ({ ...slot }));
  const ratingLayouts = (snapshot.payload.ratingLayouts ?? []).map((layout) => ({ ...layout }));
  let nextLocalRatingSlotId = ratingSlots.reduce((maximum, slot) => Math.max(maximum, slot.id), 0) + 1;
  for (const operation of ratingLayoutOperations) {
    const layout = ratingLayouts.find((row) => row.syncUid === operation.entityUid);
    if (layout === undefined) continue;
    for (const desired of operation.payload.slots) {
      const existing = ratingSlots.find((slot) => slot.syncUid === desired.syncUid);
      if (existing !== undefined) {
        existing.sortOrder = desired.sortOrder;
      } else {
        ratingSlots.push({
          id: nextLocalRatingSlotId,
          syncUid: desired.syncUid,
          subjectKind: layout.subjectKind,
          entryType: layout.entryType,
          name: desired.name,
          sortOrder: desired.sortOrder,
        });
        nextLocalRatingSlotId += 1;
      }
    }
    layout.syncVersion += ratingLayoutVersionDelta(operation);
  }
  ratingSlots.sort((left, right) => left.subjectKind.localeCompare(right.subjectKind)
    || left.entryType.localeCompare(right.entryType)
    || left.sortOrder - right.sortOrder
    || left.id - right.id);
  const entryRatingValues = snapshot.payload.entryRatingValues.map((value) => ({ ...value }));
  const ratingSlotIdsByUid = new Map(ratingSlots.flatMap((slot) => (
    slot.syncUid === undefined ? [] : [[slot.syncUid, slot.id] as const]
  )));
  for (const operation of ratingOperations) {
    const entryId = entryIdsByUid.get(operation.entityUid);
    const slotId = ratingSlotIdsByUid.get(operation.payload.slotUid);
    if (entryId === undefined || slotId === undefined) continue;
    const existingIndex = entryRatingValues.findIndex((value) => (
      value.entryId === entryId && value.slotId === slotId
    ));
    const desired = {
      entryId,
      slotId,
      stars: operation.payload.stars,
    };
    if (existingIndex >= 0) entryRatingValues[existingIndex] = desired;
    else entryRatingValues.push(desired);
  }
  for (const operation of entryCreateOperations) {
    const entryId = entryIdsByUid.get(operation.entityUid);
    if (entryId === undefined) continue;
    for (const rating of operation.payload.ratings) {
      const slotId = rating.slotUid === undefined ? rating.slotId : ratingSlotIdsByUid.get(rating.slotUid);
      if (slotId === undefined) continue;
      const existingIndex = entryRatingValues.findIndex((value) => (
        value.entryId === entryId && value.slotId === slotId
      ));
      const desired = {
        entryId,
        slotId,
        stars: rating.stars,
      };
      if (existingIndex >= 0) entryRatingValues[existingIndex] = desired;
      else entryRatingValues.push(desired);
    }
  }
  const producerRatingValues = snapshot.payload.producerRatingValues.map((value) => ({ ...value }));
  for (const operation of producerRatingOperations) {
    const producer = snapshot.payload.producers.find((row) => row.syncUid === operation.entityUid);
    const slotId = ratingSlotIdsByUid.get(operation.payload.slotUid);
    if (producer === undefined || slotId === undefined) continue;
    const existingIndex = producerRatingValues.findIndex((value) => (
      value.producerId === producer.id && value.slotId === slotId
    ));
    const desired = {
      producerId: producer.id,
      slotId,
      stars: operation.payload.stars,
    };
    if (existingIndex >= 0) producerRatingValues[existingIndex] = desired;
    else producerRatingValues.push(desired);
  }

  const originalContentsByUid = new Map(snapshot.payload.entryContents.flatMap((content) => (
    content.syncUid === undefined ? [] : [[content.syncUid, content] as const]
  )));
  const localContentIds = new Map<string, number>();
  let nextLocalContentId = -1;
  for (const operation of contentsOperations) {
    for (const content of [...operation.baseValues.contents, ...operation.payload.contents]) {
      if (!originalContentsByUid.has(content.syncUid) && !localContentIds.has(content.syncUid)) {
        localContentIds.set(content.syncUid, nextLocalContentId);
        nextLocalContentId -= 1;
      }
    }
  }
  const entryContents = snapshot.payload.entryContents.map((content) => ({ ...content }));
  for (const operation of entryCreateOperations) {
    const entryId = entryIdsByUid.get(operation.entityUid);
    if (entryId === undefined) continue;
    for (const desired of operation.payload.contents ?? []) {
      if (entryContents.some((content) => content.syncUid === desired.syncUid)) continue;
      entryContents.push({
        id: localCollectionId(desired.syncUid),
        entryId,
        syncUid: desired.syncUid,
        syncVersion: 1,
        contentType: desired.contentType,
        content: desired.content,
        sortOrder: desired.sortOrder,
      });
    }
  }
  for (const operation of contentsOperations) {
    const entryId = entryIdsByUid.get(operation.entityUid);
    if (entryId === undefined) continue;
    for (let index = entryContents.length - 1; index >= 0; index -= 1) {
      if (entryContents[index]?.entryId === entryId) entryContents.splice(index, 1);
    }
    for (const desired of operation.payload.contents) {
      const original = originalContentsByUid.get(desired.syncUid);
      entryContents.push({
        id: original?.id ?? localContentIds.get(desired.syncUid) ?? nextLocalContentId,
        entryId,
        syncUid: desired.syncUid,
        syncVersion: original?.syncVersion ?? 1,
        contentType: desired.contentType,
        content: desired.content,
        sortOrder: desired.sortOrder,
      });
      if (original === undefined && !localContentIds.has(desired.syncUid)) {
        localContentIds.set(desired.syncUid, nextLocalContentId);
        nextLocalContentId -= 1;
      }
    }
  }

  return {
    ...snapshot,
    payload: {
      ...snapshot.payload,
      galleryOrder,
      entries,
      producers,
      entryProducers,
      tags,
      tagGroups,
      entryTags,
      producerTags,
      producerTagAssignments,
      entryContents,
      ratingSlots,
      ratingLayouts,
      collections,
      collectionMembers,
      authorDirectories,
      authorDirectorySets,
      authorDirectoryEntries,
      entryUsage: [...usageByEntryId.values()].sort((left, right) => left.entryId - right.entryId),
      viewLaterEntries,
      viewLaterProducers,
      entryRatingValues,
      producerRatingValues,
    },
  };
}

function viewLaterStateFromSnapshot(snapshot: SyncSnapshot): ViewLaterState {
  const byPosition = (
    left: SyncSnapshot['payload']['viewLaterEntries'][number],
    right: SyncSnapshot['payload']['viewLaterEntries'][number],
  ) => left.position - right.position || left.subjectId - right.subjectId;
  return {
    entryIds: [...snapshot.payload.viewLaterEntries].sort(byPosition).map((row) => row.subjectId),
    producerIds: [...snapshot.payload.viewLaterProducers].sort(byPosition).map((row) => row.subjectId),
  };
}

function entryRecordFromSnapshot(
  entry: SyncSnapshot['payload']['entries'][number],
  patch: UpdateEntryRequest,
): EntryRecordDto {
  return {
    id: entry.id,
    title: patch.title ?? entry.title,
    type: entry.type,
    coverRef: entry.coverRef,
    previewRef: entry.previewRef,
    previewRefs: entry.previewRefs,
    uploadDate: patch.uploadDate === undefined ? entry.uploadDate : patch.uploadDate,
    pageCount: patch.pageCount === undefined ? entry.pageCount : patch.pageCount,
  };
}

function producerTagValuesFromSnapshot(
  snapshot: SyncSnapshot,
  producerId: number,
): ProducerTagsOperation['payload']['tags'] {
  const tagsById = new Map(snapshot.payload.producerTags.map((tag) => [tag.id, tag]));
  return snapshot.payload.producerTagAssignments
    .filter((assignment) => assignment.producerId === producerId)
    .map((assignment) => {
      const tag = tagsById.get(assignment.tagId);
      if (tag?.syncUid === undefined) {
        throw new Error('Refresh this offline copy before editing Author tags; stable tag identities are missing');
      }
      return { syncUid: tag.syncUid, name: tag.name };
    })
    .sort((left, right) => left.syncUid < right.syncUid ? -1 : 1);
}

function producerDirectoriesFromSnapshot(
  snapshot: SyncSnapshot,
  producerId: number,
): AuthorDirectoriesOperation['payload']['directories'] {
  const entriesById = new Map(snapshot.payload.entries.map((entry) => [entry.id, entry]));
  return snapshot.payload.authorDirectories
    .filter((directory) => directory.producerId === producerId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
    .map((directory) => {
      if (directory.syncUid === undefined) {
        throw new Error('Refresh this offline copy before editing Directories; stable identities are missing');
      }
      const entries = snapshot.payload.authorDirectoryEntries
        .filter((membership) => membership.directoryId === directory.id && membership.producerId === producerId)
        .sort((left, right) => left.sortOrder - right.sortOrder || left.entryId - right.entryId)
        .map((membership) => {
          const entry = entriesById.get(membership.entryId);
          if (entry?.syncUid === undefined) {
            throw new Error('Refresh this offline copy before editing Directory membership; stable Entry identities are missing');
          }
          return { syncUid: entry.syncUid, sortOrder: membership.sortOrder };
        });
      return {
        syncUid: directory.syncUid,
        title: directory.title,
        description: directory.description,
        sortOrder: directory.sortOrder,
        entries,
      };
    });
}

function producerRecordFromSnapshot(
  producer: SyncSnapshot['payload']['producers'][number],
): Awaited<ReturnType<GalleryApi['updateAuthor']>> {
  return {
    id: producer.id,
    name: producer.name,
    occupation: producer.occupation,
    artworkRef: producer.artworkRef,
    content: producer.content,
  };
}

export function createOfflineAwareGalleryApi(
  online: GalleryApi,
  store: OfflineStore,
  options: OfflineApiOptions = {},
): GalleryApi {
  let mode: OfflineApiState['mode'] = options.state?.mode ?? 'online';
  let cachedLibraryKey: string | null = null;
  let cachedLibrary: OfflineLibrary | null = null;
  let loadingLibrary: Promise<OfflineLibrary | null> | null = null;
  const stagedObjectUrls = new Map<string, string>();
  let replayPromise: Promise<void> | null = null;
  const randomUUID = options.randomUUID ?? randomUuid;
  let clientId = options.clientId ?? '';
  let identityReady: Promise<void> | undefined;
  function ensureClientIdentity(): Promise<void> {
    return identityReady ??= getClientIdentity(store, options.clientId, randomUUID).then(value => { clientId = value; });
  }
  let pendingRestorePreview: {text:string;identity:string} | null = null;
  const reconciliationListeners = new Set<(ids: ReadonlyMap<number, number>) => void>();

  async function resolveCollectionId(id: number): Promise<{ id: number; pending: boolean }> {
    if (id > 0) return { id, pending: false };
    const active = await readActiveSnapshot(store);
    const authoritative = active?.snapshot.payload.collections.find((row) => (
      row.syncUid !== undefined && localCollectionId(row.syncUid) === id
    ));
    if (authoritative !== undefined) return { id: authoritative.id, pending: false };
    if (hasOutbox(store) && (await store.list()).some((operation) => (
      operation.operationKind === 'collection.create' && localCollectionId(operation.entityUid) === id
    ))) return { id, pending: true };
    throw new Error('Local Collection is no longer available; refresh Collections');
  }

  function setMode(nextMode: OfflineApiState['mode']): void {
    mode = nextMode;
    if (options.state !== undefined) options.state.mode = nextMode;
  }

  function setConnectionPhase(phase: Exclude<OfflineApiState['connectionPhase'], undefined>): void {
    if (options.state !== undefined) options.state.connectionPhase = phase;
  }

  function isOnlineMode(): boolean { return mode === 'online'; }

  /**
   * Whether the stored snapshot belongs to a library other than the one the
   * native shell is currently paired to. Serving such a copy would show the
   * wrong collection and queue edits against the wrong sync identities, so
   * every path that serves the local copy must refuse it — not only the mode
   * switch, whose guard is bypassed by the per-call transport fallback.
   */
  async function localSnapshotLibraryMismatch(): Promise<boolean> {
    if (options.nativeShellLibraryId === undefined) return false;
    const shellLibraryId = await options.nativeShellLibraryId() ?? null;
    if (shellLibraryId === null) return false;
    const active = await readActiveSnapshot(store);
    return active !== null && active.snapshot.header.libraryId !== shellLibraryId;
  }

  function recordFallbackLibraryMismatch(): void {
    if (options.state !== undefined && options.fallbackLibraryMismatchMessage !== undefined) {
      options.state.lastReplayError = options.fallbackLibraryMismatchMessage;
    }
  }

  /** The media refs an Entry holds right now, from the copy or from the server. */
  async function entryMediaRefsOf(entryId: number): Promise<string[]> {
    try {
      const active = await readActiveSnapshot(store);
      const local = active?.snapshot.payload.entries.find((row) => row.id === entryId);
      if (local !== undefined) {
        return [...(local.coverRef === null ? [] : [local.coverRef]), ...local.previewRefs];
      }
      const remote = await online.getEntry(entryId);
      return [...(remote.coverRef === null ? [] : [remote.coverRef]), ...remote.previewRefs];
    } catch {
      return [];
    }
  }

  /**
   * Media keeps positional names, so an edited list reuses URLs for different
   * bytes: after any media write the cached pictures behind the refs it touched
   * are wrong until they are dropped (both the stored bytes and the object URLs
   * built from them). Only those refs are touched — walking the whole cache is
   * what made an edit take seconds on a large library.
   */
  async function forgetEntryMedia(refs: readonly string[]): Promise<void> {
    // A fixture or an embedder may hand in a facade without URL building; a
    // missing address is not a reason to fail the edit that just succeeded.
    const assetUrl = online.assetUrl?.bind(online);
    if (assetUrl === undefined) return;
    await evictEntryMediaRefs(refs, { assetUrl, objectUrls: cachedMediaObjectUrls });
  }

  async function preferOfflineSnapshot(reason: 'startup' | 'disconnect' = 'startup'): Promise<boolean> {
    // The pointer read is cheap; the large snapshot is loaded on demand and
    // shared by parallel home requests. Outbox and capability flags survive.
    const generation = Number(await store.readMeta(ACTIVE_GENERATION_KEY));
    if (!Number.isSafeInteger(generation) || generation <= 0) return false;
    if (await localSnapshotLibraryMismatch()) {
      recordFallbackLibraryMismatch();
      return false;
    }
    setMode('offline');
    setConnectionPhase(reason === 'disconnect' ? 'switching' : 'opening-copy');
    return true;
  }

  async function diagnoseMutation<T>(
    action: NonNullable<OfflineApiState['lastMutationDiagnostic']>['action'],
    capabilityKey: string,
    run: () => Promise<T>,
  ): Promise<T> {
    let capability: string | null = null;
    let beforeCount: number | null = null;
    try {
      capability = await store.readMeta(capabilityKey);
      beforeCount = hasOutbox(store) ? (await store.list()).length : null;
    } catch {
      // Diagnostics must never change mutation behavior.
    }
    const diagnostic: NonNullable<OfflineApiState['lastMutationDiagnostic']> = {
      at: new Date().toISOString(),
      action,
      modeBefore: mode,
      modeAfter: mode,
      capability,
      result: 'running',
      transportClassified: null,
      errorName: null,
      errorMessage: null,
    };
    if (options.state !== undefined) {
      options.state.lastMutationDiagnostic = diagnostic;
      options.state.mutationDiagnostics = [
        ...(options.state.mutationDiagnostics ?? []),
        diagnostic,
      ].slice(-8);
    }
    try {
      const result = await run();
      let afterCount: number | null = null;
      try {
        afterCount = hasOutbox(store) ? (await store.list()).length : null;
      } catch {
        // Keep the successful mutation result even if this diagnostic read fails.
      }
      Object.assign(diagnostic, {
        modeAfter: mode,
        result: beforeCount !== null && afterCount !== null && afterCount > beforeCount
          ? 'queued'
          : 'online-or-noop',
      });
      if (options.state !== undefined) options.state.lastMutationDiagnostic = { ...diagnostic };
      return result;
    } catch (cause) {
      Object.assign(diagnostic, {
        modeAfter: mode,
        result: 'error',
        transportClassified: isOfflineTransportError(cause),
        errorName: cause instanceof Error ? cause.name : typeof cause,
        errorMessage: cause instanceof Error ? cause.message : String(cause),
      });
      if (options.state !== undefined) options.state.lastMutationDiagnostic = { ...diagnostic };
      throw cause;
    }
  }

  function setReplayState(
    pendingCount: number,
    conflictCount = 0,
    failedCount = 0,
    error: string | null = null,
  ): void {
    if (options.state === undefined) return;
    options.state.pendingCount = pendingCount;
    options.state.conflictCount = conflictCount;
    options.state.failedCount = failedCount;
    options.state.lastReplayError = error;
  }

  function setReplayStateFromOperations(
    operations: PendingSyncOperation[],
    fallbackError: string | null = null,
  ): void {
    const pending = operations.filter((operation) => operation.status === 'pending').length;
    const conflicts = operations.filter((operation) => operation.status === 'conflict').length;
    const failures = operations.filter((operation) => operation.status === 'failed').length;
    const storedError = operations.find((operation) => operation.lastError !== null)?.lastError ?? fallbackError;
    setReplayState(pending, conflicts, failures, storedError);
  }

  async function setReplayStateFromStore(fallbackError: string | null = null): Promise<void> {
    const operations = await listOperations();
    const media = hasMediaOutbox(store) ? await store.listMedia() : [];
    const pending = operations.filter((operation) => operation.status === 'pending').length
      + media.filter((upload) => upload.status === 'pending').length;
    const conflicts = operations.filter((operation) => operation.status === 'conflict').length;
    const failures = operations.filter((operation) => operation.status === 'failed').length
      + media.filter((upload) => upload.status === 'failed').length;
    const storedError = operations.find((operation) => operation.lastError !== null)?.lastError
      ?? media.find((upload) => upload.lastError !== null)?.lastError
      ?? fallbackError;
    setReplayState(pending, conflicts, failures, storedError);
  }

  function invalidateOfflineLibrary(): void {
    cachedLibraryKey = null;
    cachedLibrary = null;
    loadingLibrary = null;
  }

  async function listOperations(): Promise<PendingSyncOperation[]> {
    return hasOutbox(store) ? store.list() : [];
  }

  async function loadOfflineLibrary(): Promise<OfflineLibrary | null> {
    if (loadingLibrary !== null) return loadingLibrary;
    const pending = (async () => {
      const startedAt = performance.now();
      const generationId = await store.readMeta(ACTIVE_GENERATION_KEY);
      if (generationId === null || generationId === '0') return null;
      const operations = await listOperations();
      const media = hasMediaOutbox(store) ? await store.listMedia() : [];
      const key = `${generationId}:${operations.map(operationFingerprint).join('|')}:${mediaQueueIdentity(media)}`;
      if (cachedLibrary !== null && cachedLibraryKey === key) return cachedLibrary;
      const active = await readActiveSnapshot(store);
      if (active === null) return null;
      // Receipt-verified candidate identity affects projection, never cleanup.
      let settled: {checksum: string; operations: string[]; media: string[]} | undefined;
      try { settled = JSON.parse(await store.readMeta('verifiedReplayProjection') ?? 'null') ?? undefined; } catch { /* malformed metadata grants nothing */ }
      const covered = settled?.checksum === active.snapshot.header.checksum ? settled : undefined;
      const projected = snapshotWithOverlays(active.snapshot, operations.filter(row => row.clientId === clientId && row.libraryId === active.snapshot.header.libraryId && row.syncEpoch === active.snapshot.header.syncEpoch
        && !covered?.operations.includes(operationFingerprint(row))));
      // A queued create's staged cover is shown from its own bytes: the work
      // is visible with its picture the moment it is created offline, instead
      // of waiting for the replay to move the file onto the server.
      const liveUploadIds = new Set(media.map(row => row.uploadId));
      for (const [id, ref] of stagedObjectUrls) {
        if (!liveUploadIds.has(id)) { URL.revokeObjectURL(ref.split('#')[0]!); stagedObjectUrls.delete(id); }
      }
      for (const row of [...media].sort((a, b) => a.kind === b.kind ? a.ordinal - b.ordinal : a.kind === 'cover' ? -1 : 1)) {
        if (row.libraryId !== active.snapshot.header.libraryId || row.syncEpoch !== active.snapshot.header.syncEpoch || covered?.media.includes(row.uploadId)) continue;
        const entry = projected.payload.entries.find(entry => entry.syncUid === row.entryUid);
        if (!entry) continue;
        // A snapshot may already contain a committed upload while its ACK is
        // uncertain. Do not project that durable row a second time.
        const existingRefs = [entry.coverRef, ...entry.previewRefs];
        const committed = active.snapshot.payload.entries.find(entry => entry.syncUid === row.entryUid);
        if ([committed?.coverRef, ...(committed?.previewRefs ?? [])].some(ref => ref?.includes(`.${row.uploadId}.`))) continue;
        const selected = existingRefs.find(ref => ref?.includes(`.${row.uploadId}.`));
        const orders = parsedMediaOrderOperations(operations).filter(op => op.entityUid === row.entryUid);
        if (!selected && orders.some(op => op.baseValues.refs.some(ref => ref.includes(`.${row.uploadId}.`)))) continue;
        let ref = stagedObjectUrls.get(row.uploadId);
        if (!ref) { ref = `${URL.createObjectURL(row.blob)}#t3-upload=${row.uploadId}`; stagedObjectUrls.set(row.uploadId, ref); }
        if (selected) {
          if (entry.coverRef === selected) entry.coverRef = ref;
          entry.previewRefs = entry.previewRefs.map(value => value === selected ? ref! : value);
        } else if (row.kind === 'cover') { if (entry.coverRef === null) entry.coverRef = ref; }
        else entry.previewRefs.push(ref);
        entry.previewRef = entry.previewRefs[0] ?? null;
      }
      const library = createOfflineLibrary(projected);
      if (options.state !== undefined) options.state.lastLocalLoadMs = Math.round(performance.now() - startedAt);
      cachedLibraryKey = key;
      cachedLibrary = library;
      return library;
    })();
    loadingLibrary = pending;
    try {
      return await pending;
    } finally {
      if (loadingLibrary === pending) loadingLibrary = null;
    }
  }

  async function withFallback<T>(
    onlineCall: () => Promise<T>,
    offlineCall: (library: OfflineLibrary) => T,
  ): Promise<T> {
    if (mode === 'offline') {
      try {
        const library = await loadOfflineLibrary();
        if (library !== null) {
          if (await localSnapshotLibraryMismatch()) {
            // The copy no longer belongs to the paired library; do not serve it.
            recordFallbackLibraryMismatch();
            setMode('online');
            setConnectionPhase('no-copy');
          } else {
            // An authoritative probe can finish while the large local copy is
            // opening. Never let an older offline read overwrite that transition.
            if (isOnlineMode()) return withFallback(onlineCall, offlineCall);
            setConnectionPhase(null);
            return offlineCall(library);
          }
        }
      } catch {
        // IndexedDB can be transiently unavailable; retry the authoritative API.
      }
      setMode('online');
      setConnectionPhase('no-copy');
    }
    try {
      const result = await boundedRead(onlineCall, options.onlineReadTimeoutMs ?? 3_000);
      setMode('online');
      setConnectionPhase(null);
      return result;
    } catch (onlineError) {
      // A deadline is safe for reads, never for writes: a late completed write
      // could otherwise be replayed a second time.
      if (!isOfflineTransportError(onlineError) && !(onlineError instanceof OfflineReadTimeout)) {
        throw onlineError;
      }
      setConnectionPhase('switching');
      let library;
      try {
        library = await loadOfflineLibrary();
      } catch {
        setConnectionPhase('no-copy');
        throw onlineError;
      }
      if (library === null || await localSnapshotLibraryMismatch()) {
        // No usable local copy (or one from another library): stay honest and
        // report the failed connection rather than serve the wrong collection.
        if (library !== null) recordFallbackLibraryMismatch();
        setConnectionPhase('no-copy');
        throw onlineError;
      }
      setMode('offline');
      if (options.state !== undefined) options.state.lastFallbackAt = new Date().toISOString();
      setConnectionPhase(null);
      return offlineCall(library);
    }
  }

  async function enqueueEntryUpdate(
    entryId: number,
    input: UpdateEntryRequest,
    transportError: unknown,
  ): Promise<EntryRecordDto> {
    if (!hasOutbox(store)) throw transportError;
    const unsupported = Object.keys(input).some((key) => !['title', 'uploadDate', 'pageCount'].includes(key));
    if (unsupported || Object.keys(input).length === 0) throw transportError;
    const active = await readActiveSnapshot(store);
    const original = active?.snapshot.payload.entries.find((entry) => entry.id === entryId);
    if (active === null || original?.syncUid === undefined || original.syncVersion === undefined) {
      throw transportError;
    }

    const operations = await store.list();
    const parsed = parsedEntryOperations(operations);
    const earlier = parsed
      .filter(isEntryUpdateOperation)
      .filter((operation) => operation.entityUid === original.syncUid);
    const versionAdvances = parsed
      .filter((operation) => operation.entityUid === original.syncUid)
      .reduce((total, operation) => total + entryVersionDelta(operation), 0);
    const current = earlier.reduce((entry, operation) => applyEntryPatch(entry, operation.payload), original);
    const payload = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.uploadDate !== undefined ? { uploadDate: input.uploadDate } : {}),
      ...(input.pageCount !== undefined ? { pageCount: input.pageCount } : {}),
    };
    const baseValues = {
      ...(input.title !== undefined ? { title: current.title } : {}),
      ...(input.uploadDate !== undefined ? { uploadDate: current.uploadDate } : {}),
      ...(input.pageCount !== undefined ? { pageCount: current.pageCount } : {}),
    };
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'entry',
      entityUid: original.syncUid,
      operationKind: 'entry.update',
      baseVersion: original.syncVersion + versionAdvances,
      baseValues,
      payload,
    }, { randomUUID });
    const normalized = {
      ...operation,
      ...transportOperation(operation),
    } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = await store.list();
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
    return entryRecordFromSnapshot(current, input);
  }

  async function enqueueUsageEvent(
    entryId: number,
    event: EntryUsageOperation['payload']['event'],
    transportError?: unknown,
  ): Promise<UsageInfo> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline usage storage is unavailable');
    if (await store.readMeta(USAGE_EVENTS_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline View and Like events; update it while online');
    }
    const active = await readActiveSnapshot(store);
    const original = active?.snapshot.payload.entries.find((entry) => entry.id === entryId);
    if (active === null || original?.syncUid === undefined) {
      throw transportError ?? new Error('Entry is unavailable in the offline copy');
    }

    const operations = await store.list();
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'entry',
      entityUid: original.syncUid,
      operationKind: 'entry.usage',
      baseVersion: 0,
      baseValues: {},
      payload: { event },
    }, { randomUUID });
    const normalized = {
      ...operation,
      ...transportOperation(operation),
    } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
    const usage = snapshotWithOverlays(active.snapshot, pending).payload.entryUsage
      .find((row) => row.entryId === entryId);
    return usage === undefined
      ? { viewCount: 0, likeCount: 0, lastViewedAt: null }
      : {
          viewCount: usage.viewCount,
          likeCount: usage.likeCount,
          lastViewedAt: usage.lastViewedAt,
        };
  }

  async function enqueueEntryViewLater(
    entryId: number,
    desiredPresent: boolean,
    transportError?: unknown,
  ): Promise<ViewLaterState> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline View later storage is unavailable');
    if (await store.readMeta(ENTRY_VIEW_LATER_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline View later; update it while online');
    }
    const active = await readActiveSnapshot(store);
    const original = active?.snapshot.payload.entries.find((entry) => entry.id === entryId);
    if (active === null || original?.syncUid === undefined || original.syncVersion === undefined) {
      throw transportError ?? new Error('Entry is unavailable in the offline copy');
    }

    const operations = await store.list();
    const parsed = parsedEntryOperations(operations);
    const projectedBefore = snapshotWithOverlays(active.snapshot, operations);
    const present = projectedBefore.payload.viewLaterEntries
      .some((membership) => membership.subjectId === entryId);
    if (present === desiredPresent) return viewLaterStateFromSnapshot(projectedBefore);
    const versionAdvances = parsed
      .filter((operation) => operation.entityUid === original.syncUid)
      .reduce((total, operation) => total + entryVersionDelta(operation), 0);
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'entry',
      entityUid: original.syncUid,
      operationKind: 'entry.view-later.set',
      baseVersion: original.syncVersion + versionAdvances,
      baseValues: { present },
      payload: { present: desiredPresent },
    }, { randomUUID });
    const normalized = {
      ...operation,
      ...transportOperation(operation),
    } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
    return viewLaterStateFromSnapshot(snapshotWithOverlays(active.snapshot, pending));
  }

  async function enqueueDurably(operation: PendingSyncOperation): Promise<void> {
    if (!hasOutbox(store)) throw new Error('Offline mutation storage is unavailable');
    // Only NEW envelopes acquire the complete crossqueue Entry revision.
    if (operation.entityKind === 'entry' && operation.baseVersion > 0 && hasMediaOutbox(store)) {
      const active = await readActiveSnapshot(store);
      const owner = active?.snapshot.payload.entries.find(row => row.syncUid === operation.entityUid);
      if (owner?.syncVersion !== undefined) {
        const prior = await store.list();
        const advances = parsedEntryOperations(prior).filter(row => row.entityUid === operation.entityUid).reduce((total,row)=>total+entryVersionDelta(row),0)
          + parsedMediaOrderOperations(prior).filter(row=>row.entityUid===operation.entityUid).length;
        const media = (await store.listMedia()).filter(row=>row.entryUid===operation.entityUid && row.existingEntry);
        operation = {...operation,baseVersion:owner.syncVersion+advances+media.length};
      }
    }
    await store.enqueue(operation);
    // Durable canonical commit precedes the retry mirror. Native failure must never
    // report a failed mutation or invite a second submit with a new UUID.
    try { await options.nativeTransfers?.handoff(); } catch { /* unchanged foreground retry remains available */ }
  }

  async function enqueueProducerViewLater(
    producerId: number,
    desiredPresent: boolean,
    transportError?: unknown,
  ): Promise<ViewLaterState> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Producer View later storage is unavailable');
    if (await store.readMeta(PRODUCER_VIEW_LATER_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Producer View later; update it while online');
    }
    const active = await readActiveSnapshot(store);
    const original = active?.snapshot.payload.producers.find((producer) => producer.id === producerId);
    if (active === null || original?.syncUid === undefined || original.syncVersion === undefined) {
      throw transportError ?? new Error('Producer is unavailable in the offline copy or is missing stable identity/version; update it while online');
    }

    const operations = await store.list();
    const parsed = parsedEntryOperations(operations);
    const projectedBefore = snapshotWithOverlays(active.snapshot, operations);
    const present = projectedBefore.payload.viewLaterProducers
      .some((membership) => membership.subjectId === producerId);
    if (present === desiredPresent) return viewLaterStateFromSnapshot(projectedBefore);
    const nextBaseVersion = original.syncVersion + producerVersionAdvances(parsed, original.syncUid);
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'producer',
      entityUid: original.syncUid,
      operationKind: 'producer.view-later.set',
      baseVersion: nextBaseVersion,
      baseValues: { present },
      payload: { present: desiredPresent },
    }, { randomUUID });
    const normalized = {
      ...operation,
      ...transportOperation(operation),
    } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
    return viewLaterStateFromSnapshot(snapshotWithOverlays(active.snapshot, pending));
  }

  async function enqueueProducerRating(
    producerId: number,
    slotId: number,
    desiredStars: number | null,
    transportError?: unknown,
  ): Promise<RatingRow> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Producer rating storage is unavailable');
    if (await store.readMeta(PRODUCER_RATING_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Author ratings; update it while online');
    }
    const active = await readActiveSnapshot(store);
    const original = active?.snapshot.payload.producers.find((producer) => producer.id === producerId);
    if (active === null || original?.syncUid === undefined || original.syncVersion === undefined) {
      throw transportError ?? new Error('Author is unavailable in the offline copy or is missing stable identity/version; update it while online');
    }
    const operations = await store.list();
    const parsed = parsedEntryOperations(operations);
    const projectedBefore = snapshotWithOverlays(active.snapshot, operations);
    const slot = projectedBefore.payload.ratingSlots.find((candidate) => (
      candidate.id === slotId && candidate.subjectKind === 'producer'
    ));
    if (slot?.syncUid === undefined) {
      throw new Error('Author rating slot is unavailable in this offline copy; update it while online');
    }

    const currentStars = projectedBefore.payload.producerRatingValues.find((value) => (
      value.producerId === producerId && value.slotId === slotId
    ))?.stars ?? null;
    if (currentStars === desiredStars) return { slotId, name: slot.name, stars: desiredStars };
    const nextBaseVersion = original.syncVersion + producerVersionAdvances(parsed, original.syncUid);
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'producer',
      entityUid: original.syncUid,
      operationKind: 'producer.rating.set',
      baseVersion: nextBaseVersion,
      baseValues: { slotUid: slot.syncUid, stars: currentStars },
      payload: { slotUid: slot.syncUid, stars: desiredStars },
    }, { randomUUID });
    const normalized = {
      ...operation,
      ...transportOperation(operation),
    } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
    return { slotId, name: slot.name, stars: desiredStars };
  }

  async function enqueueProducerProfileUpdate(
    authorId: number,
    input: UpdateProducerRequest,
    transportError?: unknown,
  ): Promise<Awaited<ReturnType<GalleryApi['updateAuthor']>>> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Author profile storage is unavailable');
    if (await store.readMeta(PRODUCER_PROFILE_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Author profile editing; update it while online');
    }
    const active = await readActiveSnapshot(store);
    const original = active?.snapshot.payload.producers.find((producer) => producer.id === authorId);
    if (active === null || original?.syncUid === undefined || original.syncVersion === undefined) {
      throw transportError ?? new Error('Author is unavailable in the offline copy or is missing stable identity/version');
    }
    const operations = await store.list();
    const parsed = parsedEntryOperations(operations);
    const projected = snapshotWithOverlays(active.snapshot, operations);
    const current = projected.payload.producers.find((producer) => producer.id === authorId);
    if (current === undefined) throw new Error('Author is unavailable in the offline copy');

    const payload: Record<string, string | null> = {};
    if (input.name !== undefined && input.name.trim() !== current.name) payload.name = input.name.trim();
    if (Object.hasOwn(input, 'occupation') && (input.occupation ?? null) !== current.occupation) {
      payload.occupation = input.occupation ?? null;
    }
    if (Object.hasOwn(input, 'artworkRef') && (input.artworkRef ?? null) !== current.artworkRef) {
      payload.artworkRef = input.artworkRef ?? null;
    }
    if (Object.hasOwn(input, 'content') && (input.content ?? null) !== current.content) {
      payload.content = input.content ?? null;
    }
    if (Object.keys(payload).length === 0) return producerRecordFromSnapshot(current);

    const baseValues = {
      ...(payload.name === undefined ? {} : { name: current.name }),
      ...(!Object.hasOwn(payload, 'occupation') ? {} : { occupation: current.occupation }),
      ...(!Object.hasOwn(payload, 'artworkRef') ? {} : { artworkRef: current.artworkRef }),
      ...(!Object.hasOwn(payload, 'content') ? {} : { content: current.content }),
    };
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'producer',
      entityUid: original.syncUid,
      operationKind: 'producer.update',
      baseVersion: original.syncVersion + producerVersionAdvances(parsed, original.syncUid),
      baseValues,
      payload,
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
    const updated = snapshotWithOverlays(active.snapshot, pending).payload.producers.find((producer) => producer.id === authorId);
    if (updated === undefined) throw new Error('Author profile could not be updated in the offline copy');
    return producerRecordFromSnapshot(updated);
  }

  async function enqueueProducerTags(
    authorId: number,
    mutate: (tags: ProducerTagsOperation['payload']['tags'], snapshot: SyncSnapshot) => ProducerTagsOperation['payload']['tags'],
    transportError?: unknown,
  ): Promise<void> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Author tag storage is unavailable');
    if (await store.readMeta(PRODUCER_TAGS_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Author tag editing; update it while online');
    }
    const active = await readActiveSnapshot(store);
    const original = active?.snapshot.payload.producers.find((producer) => producer.id === authorId);
    if (active === null || original?.syncUid === undefined || original.syncVersion === undefined) {
      throw transportError ?? new Error('Author is unavailable in the offline copy or is missing stable identity/version');
    }
    const operations = await store.list();
    const parsed = parsedEntryOperations(operations);
    const projected = snapshotWithOverlays(active.snapshot, operations);
    const baseTags = producerTagValuesFromSnapshot(projected, authorId);
    const desiredTags = mutate(baseTags, projected).map((tag) => {
      const name = tag.name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
      if (name === '' || normalizeTag(name) === '') throw new Error('Author tag name cannot be empty');
      return { syncUid: tag.syncUid, name };
    }).sort((left, right) => left.syncUid < right.syncUid ? -1 : 1);
    if (JSON.stringify(baseTags) === JSON.stringify(desiredTags)) return;
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'producer',
      entityUid: original.syncUid,
      operationKind: 'producer.tags.set',
      baseVersion: original.syncVersion + producerVersionAdvances(parsed, original.syncUid),
      baseValues: { tags: baseTags },
      payload: { tags: desiredTags },
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
  }

  async function enqueueRatingSlotLayout(
    subjectKind: 'entry' | 'producer',
    subjectId: number,
    mutate: (slots: RatingLayoutOperation['payload']['slots'], snapshot: SyncSnapshot) => RatingLayoutOperation['payload']['slots'],
    transportError?: unknown,
  ): Promise<SyncSnapshot> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline rating slot layout storage is unavailable');
    if (await store.readMeta(RATING_LAYOUT_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline rating-slot editing; update it while online');
    }
    const active = await readActiveSnapshot(store);
    if (active === null) throw transportError ?? new Error('Rating slot layout is unavailable in the offline copy');
    const operations = await store.list();
    const projected = snapshotWithOverlays(active.snapshot, operations);
    const entryType = subjectKind === 'producer'
      ? createOfflineLibrary(projected).getAuthor(subjectId).galleryType
      : projected.payload.entries.find((entry) => entry.id === subjectId)?.type ?? null;
    if (entryType === null) {
      throw new Error(`Cannot edit ${subjectKind} rating slots without a Gallery type`);
    }
    const layout = projected.payload.ratingLayouts?.find((row) => (
      row.subjectKind === subjectKind && row.entryType === entryType
    ));
    if (layout?.syncUid === undefined || layout.syncVersion === undefined) {
      throw new Error('Refresh this offline copy before editing rating slots; stable layout identity/version is missing');
    }
    const currentSlots = projected.payload.ratingSlots
      .filter((slot) => slot.subjectKind === subjectKind && slot.entryType === entryType)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
      .map((slot) => {
        if (slot.syncUid === undefined) {
          throw new Error('Refresh this offline copy before editing rating slots; stable slot identities are missing');
        }
        return { syncUid: slot.syncUid, name: slot.name, sortOrder: slot.sortOrder };
      });
    const desiredSlots = mutate(currentSlots, projected)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.syncUid.localeCompare(right.syncUid));
    if (JSON.stringify(currentSlots) === JSON.stringify(desiredSlots)) return projected;

    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'rating_layout',
      entityUid: layout.syncUid,
      operationKind: 'rating-layout.slots.set',
      baseVersion: layout.syncVersion,
      baseValues: { slots: currentSlots },
      payload: { slots: desiredSlots },
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
    return snapshotWithOverlays(active.snapshot, pending);
  }

  async function enqueueCollectionCreate(
    input: Parameters<GalleryApi['createCollection']>[0],
    transportError?: unknown,
  ): Promise<OfflineCollectionRecord> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Collection storage is unavailable');
    if (await store.readMeta(COLLECTION_MANAGEMENT_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Collection management; update it while online');
    }
    const active = await readActiveSnapshot(store);
    if (active === null) throw transportError ?? new Error('Download an offline copy before creating Collections');
    const title = input.title.trim();
    if (title === '') throw new Error('Collection title cannot be empty');
    const operations = await store.list();
    const projected = snapshotWithOverlays(active.snapshot, operations);
    const parent = input.parentId === undefined
      ? undefined
      : projected.payload.collections.find((row) => row.id === input.parentId);
    if (input.parentId !== undefined && (parent === undefined || parent.kind !== 'entry' || parent.parentId !== null)) {
      throw new Error('Only top-level Entry Collections can contain subcollections');
    }
    if (input.kind === 'producer' && parent !== undefined) {
      throw new Error('Author Collections cannot contain subcollections');
    }
    if (input.parentId !== undefined && parent?.syncUid === undefined) {
      throw new Error('Refresh this offline copy before creating a nested Collection; its parent identity is missing');
    }
    const entityUid = randomUUID();
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'collection',
      entityUid,
      operationKind: 'collection.create',
      baseVersion: 0,
      baseValues: {},
      payload: {
        kind: input.kind,
        title,
        description: input.description ?? '',
        nsfw: false,
        parentUid: parent?.syncUid ?? null,
        galleryType: input.kind === 'entry' ? (parent?.galleryType ?? input.galleryType ?? null) : null,
      },
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
    const updated = snapshotWithOverlays(active.snapshot, pending);
    const created = updated.payload.collections.find((row) => row.syncUid === entityUid);
    const record = created === undefined ? undefined
      : findCollectionRecord(createOfflineLibrary(updated).listCollections(input.kind, true), created.id);
    if (record === undefined) throw new Error('Collection could not be added to the offline copy');
    return record;
  }

  async function enqueueCollectionMetadata(
    collectionId: number,
    input: Parameters<GalleryApi['updateCollection']>[1],
    desiredNsfw?: boolean,
    transportError?: unknown,
  ): Promise<OfflineCollectionRecord> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Collection storage is unavailable');
    if (await store.readMeta(COLLECTION_MANAGEMENT_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Collection management; update it while online');
    }
    const active = await readActiveSnapshot(store);
    if (active === null) throw transportError ?? new Error('Collection is unavailable in the offline copy');
    const operations = await store.list();
    const projected = snapshotWithOverlays(active.snapshot, operations);
    const current = projected.payload.collections.find((row) => row.id === collectionId);
    if (current?.syncUid === undefined || current.syncVersion === undefined) {
      throw transportError ?? new Error('Collection is unavailable or missing stable identity/version; update it while online');
    }
    const baseValues: { title?: string; description?: string; nsfw?: boolean } = {};
    const payload: { title?: string; description?: string; nsfw?: boolean } = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (title === '') throw new Error('Collection title cannot be empty');
      if (title !== current.title) {
        baseValues.title = current.title;
        payload.title = title;
      }
    }
    if (input.description !== undefined && input.description !== current.description) {
      baseValues.description = current.description;
      payload.description = input.description;
    }
    if (desiredNsfw !== undefined && desiredNsfw !== current.nsfw) {
      baseValues.nsfw = current.nsfw;
      payload.nsfw = desiredNsfw;
    }
    const records = createOfflineLibrary(projected).listCollections(current.kind, true);
    if (Object.keys(payload).length === 0) {
      const record = findCollectionRecord(records, collectionId);
      if (record !== undefined) return record;
      throw new Error('Collection is unavailable in the offline copy');
    }
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'collection',
      entityUid: current.syncUid,
      operationKind: 'collection.update',
      baseVersion: current.syncVersion,
      baseValues,
      payload,
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
    const updated = snapshotWithOverlays(active.snapshot, pending);
    const record = findCollectionRecord(createOfflineLibrary(updated).listCollections(current.kind, true), collectionId);
    if (record === undefined) throw new Error('Collection could not be updated in the offline copy');
    return record;
  }

  async function enqueueCollectionEntryMembership(
    collectionId: number,
    entryId: number,
    desiredPresent: boolean,
    transportError?: unknown,
  ): Promise<void> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Collection membership storage is unavailable');
    if (await store.readMeta(COLLECTION_MANAGEMENT_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Collection management; update it while online');
    }
    const active = await readActiveSnapshot(store);
    if (active === null) throw transportError ?? new Error('Collection membership is unavailable in the offline copy');
    const operations = await store.list();
    const projected = snapshotWithOverlays(active.snapshot, operations);
    const collection = projected.payload.collections.find((row) => row.id === collectionId);
    const entry = projected.payload.entries.find((row) => row.id === entryId);
    if (collection?.syncUid === undefined || collection.syncVersion === undefined || entry?.syncUid === undefined) {
      throw transportError ?? new Error('Collection or Entry is unavailable or missing stable identity/version');
    }
    if (collection.kind !== 'entry') throw new Error('This Collection does not accept Entry members');
    const present = projected.payload.collectionMembers.some((member) => (
      member.collectionId === collectionId && 'entryId' in member && member.entryId === entryId
    ));
    if (present === desiredPresent) return;
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'collection',
      entityUid: collection.syncUid,
      operationKind: 'collection.entry.set',
      baseVersion: collection.syncVersion,
      baseValues: { entryUid: entry.syncUid, present },
      payload: { entryUid: entry.syncUid, present: desiredPresent },
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
  }

  async function enqueueGalleryOrder(orderedTypes: string[], transportError?: unknown): Promise<void> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Gallery order storage is unavailable');
    if (await store.readMeta(GALLERY_ORDER_CAPABILITY_KEY) !== '1' || await store.readMeta('capability.offlineMutations') !== '1') {
      throw new Error('Update this offline copy online to enable Gallery ordering');
    }
    const active = await readActiveSnapshot(store);
    if (active === null) throw new Error('No offline copy available');
    const operations = await store.list();
    const projected = snapshotWithOverlays(active.snapshot, operations);
    const scope = projected.payload.galleryOrder;
    if (!scope) throw new Error('Refresh this legacy offline copy before reordering Galleries');
    const current = createOfflineLibrary(projected).listGalleries().map(row => row.type);
    if (orderedTypes.length !== current.length || new Set(orderedTypes).size !== current.length || current.some(type => !orderedTypes.includes(type))) {
      throw new Error('Gallery order must include every Gallery, including hidden Galleries, exactly once');
    }
    if (JSON.stringify(current) === JSON.stringify(orderedTypes)) return;
    const operation = createPendingSyncOperation({ clientId, libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch, entityKind: 'gallery_order', entityUid: scope.syncUid,
      operationKind: 'gallery.order.set', baseVersion: scope.syncVersion,
      baseValues: { orderedTypes: current }, payload: { orderedTypes: [...orderedTypes] },
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    setReplayStateFromOperations([...operations, normalized]);
    invalidateOfflineLibrary(); setMode('offline');
  }

  async function enqueueCollectionOrder(
    kind: 'entry' | 'producer',
    orderedCollectionIds: number[],
    transportError?: unknown,
  ): Promise<void> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Collection ordering storage is unavailable');
    if (await store.readMeta(COLLECTION_MANAGEMENT_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Collection management; update it while online');
    }
    const active = await readActiveSnapshot(store);
    if (active === null) throw transportError ?? new Error('Collection ordering is unavailable in the offline copy');
    const operations = await store.list();
    const projected = snapshotWithOverlays(active.snapshot, operations);
    const current = projected.payload.collections
      .filter((row) => row.kind === kind && row.parentId === null)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id);
    if (orderedCollectionIds.length !== current.length
      || new Set(orderedCollectionIds).size !== current.length
      || orderedCollectionIds.some((id) => !current.some((row) => row.id === id))) {
      throw new Error('Collection order must contain every top-level Collection of this kind exactly once');
    }
    const baseValues = current.map((row) => {
      if (row.syncUid === undefined || row.syncVersion === undefined) {
        throw new Error('Refresh this offline copy before reordering Collections; stable identity/version is missing');
      }
      return { syncUid: row.syncUid, syncVersion: row.syncVersion, sortOrder: row.sortOrder };
    });
    const byId = new Map(current.map((row) => [row.id, row]));
    const orderedCollectionUids = orderedCollectionIds.map((id) => {
      const row = byId.get(id);
      if (row?.syncUid === undefined) throw new Error('Collection order does not match this offline copy');
      return row.syncUid;
    });
    if (baseValues.map((row) => row.syncUid).every((uid, index) => uid === orderedCollectionUids[index])) return;
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'collection_order',
      entityUid: COLLECTION_ORDER_SCOPE_UIDS[kind],
      operationKind: 'collection.order.set',
      baseVersion: baseValues.reduce((total, row) => total + row.syncVersion, 0),
      baseValues: { kind, collections: baseValues },
      payload: { kind, orderedCollectionUids },
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
  }

  async function enqueueCollectionProducerMembership(
    collectionId: number,
    producerId: number,
    desiredPresent: boolean,
    transportError?: unknown,
  ): Promise<void> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Collection membership storage is unavailable');
    if (await store.readMeta(COLLECTION_PRODUCER_MEMBERSHIP_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Collection membership editing; update it while online');
    }
    const active = await readActiveSnapshot(store);
    if (active === null) throw transportError ?? new Error('Collection or Author is unavailable in the offline copy');
    const producer = active.snapshot.payload.producers.find((row) => row.id === producerId);
    if (producer?.syncUid === undefined) {
      throw transportError ?? new Error('Author is unavailable or missing stable identity; update it while online');
    }
    const operations = await store.list();
    const projected = snapshotWithOverlays(active.snapshot, operations);
    const current = projected.payload.collections.find((row) => row.id === collectionId);
    if (current?.syncUid === undefined || current.syncVersion === undefined) {
      throw transportError ?? new Error('Collection is unavailable or missing stable identity/version; update it while online');
    }
    if (current.kind !== 'producer') throw new Error('This Collection does not accept Author members');
    const present = projected.payload.collectionMembers.some((member) => (
      member.collectionId === collectionId && 'producerId' in member && member.producerId === producerId
    ));
    if (present === desiredPresent) return;
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'collection',
      entityUid: current.syncUid,
      operationKind: 'collection.producer.set',
      baseVersion: current.syncVersion,
      baseValues: { producerUid: producer.syncUid, present },
      payload: { producerUid: producer.syncUid, present: desiredPresent },
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
  }

  async function enqueueAuthorDirectories(
    authorId: number,
    mutate: (
      directories: AuthorDirectoriesOperation['payload']['directories'],
      snapshot: SyncSnapshot,
    ) => AuthorDirectoriesOperation['payload']['directories'],
    transportError?: unknown,
  ): Promise<SyncSnapshot> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Directory storage is unavailable');
    if (await store.readMeta(AUTHOR_DIRECTORIES_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Author Directory editing; update it while online');
    }
    const active = await readActiveSnapshot(store);
    const original = active?.snapshot.payload.producers.find((producer) => producer.id === authorId);
    if (active === null || original === undefined) {
      throw transportError ?? new Error('Author is unavailable in the offline copy');
    }
    const operations = await store.list();
    const projected = snapshotWithOverlays(active.snapshot, operations);
    const directorySet = projected.payload.authorDirectorySets?.find((row) => row.producerId === authorId);
    if (directorySet?.syncUid === undefined || directorySet.syncVersion === undefined) {
      throw new Error('Refresh this offline copy before editing Directories; stable Directory-set identity/version is missing');
    }
    const baseDirectories = producerDirectoriesFromSnapshot(projected, authorId);
    const desiredDirectories = mutate(baseDirectories, projected);
    if (JSON.stringify(baseDirectories) === JSON.stringify(desiredDirectories)) return projected;
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'author_directory_set',
      entityUid: directorySet.syncUid,
      operationKind: 'author.directories.set',
      baseVersion: directorySet.syncVersion,
      baseValues: { directories: baseDirectories },
      payload: { directories: desiredDirectories },
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
    return snapshotWithOverlays(active.snapshot, pending);
  }

  async function enqueueEntryAuthorCreate(
    entryId: number,
    rawName: string,
    transportError?: unknown,
  ) {
    const active = await readActiveSnapshot(store);
    if (active === null) throw transportError ?? new Error('Offline Author catalog is unavailable');
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Author Outbox is unavailable');
    if (await store.readMeta(ENTRY_AUTHORS_CAPABILITY_KEY) !== '1'
      || await store.readMeta(AUTHOR_CREATE_CAPABILITY_KEY) !== '1') {
      throw new Error('Refresh this offline copy against a server with offline Author creation before adding Authors');
    }
    const pending = await store.list();
    const projected = snapshotWithOverlays(active.snapshot, pending);
    const entry = projected.payload.entries.find((row) => row.id === entryId);
    if (entry?.syncUid === undefined || entry.syncVersion === undefined) {
      throw new Error('Refresh this offline copy before adding Authors; stable Entry identity is missing');
    }
    const name = rawName.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (!name) throw new Error('Author name cannot be empty');
    const producerUids = projected.payload.entryProducers
      .filter((row) => row.entryId === entryId)
      .map((row) => projected.payload.producers.find((producer) => producer.id === row.producerId)?.syncUid)
      .filter((uid): uid is string => uid !== undefined).sort();
    const producerUid = randomUUID();
    const operation = createPendingSyncOperation({
      clientId, libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch, entityKind: 'entry', entityUid: entry.syncUid,
      operationKind: 'entry.author.create-and-link',
      baseVersion: entry.syncVersion + parsedEntryOperations(pending)
        .filter((row) => row.entityKind === 'entry' && row.entityUid === entry.syncUid)
        .reduce((total, row) => total + entryVersionDelta(row), 0),
      baseValues: { producerUids }, payload: { producerUid, name },
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    setReplayStateFromOperations([...pending, normalized]);
    invalidateOfflineLibrary();
    setMode('offline');
    return { entryId, producerId: localCollectionId(producerUid), producerName: name, created: true };
  }

  async function enqueueEntryAuthors(
    entryId: number,
    authorId: number,
    present: boolean,
    transportError?: unknown,
  ): Promise<void> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Author-link storage is unavailable');
    if (await store.readMeta(ENTRY_AUTHORS_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Entry-Author editing; update it while online');
    }
    const active = await readActiveSnapshot(store);
    const original = active?.snapshot.payload.entries.find((entry) => entry.id === entryId);
    if (active === null || original?.syncUid === undefined || original.syncVersion === undefined) {
      throw new Error('Offline Author-link editing requires a server-synced Entry in the active offline copy');
    }
    const operations = await store.list();
    const parsed = parsedEntryOperations(operations);
    const projected = snapshotWithOverlays(active.snapshot, operations.filter(row => row.clientId === clientId && row.libraryId === active.snapshot.header.libraryId && row.syncEpoch === active.snapshot.header.syncEpoch));
    const author = projected.payload.producers.find((producer) => producer.id === authorId);
    if (author?.syncUid === undefined) {
      throw new Error('Author is unavailable in the offline copy; refresh it while online before linking');
    }
    const currentRelations = projected.payload.entryProducers
      .filter((relation) => relation.entryId === entryId);
    if (present && authorId < 0 && !currentRelations.some((relation) => relation.producerId === authorId)
      && await store.readMeta('capability.offlineCrossEntryPendingAuthors') !== '1') {
      throw new Error('Sync the newly created Author before linking it to another Entry');
    }
    const linkedAuthors = currentRelations.map((relation) => (
      projected.payload.producers.find((row) => row.id === relation.producerId)
    ));
    const baseProducerUids = linkedAuthors
      .flatMap((row) => row?.syncUid === undefined ? [] : [row.syncUid]).sort();
    if (baseProducerUids.length !== currentRelations.length) {
      throw new Error('Refresh this offline copy before editing Authors; a linked Author is missing its stable identity');
    }
    const desired = new Set(baseProducerUids);
    if (present) desired.add(author.syncUid);
    else desired.delete(author.syncUid);
    const desiredProducerUids = [...desired].sort();
    if (JSON.stringify(baseProducerUids) === JSON.stringify(desiredProducerUids)) return;

    const priorVersionAdvances = parsed
      .filter((operation) => operation.entityKind === 'entry' && operation.entityUid === original.syncUid)
      .reduce((count, operation) => count + entryVersionDelta(operation), 0);
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'entry',
      entityUid: original.syncUid,
      operationKind: 'entry.authors.set',
      baseVersion: original.syncVersion + priorVersionAdvances,
      baseValues: { producerUids: baseProducerUids },
      payload: { producerUids: desiredProducerUids, ...await producerCreationDependencies(active.snapshot, operations, [...baseProducerUids,...desiredProducerUids], original.syncUid) },
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
  }

  function reconciledFacetId(id: number, snapshot: SyncSnapshot, operations: PendingSyncOperation[]): number {
    if (id >= 0 || snapshot.payload.tagGroups.some(row => row.id === id)) return id;
    const source = parsedEntryOperations(operations).find(row => row.operationKind === 'entry.facet.create' && localCollectionId(row.entityUid.toLowerCase()) === id);
    if (!source || source.operationKind !== 'entry.facet.create') return id;
    const section = snapshot.payload.tagGroups.find(row => row.syncUid?.toLowerCase() === source.payload.sectionUid.toLowerCase());
    return snapshot.payload.tagGroups.find(row => row.groupKind === 'facet' && row.entryType === source.payload.entryType && row.parentId === section?.id
      && (row.syncUid?.toLowerCase() === source.entityUid.toLowerCase() || row.name === source.payload.name))?.id ?? id;
  }

  function stableTagValues(values: EntryTagsOperation['payload']['tags'], snapshot: SyncSnapshot, operations: PendingSyncOperation[]): EntryTagsOperation['payload']['tags'] {
    return values.map(value => {
      const tag = snapshot.payload.tags.find(row => normalizeTag(row.name) === normalizeTag(value.name));
      const source = operations.find(row => row.operationKind === 'entry.tag.create' && (row.entityUid.toLowerCase() === tag?.syncUid?.toLowerCase() || normalizeTag(String(row.payload.name)) === normalizeTag(value.name)));
      const facet = snapshot.payload.tagGroups.find(row => row.id === value.facetId);
      const facetSource = operations.find(row => row.operationKind === 'entry.facet.create' && row.entityUid.toLowerCase() === facet?.syncUid?.toLowerCase());
      return { name: value.name, ...(source ? { tagUid: source.entityUid } : {}), ...(facetSource ? { facetUid: facetSource.entityUid } : { facetId: value.facetId! }) };
    });
  }

  function tagCreationDependencies(values: EntryTagsOperation['payload']['tags'], operations: PendingSyncOperation[], snapshot: SyncSnapshot) {
    const tagCreates: Array<{tagUid: string; createOpId: string}> = [];
    for (const value of values) {
      if (!value.tagUid || tagCreates.some(row => row.tagUid.toLowerCase() === value.tagUid!.toLowerCase())) continue;
      const source = operations.find(row => row.operationKind === 'entry.tag.create' && row.entityKind === 'entry_tag'
        && row.entityUid.toLowerCase() === value.tagUid!.toLowerCase() && row.clientId === clientId
        && row.libraryId === snapshot.header.libraryId && row.syncEpoch === snapshot.header.syncEpoch);
      if (!source || source.status !== 'pending') throw new Error('Pending Tag source is missing or blocked; refresh and retry');
      tagCreates.push({ tagUid: value.tagUid, createOpId: source.opId });
    }
    const facetCreates: Array<{ facetUid: string; createOpId: string }> = [];
    for (const value of values) {
      if (!value.facetUid || facetCreates.some(row => row.facetUid.toLowerCase() === value.facetUid!.toLowerCase())) continue;
      const source = operations.find(row => row.operationKind === 'entry.facet.create' && row.entityKind === 'entry_facet'
        && row.entityUid.toLowerCase() === value.facetUid!.toLowerCase() && row.clientId === clientId
        && row.libraryId === snapshot.header.libraryId && row.syncEpoch === snapshot.header.syncEpoch);
      if (!source || source.status !== 'pending') throw new Error('Pending Facet source is missing or blocked; refresh and retry');
      facetCreates.push({ facetUid: value.facetUid, createOpId: source.opId });
    }
    return { ...(tagCreates.length ? { tagCreates } : {}), ...(facetCreates.length ? { facetCreates } : {}) };
  }

  async function hasQueuedEntryTags(entryId: number): Promise<boolean> {
    if (!hasOutbox(store)) return false;
    const active = await readActiveSnapshot(store);
    const uid = active?.snapshot.payload.entries.find(row => row.id === entryId)?.syncUid;
    return uid !== undefined && (await store.list()).some(row => row.operationKind === 'entry.tags.set' && row.entityUid.toLowerCase() === uid.toLowerCase()
      && row.clientId === clientId && row.libraryId === active!.snapshot.header.libraryId && row.syncEpoch === active!.snapshot.header.syncEpoch);
  }

  async function hasStagedTag(name: string): Promise<boolean> {
    if (!hasOutbox(store)) return false;
    const active = await readActiveSnapshot(store);
    if (!active) return false;
    return (await store.list()).some(row => row.operationKind === 'entry.tag.create'
      && row.clientId === clientId && row.libraryId === active.snapshot.header.libraryId && row.syncEpoch === active.snapshot.header.syncEpoch
      && normalizeTag(String(row.payload.name)) === normalizeTag(name));
  }

  // Restored from the previously delivered v40 bundle (offline Tag write result).
  async function offlineAssignedTag(entryId: number, input: { facetId: number; name: string }): Promise<EntryTagAssignment | null> {
    try {
      const facet = (await loadOfflineLibrary())?.getEntry(entryId)?.sections
        .flatMap(section => section.facets).find(row => row.id === input.facetId);
      if (facet === undefined) return null;
      const normalized = normalizeTag(input.name);
      const tag = facet.tags.find(row => normalizeTag(row.name) === normalized);
      return tag === undefined ? null : {
        tagId: tag.id, name: tag.name, normalizedName: normalizeTag(tag.name), facetId: facet.id,
      };
    } catch { return null; }
  }

  async function enqueueEntryTags(
    entryId: number,
    mutate: (tags: EntryTagsOperation['payload']['tags'], snapshot: SyncSnapshot) => EntryTagsOperation['payload']['tags'],
    transportError?: unknown,
  ): Promise<void> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Entry Tag storage is unavailable');
    if (await store.readMeta(ENTRY_TAGS_CAPABILITY_KEY) !== '1') throw new Error('This offline copy has not enabled offline Entry Tag editing; update it while online');
    const active = await readActiveSnapshot(store);
    const original = active?.snapshot.payload.entries.find(row => row.id === entryId);
    if (!active || original?.syncUid === undefined || original.syncVersion === undefined) throw new Error('Offline Entry Tag editing requires a server-synced Entry');
    let operations = await store.list();
    if (operations.some(row => row.entityUid.toLowerCase() === original.syncUid!.toLowerCase() && row.status !== 'pending')) throw new Error('Entry Tag editing is blocked');
    let projected = snapshotWithOverlays(active.snapshot, operations);
    const currentTags = projected.payload.entryTags.filter(row => row.entryId === entryId).map(assignment => {
      const tag = projected.payload.tags.find(row => row.id === assignment.tagId);
      if (!tag) throw new Error('An assigned Entry Tag is missing from the offline catalog');
      return { name: tag.name, facetId: assignment.facetId };
    }).sort((a, b) => normalizeTag(a.name).localeCompare(normalizeTag(b.name)));
    const desired = mutate(currentTags, projected).map(tag => ({ ...serializableTag(tag), ...(tag.facetId === undefined ? {} : { facetId: reconciledFacetId(tag.facetId, projected, operations) }), name: tag.name.normalize('NFKC').trim().replace(/\s+/gu, ' ') }))
      .sort((a, b) => normalizeTag(a.name).localeCompare(normalizeTag(b.name)));
    if (new Set(desired.map(tag => normalizeTag(tag.name))).size !== desired.length) throw new Error('An Entry Tag can only be assigned to one Facet');
    for (const tag of desired) {
      const facet = projected.payload.tagGroups.find(row => row.id === tag.facetId);
      if (!tag.name || facet?.groupKind !== 'facet' || facet.entryType !== original.type) throw new Error('The selected Facet is not available for this Entry');
    }
    if (JSON.stringify(currentTags) === JSON.stringify(desired)) return;
    for (const tag of desired) {
      if (!projected.payload.tags.some(row => normalizeTag(row.name) === normalizeTag(tag.name))) {
        tag.name = await ensureOfflineEntryTag(active.snapshot, operations, tag.name);
        operations = await store.list(); projected = snapshotWithOverlays(active.snapshot, operations);
      }
    }
    const base = stableTagValues(currentTags, projected, operations);
    const target = stableTagValues(desired, projected, operations);
    const version = original.syncVersion + parsedEntryOperations(operations)
      .filter(row => row.entityKind === 'entry' && row.entityUid.toLowerCase() === original.syncUid!.toLowerCase())
      .reduce((count, row) => count + entryVersionDelta(row), 0);
    const operation = createPendingSyncOperation({ clientId, libraryId: active.snapshot.header.libraryId, syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'entry', entityUid: original.syncUid, operationKind: 'entry.tags.set', baseVersion: version,
      baseValues: { tags: base.map(serializableTag) }, payload: { tags: target.map(serializableTag), ...tagCreationDependencies([...base, ...target], operations, active.snapshot) } }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized); setReplayStateFromOperations([...operations, normalized]); invalidateOfflineLibrary(); setMode('offline');
  }

  async function enqueueEntryRating(
    entryId: number,
    slotId: number,
    desiredStars: number | null,
    transportError?: unknown,
  ): Promise<RatingRow> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline rating storage is unavailable');
    if (await store.readMeta(ENTRY_RATING_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Entry ratings; update it while online');
    }
    const active = await readActiveSnapshot(store);
    const original = active?.snapshot.payload.entries.find((entry) => entry.id === entryId);
    if (active === null || original?.syncUid === undefined || original.syncVersion === undefined) {
      throw transportError ?? new Error('Entry is unavailable in the offline copy');
    }
    const operations = await store.list();
    const parsed = parsedEntryOperations(operations);
    const projectedBefore = snapshotWithOverlays(active.snapshot, operations);
    const slot = projectedBefore.payload.ratingSlots.find((candidate) => (
      candidate.id === slotId
      && candidate.subjectKind === 'entry'
      && candidate.entryType === original.type
    ));
    if (slot?.syncUid === undefined) {
      throw new Error('Rating slot is unavailable in this offline copy; update it while online');
    }

    const currentStars = projectedBefore.payload.entryRatingValues.find((value) => (
      value.entryId === entryId && value.slotId === slotId
    ))?.stars ?? null;
    if (currentStars === desiredStars) {
      return { slotId, name: slot.name, stars: desiredStars };
    }
    const versionAdvances = parsed
      .filter((operation) => operation.entityUid === original.syncUid)
      .reduce((total, operation) => total + entryVersionDelta(operation), 0);
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'entry',
      entityUid: original.syncUid,
      operationKind: 'entry.rating.set',
      baseVersion: original.syncVersion + versionAdvances,
      baseValues: { slotUid: slot.syncUid, stars: currentStars },
      payload: { slotUid: slot.syncUid, stars: desiredStars },
    }, { randomUUID });
    const normalized = {
      ...operation,
      ...transportOperation(operation),
    } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
    return { slotId, name: slot.name, stars: desiredStars };
  }

  async function enqueueEntryContents(
    entryId: number,
    mutate: (contents: SyncSnapshot['payload']['entryContents']) => SyncSnapshot['payload']['entryContents'],
    transportError?: unknown,
  ): Promise<SyncSnapshot['payload']['entryContents']> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasOutbox(store)) throw transportError ?? new Error('Offline Entry Content storage is unavailable');
    if (await store.readMeta(ENTRY_CONTENTS_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Entry Content editing; update it while online');
    }
    const active = await readActiveSnapshot(store);
    const original = active?.snapshot.payload.entries.find((entry) => entry.id === entryId);
    if (active === null || original?.syncUid === undefined || original.syncVersion === undefined) {
      throw transportError ?? new Error('Entry is unavailable in the offline copy');
    }
    const operations = await store.list();
    const parsed = parsedEntryOperations(operations);
    const before = snapshotWithOverlays(active.snapshot, operations).payload.entryContents
      .filter((content) => content.entryId === entryId)
      .sort(compareContentRows);
    if (before.some((content) => content.syncUid === undefined)) {
      throw new Error('Refresh this offline copy before editing Entry Content; stable Content identities are missing');
    }
    const desired = mutate(before).sort(compareContentRows);
    const toValue = (content: SyncSnapshot['payload']['entryContents'][number]) => ({
      syncUid: content.syncUid!,
      contentType: content.contentType,
      content: content.content,
      sortOrder: content.sortOrder,
    });
    const baseContents = before.map(toValue);
    const desiredContents = desired.map(toValue);
    if (JSON.stringify(baseContents) === JSON.stringify(desiredContents)) return before;

    const versionAdvances = parsed
      .filter((operation) => operation.entityUid === original.syncUid)
      .reduce((total, operation) => total + entryVersionDelta(operation), 0);
    const operation = createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'entry',
      entityUid: original.syncUid,
      operationKind: 'entry.contents.set',
      baseVersion: original.syncVersion + versionAdvances,
      baseValues: { contents: baseContents },
      payload: { contents: desiredContents },
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
    return snapshotWithOverlays(active.snapshot, pending).payload.entryContents
      .filter((content) => content.entryId === entryId)
      .sort(compareContentRows);
  }

  async function getProjectedContent(contentId: number): Promise<
    SyncSnapshot['payload']['entryContents'][number] | null
  > {
    const active = await readActiveSnapshot(store);
    if (active === null) return null;
    const operations = await listOperations();
    return snapshotWithOverlays(active.snapshot, operations).payload.entryContents
      .find((content) => content.id === contentId) ?? null;
  }

  function toEntryContentRecord(content: SyncSnapshot['payload']['entryContents'][number]):
    ReturnType<typeof entryContentRecordSchema.parse> {
    return {
      id: content.id,
      entryId: content.entryId,
      contentType: content.contentType,
      content: content.content,
      sortOrder: content.sortOrder,
    };
  }

  async function hasQueuedEntryContents(entryId: number): Promise<boolean> {
    if (!hasOutbox(store)) return false;
    const active = await readActiveSnapshot(store);
    const entryUid = active?.snapshot.payload.entries.find((entry) => entry.id === entryId)?.syncUid;
    if (entryUid === undefined) return false;
    return (await store.list()).some((stored) => {
      try {
        const operation = transportOperation(stored);
        return operation.entityUid === entryUid && operation.operationKind === 'entry.contents.set';
      } catch {
        return false;
      }
    });
  }

  async function enqueueOfflineEntryCreate(
    input: OfflineEntryCreateRequest,
    transportError?: unknown,
  ): Promise<{ localKey: string }> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasMediaOutbox(store)) throw new Error('Offline create storage is unavailable');
    const active = await readActiveSnapshot(store);
    if (active === null) throw new Error('Download an offline copy before creating Entries offline');
    const preset = input.presetCreateOperation !== undefined && input.presetCreateOperation.operationKind === 'entry.create'
      ? input.presetCreateOperation : undefined;
    if (preset !== undefined && (preset.libraryId !== active.snapshot.header.libraryId || preset.syncEpoch !== active.snapshot.header.syncEpoch)) {
      throw new Error('This offline copy belongs to a different library revision; refresh it while online');
    }
    if (await store.readMeta(ENTRY_CREATE_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Entry creation; update it while online');
    }
    if (((input.contents?.length ?? 0) > 0 || (preset !== undefined && (preset.payload.contents?.length ?? 0) > 0))
      && await store.readMeta(ENTRY_INITIAL_CONTENTS_CAPABILITY_KEY) !== '1') {
      throw new Error('Initial Content on an offline Entry is not supported by this server; update the offline copy while online');
    }
    const title = (preset === undefined ? input.title : preset.payload.title).trim();
    const type = (preset === undefined ? input.type : preset.payload.type).trim();
    if (title.length === 0 || type.length === 0) throw new Error('Title and Gallery are required');
    if (!active.snapshot.payload.entries.some((entry) => entry.type === type)) {
      throw new Error('Offline creation can only use an existing Gallery from this offline copy');
    }
    const previews = input.previewFiles ?? (input.previewFile === null ? [] : [input.previewFile]);
    if (previews.length > 32) throw new Error('Offline Entries can stage at most 32 previews');
    if (previews.length > 1 && await store.readMeta(MEDIA_MULTIPLE_PREVIEWS_CAPABILITY_KEY) !== '1') {
      throw new Error('Multiple previews are not supported by this desktop server; keep this draft and update the offline copy');
    }
    const files = [
      ...(input.coverFile === null ? [] : [{ kind: 'cover' as const, ordinal: 0, file: input.coverFile }]),
      ...previews.map((file, ordinal) => ({ kind: 'preview' as const, ordinal, file })),
    ];
    if (files.length > 0 && await store.readMeta(MEDIA_UPLOAD_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled staged media upload; update it while online');
    }
    const requiredBytes = files.reduce((total, { file }) => total + file.size, 0);
    try {
      const estimate = await globalThis.navigator?.storage?.estimate();
      if (estimate?.quota !== undefined && estimate.usage !== undefined
        && estimate.quota - estimate.usage < Math.ceil(requiredBytes * 1.1)) {
        throw new Error('Not enough browser storage to stage these offline images');
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith('Not enough browser storage')) throw cause;
      // Storage estimation is advisory and is absent on some PWA engines. The
      // multi-store IndexedDB transaction remains the durability boundary.
    }
    const operations = await store.list();
    const ratings = preset === undefined ? await (async () => {
    const parsed = parsedEntryOperations(operations);
    const projected = snapshotWithOverlays(active.snapshot, operations);
    const useStableRatingUids = await store.readMeta(RATING_LAYOUT_CAPABILITY_KEY) === '1';
    const pendingRatingSlotUids = new Set(parsed.flatMap((operation) => newlyCreatedRatingSlotUids(operation)));
    return input.ratings.map((rating) => {
      const slot = projected.payload.ratingSlots.find((candidate) => (
        candidate.id === rating.slotId && candidate.subjectKind === 'entry' && candidate.entryType === type
      ));
      if (slot === undefined) throw new Error('Rating slot is unavailable in the offline copy');
      if (useStableRatingUids) {
        if (slot.syncUid === undefined) {
          throw new Error('Refresh this offline copy before creating a rated Entry; stable rating slot identity is missing');
        }
        return { slotUid: slot.syncUid, stars: rating.stars };
      }
      if (slot.syncUid !== undefined && pendingRatingSlotUids.has(slot.syncUid)) {
        throw new Error('The server does not currently support offline rating-slot creation');
      }
      return { slotId: rating.slotId, stars: rating.stars };
    });
    })() : preset.payload.ratings.map(rating => rating.slotUid === undefined
      ? { slotId: rating.slotId!, stars: rating.stars } : { slotUid: rating.slotUid, stars: rating.stars });
    const entityUid = preset === undefined ? input.syncUid ?? randomUUID() : preset.entityUid;
    const operation: PendingSyncOperation = preset === undefined ? createPendingSyncOperation({
      clientId,
      libraryId: active.snapshot.header.libraryId,
      syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'entry',
      entityUid,
      operationKind: 'entry.create',
      baseVersion: 0,
      baseValues: {},
      payload: {
        title,
        type,
        uploadDate: input.uploadDate,
        pageCount: input.pageCount,
        ratings: ratings,
        viewLater: input.viewLater,
        ...(input.contents === undefined ? {} : { contents: input.contents.map((row, sortOrder) => ({
          syncUid: randomUUID(), contentType: row.contentType.trim(), content: row.content.trim(), sortOrder,
        })) }),
      },
    }, { randomUUID }) : {
      clientId: preset.clientId, libraryId: preset.libraryId, syncEpoch: preset.syncEpoch,
      entityKind: 'entry', entityUid: preset.entityUid, operationKind: 'entry.create',
      baseVersion: 0, baseValues: {}, opId: preset.opId, clientCreatedAt: preset.clientCreatedAt,
      payload: {
        title: preset.payload.title, type: preset.payload.type,
        uploadDate: preset.payload.uploadDate, pageCount: preset.payload.pageCount,
        ratings, viewLater: preset.payload.viewLater,
        ...(preset.payload.contents === undefined ? {} : { contents: preset.payload.contents.map(row => ({
          syncUid: row.syncUid, contentType: row.contentType, content: row.content, sortOrder: row.sortOrder,
        })) }),
      },
      status: 'pending', lastAttemptAt: null, lastError: null,
    };
    const normalized = {
      ...operation,
      ...transportOperation(operation),
    } as PendingSyncOperation;
    const media: StagedMediaUpload[] = [];
    for (const { kind, ordinal, file } of files) {
      if (!ALLOWED_MEDIA_TYPES.has(file.type as StagedMediaUpload['mimeType'])) {
        throw new Error(`Unsupported offline image type: ${file.type || 'unknown'}`);
      }
      if (file.size <= 0 || file.size > MAX_STAGED_MEDIA_BYTES) {
        throw new Error('Offline images must be between 1 byte and 20 MB');
      }
      media.push({
        uploadId: randomUUID(),
        libraryId: normalized.libraryId,
        syncEpoch: normalized.syncEpoch,
        entryUid: entityUid,
        kind,
        ordinal,
        mimeType: file.type as StagedMediaUpload['mimeType'],
        byteLength: file.size,
        sha256: await sha256Hex(file),
        blob: file,
        status: 'pending',
        lastAttemptAt: null,
        lastError: null,
      });
    }
    await store.enqueueEntryCreate(normalized, media);
    // Native is a retry mirror, never the commit authority. Failure cannot invite resubmission.
    try { await options.nativeTransfers?.handoff(); } catch { /* foreground exact retry remains available */ }
    // The Outbox+media transaction is the commit boundary. A later status read
    // must never turn a durable create into a reported failure that invites a
    // second submit with a new identity.
    invalidateOfflineLibrary();
    setMode('offline');
    try {
      await setReplayStateFromStore();
    } catch (cause) {
      setReplayStateFromOperations([...operations, normalized]);
      if (options.state !== undefined) {
        options.state.lastReplayError = `Offline Entry saved, but pending status could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }
    return { localKey: `local:${entityUid}` };
  }

  function pendingContentValues(parent: SyncReplayRequest, snapshot: SyncSnapshot, operations: PendingSyncOperation[]): PendingOfflineEntryContentValue[] {
    if (parent.operationKind !== 'entry.create') throw new Error('Invalid pending create');
    const owner = snapshot.payload.entries.find(row => row.syncUid === parent.entityUid);
    let contents: PendingOfflineEntryContentValue[] = owner
      ? snapshot.payload.entryContents.filter(row => row.entryId === owner.id).map(({syncUid, contentType, content, sortOrder}) => ({syncUid: syncUid!, contentType, content, sortOrder}))
      : (parent.payload.contents ?? []).map((row, sortOrder) => ({...row, sortOrder}));
    for (const row of operations) {
      if (row.entityKind !== 'entry' || row.entityUid !== parent.entityUid || row.clientId !== parent.clientId
        || row.libraryId !== parent.libraryId || row.syncEpoch !== parent.syncEpoch || row.payload.parentCreateOpId !== parent.opId) continue;
      const op = transportOperation(row);
      if (op.operationKind === 'entry.contents.set') contents = op.payload.contents.map(row => ({...row}));
      if (op.operationKind === 'entry.content.append' && !contents.some(row => row.syncUid === op.payload.content.syncUid)) {
        contents.push({...op.payload.content, sortOrder: Math.max(-1, ...contents.map(row => row.sortOrder)) + 1});
      }
    }
    return contents.sort((a,b) => a.sortOrder-b.sortOrder || a.syncUid.localeCompare(b.syncUid));
  }

  async function pendingContentContext(localKey: string) {
    if (!hasOutbox(store)) throw new Error('Offline Content storage is unavailable');
    if (await store.readMeta('capability.offlinePendingEntryContents') !== '1') throw new Error('Pending Entry Contents are not supported');
    if (!/^local:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(localKey)) throw new Error('A pending local Entry key is required');
    const active = await readActiveSnapshot(store);
    if (!active) throw new Error('Download an offline copy first');
    const operations = await store.list();
    const parent = operations.find(row => row.entityKind === 'entry' && row.operationKind === 'entry.create'
      && row.entityUid.toLowerCase() === localKey.slice(6).toLowerCase() && row.clientId === clientId
      && row.libraryId === active.snapshot.header.libraryId && row.syncEpoch === active.snapshot.header.syncEpoch);
    if (!parent) throw new Error('Pending local Entry was not found');
    if (operations.some(row => row.entityKind === 'entry' && row.entityUid === parent.entityUid && row.clientId === clientId
      && row.libraryId === parent.libraryId && row.syncEpoch === parent.syncEpoch && row.status !== 'pending')) throw new Error('Pending Entry is blocked');
    return {parent, operations, contents: pendingContentValues(transportOperation(parent), active.snapshot, operations)};
  }

  async function getPendingOfflineEntryContentOptions(localKey: string) {
    const context = await pendingContentContext(localKey);
    return {contents: context.contents};
  }

  async function enqueueOfflinePendingEntryContents(localKey: string, desired: PendingOfflineEntryContentValue[]): Promise<void> {
    const context = await pendingContentContext(localKey);
    if (!hasOutbox(store)) throw new Error('Offline Content storage is unavailable');
    const contents = desired.map(row => ({...row, syncUid: row.syncUid.toLowerCase()}))
      .sort((a,b) => a.sortOrder-b.sortOrder || a.syncUid.localeCompare(b.syncUid));
    if (contents.some(row => !context.contents.some(base => base.syncUid.toLowerCase() === row.syncUid))) throw new Error('Select an existing pending Content');
    if (new Set(contents.map(row => row.syncUid)).size !== contents.length) throw new Error('Duplicate Content');
    if (JSON.stringify(contents) === JSON.stringify(context.contents)) return;
    const operation = createPendingSyncOperation({clientId, libraryId: context.parent.libraryId, syncEpoch: context.parent.syncEpoch,
      entityKind: 'entry', entityUid: context.parent.entityUid, operationKind: 'entry.contents.set', baseVersion: 0,
      baseValues: {contents: context.contents.map(row => ({...row}))}, payload: {parentCreateOpId: context.parent.opId, contents}}, {randomUUID});
    const normalized = {...operation, ...transportOperation(operation)} as PendingSyncOperation;
    await enqueueDurably(normalized);
    invalidateOfflineLibrary(); setMode('offline');
    try { await setReplayStateFromStore(); } catch (cause) {
      setReplayStateFromOperations([...context.operations, normalized]);
      if (options.state) options.state.lastReplayError = `Pending Contents saved, but status could not be refreshed: ${String(cause)}`;
    }
  }

  async function enqueueOfflinePendingEntryContent(
    localKey: string, row: { contentType: string; content: string },
  ): Promise<void> {
    if (!hasOutbox(store)) throw new Error('Offline Content storage is unavailable');
    if (await store.readMeta(PENDING_ENTRY_CONTENT_APPEND_CAPABILITY_KEY) !== '1') {
      throw new Error('Offline pending Entry Content append is not supported by this server');
    }
    const active = await readActiveSnapshot(store);
    if (active === null) throw new Error('Download an offline copy before appending Content');
    if (!/^local:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(localKey)) {
      throw new Error('A pending local Entry key is required');
    }
    const entityUid = localKey.slice(6);
    const operations = await store.list();
    const create = operations.find((stored) => stored.operationKind === 'entry.create'
      && stored.entityUid === entityUid && stored.clientId === clientId
      && stored.libraryId === active.snapshot.header.libraryId
      && stored.syncEpoch === active.snapshot.header.syncEpoch);
    if (create === undefined) throw new Error('Pending local Entry was not found in this offline copy');
    if (create.status !== 'pending') throw new Error('Pending Entry create is blocked');
    if (transportOperation(create).operationKind !== 'entry.create') throw new Error('Invalid pending Entry create');
    if (operations.some((candidate) => candidate.entityUid === entityUid
      && candidate.clientId === clientId && candidate.libraryId === create.libraryId
      && candidate.syncEpoch === create.syncEpoch && candidate.status !== 'pending')) {
      throw new Error('Pending Entry Content append is blocked by an earlier failure');
    }
    const operation = createPendingSyncOperation({
      clientId, libraryId: create.libraryId, syncEpoch: create.syncEpoch,
      entityKind: 'entry', entityUid, operationKind: 'entry.content.append',
      baseVersion: 0, baseValues: {},
      payload: { parentCreateOpId: create.opId, content: {
        syncUid: randomUUID(), contentType: row.contentType.trim(), content: row.content.trim(),
      } },
    }, { randomUUID });
    await enqueueDurably({ ...operation, ...transportOperation(operation) } as PendingSyncOperation);
    await setReplayStateFromStore();
    invalidateOfflineLibrary();
    setMode('offline');
  }

  function pendingOwnerSnapshotTags(snapshot: SyncSnapshot, entityUid: string): PendingOfflineEntryTagValue[] {
    const owner = snapshot.payload.entries.find(entry => entry.syncUid === entityUid);
    if (!owner) return [];
    return snapshot.payload.entryTags.filter(row => row.entryId === owner.id).flatMap(row => {
      const tag = snapshot.payload.tags.find(candidate => candidate.id === row.tagId);
      return tag ? [{ name: tag.name, facetId: row.facetId }] : [];
    }).sort((a, b) => normalizeTag(a.name).localeCompare(normalizeTag(b.name)));
  }

  async function pendingTagContext(localKey: string) {
    if (!hasOutbox(store)) throw new Error('Offline Tag storage is unavailable');
    if (await store.readMeta(PENDING_ENTRY_TAGS_CAPABILITY_KEY) !== '1') {
      throw new Error('Offline pending Entry Tags are not supported by this server');
    }
    if (!/^local:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(localKey)) {
      throw new Error('A pending local Entry key is required');
    }
    const active = await readActiveSnapshot(store);
    if (!active) throw new Error('Download an offline copy before editing Tags');
    const operations = await store.list();
    const parent = operations.find(row => row.operationKind === 'entry.create'
      && row.entityUid === localKey.slice(6) && row.clientId === clientId
      && row.libraryId === active.snapshot.header.libraryId && row.syncEpoch === active.snapshot.header.syncEpoch);
    if (!parent) throw new Error('Pending local Entry was not found');
    const create = transportOperation(parent);
    if (create.operationKind !== 'entry.create') throw new Error('Invalid pending create');
    const siblings = operations.filter(row => row.entityUid === parent.entityUid
      && row.clientId === clientId && row.libraryId === parent.libraryId && row.syncEpoch === parent.syncEpoch);
    if (siblings.some(row => row.status !== 'pending')) throw new Error('Pending Entry is blocked');
    const tags = parsedEntryOperations(siblings).filter((row): row is EntryTagsOperation =>
      row.operationKind === 'entry.tags.set' && row.payload.parentCreateOpId === parent.opId);
    const projected = snapshotWithOverlays(active.snapshot, operations);
    const facets = projected.payload.tagGroups.filter(row => row.groupKind === 'facet'
      && row.entryType === create.payload.type && projected.payload.tagGroups.some(section =>
        section.id === row.parentId && section.groupKind === 'section' && section.entryType === create.payload.type));
    const transportTags: EntryTagsOperation['payload']['tags'] = tags.at(-1)?.payload.tags ?? pendingOwnerSnapshotTags(active.snapshot, parent.entityUid);
    return { operations, parent, facets, snapshot: projected, transportTags,
      tags: transportTags.map(row => ({ name: row.name, facetId: presentationFacetId(row, projected.payload.tagGroups) })) };
  }

  async function getPendingOfflineEntryTagOptions(localKey: string): Promise<PendingOfflineEntryTagOptions> {
    const context = await pendingTagContext(localKey);
    return { ...(await store.readMeta('capability.offlineEntryFacetCreate') === '1' && context.snapshot.header.sqliteSchemaVersion >= 34 ? {
      canCreateFacet: true,
      sections: context.snapshot.payload.tagGroups.filter(row => row.groupKind === 'section' && row.entryType === context.parent.payload.type && row.syncUid !== undefined).map(row => ({ id: row.id, name: row.name })),
    } : {}), ...(await store.readMeta(ENTRY_TAG_VOCABULARY_CAPABILITY_KEY) === '1' && await store.readMeta('capability.offlinePendingEntryTagCreation') === '1' && context.snapshot.header.sqliteSchemaVersion >= 34 ? { canCreateTag: true } : {}), facets: context.facets.map(({ id, name, parentId }) => ({ id,
      name: name.trim() ? name : context.snapshot.payload.tagGroups.find(section => section.id === parentId)?.name ?? '' })),
      tags: context.tags.map(row => ({ ...row })),
      availableTags: context.snapshot.payload.tags.map(({ id, name }) => ({ id, name })) };
  }

  async function enqueueOfflineFacet(input: { sectionId: number; name: string }): Promise<void> {
    if (!hasOutbox(store) || await store.readMeta('capability.offlineEntryFacetCreate') !== '1') throw new Error('Offline new Facets are not supported; update the offline copy while online');
    const active = await readActiveSnapshot(store);
    if (!active || active.snapshot.header.sqliteSchemaVersion < 34) throw new Error('Download an updated offline copy before creating a Facet');
    const section = active.snapshot.payload.tagGroups.find(row => row.id === input.sectionId && row.groupKind === 'section');
    const layout = active.snapshot.payload.entryTagLayouts?.find(row => row.entryType === section?.entryType);
    if (!section?.syncUid || !layout) throw new Error('Save this Section online and update the offline copy before creating a Facet');
    const name = input.name.trim();
    if (!name) throw new Error('Facet name cannot be empty');
    const operations = await store.list();
    const existing = snapshotWithOverlays(active.snapshot, operations).payload.tagGroups.find(row => row.parentId === section.id && row.groupKind === 'facet' && row.name === name);
    if (existing) return;
    const operation = createPendingSyncOperation({ clientId, libraryId: active.snapshot.header.libraryId, syncEpoch: active.snapshot.header.syncEpoch,
      entityKind: 'entry_facet', entityUid: randomUUID(), operationKind: 'entry.facet.create', baseVersion: layout.syncVersion,
      baseValues: { entryType: section.entryType, sectionUid: section.syncUid }, payload: { entryType: section.entryType, sectionUid: section.syncUid, name } }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized); invalidateOfflineLibrary(); setMode('offline'); setReplayStateFromOperations([...operations, normalized]);
  }

  async function ensureOfflineEntryTag(snapshot: SyncSnapshot, operations: PendingSyncOperation[], name: string): Promise<string> {
    if (!hasOutbox(store) || await store.readMeta(ENTRY_TAG_VOCABULARY_CAPABILITY_KEY) !== '1') {
      throw new Error('Offline new Entry Tags are not supported; update the offline copy while online');
    }
    if (snapshot.header.sqliteSchemaVersion < 34) throw new Error('Offline new Tags are not supported by this saved copy');
    const cleaned = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (!cleaned) throw new Error('Entry Tag name cannot be empty');
    const alias = snapshot.payload.taxonomyAliases?.find(row => row.vocabulary === 'entry'
      && row.normalizedAlias === normalizeTag(cleaned) && row.normalizedCanonical !== '');
    const canonical = alias?.canonicalName ?? cleaned;
    const existing = snapshotWithOverlays(snapshot, operations).payload.tags.find(row => normalizeTag(row.name) === normalizeTag(canonical));
    if (existing) return existing.name;
    const operation = createPendingSyncOperation({ clientId, libraryId: snapshot.header.libraryId,
      syncEpoch: snapshot.header.syncEpoch, entityKind: 'entry_tag', entityUid: randomUUID(),
      operationKind: 'entry.tag.create', baseVersion: 0, baseValues: {}, payload: { name: canonical } }, { randomUUID });
    await enqueueDurably({ ...operation, ...transportOperation(operation) } as PendingSyncOperation);
    invalidateOfflineLibrary(); setMode('offline');
    return canonical;
  }

  async function enqueueOfflinePendingEntryTagCreate(localKey: string, name: string, facetId: number): Promise<void> {
    const context = await pendingTagContext(localKey);
    facetId = reconciledFacetId(facetId, context.snapshot, context.operations);
    if (!context.facets.some(row => row.id === facetId)) throw new Error('Select an existing saved Facet');
    if (await store.readMeta('capability.offlinePendingEntryTagCreation') !== '1') throw new Error('Offline pending new Tags are not supported');
    const canonical = await ensureOfflineEntryTag(context.snapshot, context.operations, name);
    await enqueueOfflinePendingEntryTags(localKey, [...context.tags.filter(row => normalizeTag(row.name) !== normalizeTag(canonical)), { name: canonical, facetId }]);
  }

  async function enqueueOfflinePendingEntryTags(localKey: string, tags: PendingOfflineEntryTagValue[]): Promise<void> {
    const context = await pendingTagContext(localKey);
    if (!hasOutbox(store)) throw new Error('Offline Tag storage is unavailable');
    const desired = tags.map(tag => {
      tag = { ...tag, facetId: reconciledFacetId(tag.facetId, context.snapshot, context.operations) };
      const canonical = context.snapshot.payload.tags.find(row => normalizeTag(row.name) === normalizeTag(tag.name));
      if (!canonical) throw new Error('Select an existing saved Tag');
      if (!context.facets.some(row => row.id === tag.facetId)) throw new Error('Select a Facet of the same Entry type');
      return { name: canonical.name, facetId: tag.facetId };
    }).sort((a, b) => normalizeTag(a.name).localeCompare(normalizeTag(b.name)));
    if (new Set(desired.map(row => normalizeTag(row.name))).size !== desired.length) throw new Error('Duplicate Tag');
    if (JSON.stringify(desired) === JSON.stringify(context.tags)) return;
    const transportDesired: EntryTagsOperation['payload']['tags'] = desired.map(tag => {
      const cachedTag = context.snapshot.payload.tags.find(row => normalizeTag(row.name) === normalizeTag(tag.name));
      const cachedFacet = context.facets.find(row => row.id === tag.facetId);
      const tagCreate = context.operations.find(row => row.operationKind === 'entry.tag.create'
        && (row.entityUid.toLowerCase() === cachedTag?.syncUid?.toLowerCase() || normalizeTag(String(row.payload.name)) === normalizeTag(tag.name)));
      const facetCreate = context.operations.find(row => row.operationKind === 'entry.facet.create'
        && row.entityUid.toLowerCase() === cachedFacet?.syncUid?.toLowerCase());
      return { name: tag.name, ...(tagCreate ? { tagUid: tagCreate.entityUid } : {}),
        ...(facetCreate ? { facetUid: facetCreate.entityUid } : { facetId: tag.facetId }) };
    });
    const dependencies = { tagCreates: [] as Array<{tagUid: string; createOpId: string}>,
      facetCreates: [] as Array<{facetUid: string; createOpId: string}> };
    for (const value of [...context.transportTags, ...transportDesired]) {
      for (const kind of ['tag', 'facet'] as const) {
        const stableUid = kind === 'tag' ? value.tagUid : value.facetUid;
        if (stableUid === undefined) continue;
        const source = context.operations.find(row => row.operationKind === `entry.${kind}.create`
          && row.entityKind === `entry_${kind}` && row.entityUid.toLowerCase() === stableUid.toLowerCase()
          && row.clientId === clientId && row.libraryId === context.parent.libraryId && row.syncEpoch === context.parent.syncEpoch);
        if (!source || source.status !== 'pending') throw new Error('Pending Tag or Facet source is missing or blocked; refresh and retry');
        if (kind === 'tag' && !dependencies.tagCreates.some(row => row.tagUid.toLowerCase() === stableUid.toLowerCase())) {
          dependencies.tagCreates.push({ tagUid: stableUid, createOpId: source.opId });
        }
        if (kind === 'facet' && !dependencies.facetCreates.some(row => row.facetUid.toLowerCase() === stableUid.toLowerCase())) {
          dependencies.facetCreates.push({ facetUid: stableUid, createOpId: source.opId });
        }
      }
    }
    const operation = createPendingSyncOperation({
      clientId, libraryId: context.parent.libraryId, syncEpoch: context.parent.syncEpoch,
      entityKind: 'entry', entityUid: context.parent.entityUid, operationKind: 'entry.tags.set',
      baseVersion: 0, baseValues: { tags: context.transportTags.map(serializableTag) },
      payload: { parentCreateOpId: context.parent.opId, tags: transportDesired.map(serializableTag),
        ...(dependencies.tagCreates.length ? { tagCreates: dependencies.tagCreates } : {}),
        ...(dependencies.facetCreates.length ? { facetCreates: dependencies.facetCreates } : {}) },
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    invalidateOfflineLibrary();
    setMode('offline');
    try { await setReplayStateFromStore(); }
    catch (cause) {
      setReplayStateFromOperations([...context.operations, normalized]);
      if (options.state !== undefined) options.state.lastReplayError = `Pending Tags saved, but pending status could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  function pendingOwnerSnapshotAuthors(snapshot: SyncSnapshot, entityUid: string): string[] {
    const owner = snapshot.payload.entries.find(row => row.syncUid?.toLowerCase() === entityUid.toLowerCase());
    return owner ? snapshot.payload.entryProducers.filter(row => row.entryId === owner.id)
      .flatMap(row => snapshot.payload.producers.find(producer => producer.id === row.producerId)?.syncUid ?? [])
      .map(uid => uid.toLowerCase()).sort() : [];
  }

  async function producerCreationDependencies(snapshot: SyncSnapshot, operations: PendingSyncOperation[], uids: string[], ownerUid: string) {
    const sources = parsedEntryOperations(operations.filter(row => row.clientId === clientId && row.libraryId === snapshot.header.libraryId && row.syncEpoch === snapshot.header.syncEpoch));
    const dependencies = sources.filter((row): row is EntryAuthorCreateOperation => row.operationKind === 'entry.author.create-and-link' && row.entityUid !== ownerUid.toLowerCase() && uids.map(uid=>uid.toLowerCase()).includes(row.payload.producerUid));
    if (dependencies.length && await store.readMeta('capability.offlineCrossEntryPendingAuthors') !== '1') throw new Error('Cross-Entry pending Authors are not supported');
    if (dependencies.some(source => operations.find(row => row.opId === source.opId)?.status !== 'pending')) throw new Error('Pending Author source is blocked');
    return dependencies.length ? {producerCreates: dependencies.map(row => ({producerUid:row.payload.producerUid,createOpId:row.opId}))} : {};
  }

  async function pendingAuthorContext(localKey: string) {
    if (!hasOutbox(store)) throw new Error('Offline Author storage is unavailable');
    if (await store.readMeta(PENDING_ENTRY_AUTHORS_CAPABILITY_KEY) !== '1') {
      throw new Error('Offline pending Entry Authors are not supported by this server');
    }
    if (!/^local:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(localKey)) {
      throw new Error('A pending local Entry key is required');
    }
    const active = await readActiveSnapshot(store);
    if (!active) throw new Error('Download an offline copy before editing Authors');
    const operations = await store.list();
    const parent = operations.find(row => row.operationKind === 'entry.create'
      && row.entityUid.toLowerCase() === localKey.slice(6).toLowerCase() && row.clientId === clientId
      && row.libraryId === active.snapshot.header.libraryId && row.syncEpoch === active.snapshot.header.syncEpoch);
    if (!parent) throw new Error('Pending local Entry was not found');
    const create = transportOperation(parent);
    if (create.operationKind !== 'entry.create') throw new Error('Invalid pending create');
    const siblings = operations.filter(row => row.entityUid === parent.entityUid && row.clientId === clientId
      && row.libraryId === parent.libraryId && row.syncEpoch === parent.syncEpoch);
    if (siblings.some(row => row.status !== 'pending')) throw new Error('Pending Entry is blocked');
    const authors = parsedEntryOperations(siblings).filter((row): row is EntryAuthorsOperation | EntryAuthorCreateOperation =>
      (row.operationKind === 'entry.authors.set' || row.operationKind === 'entry.author.create-and-link') && row.payload.parentCreateOpId === parent.opId);
    let producerUids = pendingOwnerSnapshotAuthors(active.snapshot, parent.entityUid);
    const available = active.snapshot.payload.producers.flatMap(row => row.syncUid && row.id > 0 ? [{producerUid: row.syncUid.toLowerCase(), name: row.name}] : []);
    for (const row of authors) {
      if (row.operationKind === 'entry.authors.set') producerUids = [...row.payload.producerUids];
      else {
        const author = {producerUid: row.payload.producerUid.toLowerCase(), name: row.payload.name};
        if (!available.some(value => value.producerUid === author.producerUid)) available.push(author);
        producerUids = [...new Set([...producerUids, author.producerUid])].sort();
      }
    }
    if (await store.readMeta('capability.offlineCrossEntryPendingAuthors') === '1') {
      for (const source of parsedEntryOperations(operations.filter(row => row.clientId === clientId && row.libraryId === parent.libraryId && row.syncEpoch === parent.syncEpoch && row.status === 'pending'))) {
        if (source.operationKind !== 'entry.author.create-and-link') continue;
        const author = {producerUid:source.payload.producerUid, name:source.payload.name};
        if (!available.some(row => row.producerUid === author.producerUid)) available.push(author);
      }
    }
    return { operations, parent, snapshot: active.snapshot, producerUids, available };
  }

  async function getPendingOfflineEntryAuthorOptions(localKey: string): Promise<PendingOfflineEntryAuthorOptions> {
    const context = await pendingAuthorContext(localKey);
    return { authors: context.available, ...(await store.readMeta('capability.offlinePendingEntryAuthorCreate') === '1' ? {canCreateAuthor: true} : {}) };
  }

  async function enqueueOfflinePendingEntryAuthorCreate(localKey: string, rawName: string) {
    const context = await pendingAuthorContext(localKey);
    if (!hasOutbox(store)) throw new Error('Offline Author storage is unavailable');
    if (await store.readMeta('capability.offlinePendingEntryAuthorCreate') !== '1') throw new Error('Pending Author creation is not supported');
    const name = rawName.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (!normalizeTag(name)) throw new Error('Author name cannot be empty');
    if (resolveOfflineAuthorByName(context.snapshot, name) || context.available.some(row => normalizeTag(row.name) === normalizeTag(name))
      || normalizeTag(canonicalOfflineAuthorName(context.snapshot, name)) !== normalizeTag(name)) throw new Error('Author name or alias already exists; select explicitly');
    const author = {producerUid: randomUUID(), name};
    const operation = createPendingSyncOperation({clientId, libraryId: context.parent.libraryId, syncEpoch: context.parent.syncEpoch,
      entityKind: 'entry', entityUid: context.parent.entityUid, operationKind: 'entry.author.create-and-link', baseVersion: 0,
      baseValues: {producerUids: context.producerUids}, payload: {parentCreateOpId: context.parent.opId, ...author}}, {randomUUID});
    const normalized = {...operation, ...transportOperation(operation)} as PendingSyncOperation;
    await enqueueDurably(normalized);
    invalidateOfflineLibrary(); setMode('offline');
    try { await setReplayStateFromStore(); } catch (cause) {
      setReplayStateFromOperations([...context.operations, normalized]);
      if (options.state) options.state.lastReplayError = `Pending Author saved, but status could not be refreshed: ${String(cause)}`;
    }
    return author;
  }

  async function enqueueOfflinePendingEntryAuthors(localKey: string, producerUids: string[]): Promise<void> {
    const context = await pendingAuthorContext(localKey);
    if (!hasOutbox(store)) throw new Error('Offline Author storage is unavailable');
    const desired = producerUids.map(uid => {
      const producer = context.available.find(row => row.producerUid === uid.toLowerCase());
      if (!producer) throw new Error('Select an existing saved Author');
      return producer.producerUid;
    }).sort();
    if (new Set(desired).size !== desired.length) throw new Error('Duplicate Author');
    if (JSON.stringify(desired) === JSON.stringify([...context.producerUids].sort())) return;
    const operation = createPendingSyncOperation({ clientId, libraryId: context.parent.libraryId,
      syncEpoch: context.parent.syncEpoch, entityKind: 'entry', entityUid: context.parent.entityUid,
      operationKind: 'entry.authors.set', baseVersion: 0, baseValues: { producerUids: context.producerUids },
      payload: { parentCreateOpId: context.parent.opId, producerUids: desired, ...await producerCreationDependencies(context.snapshot, context.operations, [...context.producerUids,...desired], context.parent.entityUid) },
    }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    invalidateOfflineLibrary();
    setMode('offline');
    try { await setReplayStateFromStore(); }
    catch (cause) {
      setReplayStateFromOperations([...context.operations, normalized]);
      if (options.state !== undefined) options.state.lastReplayError = `Pending Authors saved, but pending status could not be refreshed: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  function pendingMetadataValues(parent: SyncReplayRequest, snapshot: SyncSnapshot, operations: PendingSyncOperation[]) {
    if (parent.operationKind !== 'entry.create') throw new Error('Invalid pending create');
    const owner = snapshot.payload.entries.find(row => row.syncUid === parent.entityUid);
    const values = { title: owner?.title ?? parent.payload.title,
      uploadDate: owner ? owner.uploadDate : parent.payload.uploadDate,
      pageCount: owner ? owner.pageCount : parent.payload.pageCount };
    for (const row of operations) {
      if (row.clientId !== parent.clientId || row.libraryId !== parent.libraryId || row.syncEpoch !== parent.syncEpoch
        || row.entityKind !== 'entry' || row.entityUid !== parent.entityUid) continue;
      const op = transportOperation(row);
      if (op.operationKind === 'entry.update' && op.payload.parentCreateOpId === parent.opId) {
        for (const key of ['title', 'uploadDate', 'pageCount'] as const) {
          if (Object.hasOwn(op.payload, key)) Object.assign(values, { [key]: op.payload[key] });
        }
      }
    }
    return values;
  }

  async function enqueueOfflinePendingEntryMetadata(localKey: string,
    values: { title: string; uploadDate: string | null; pageCount: number | null }): Promise<void> {
    if (!hasOutbox(store)) throw new Error('Offline metadata storage is unavailable');
    if (await store.readMeta('capability.offlinePendingEntryMetadata') !== '1') throw new Error('Pending Entry metadata is not supported');
    if (!/^local:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(localKey)) throw new Error('A pending local Entry key is required');
    const active = await readActiveSnapshot(store);
    if (!active) throw new Error('Download an offline copy first');
    const operations = await store.list();
    const parent = operations.find(row => row.entityKind === 'entry' && row.operationKind === 'entry.create'
      && row.entityUid.toLowerCase() === localKey.slice(6).toLowerCase() && row.clientId === clientId
      && row.libraryId === active.snapshot.header.libraryId && row.syncEpoch === active.snapshot.header.syncEpoch);
    if (!parent) throw new Error('Pending local Entry was not found');
    if (operations.some(row => row.entityKind === 'entry' && row.entityUid === parent.entityUid && row.clientId === clientId
      && row.libraryId === parent.libraryId && row.syncEpoch === parent.syncEpoch && row.status !== 'pending')) throw new Error('Pending Entry is blocked');
    const baseline = pendingMetadataValues(transportOperation(parent), active.snapshot, operations);
    const payload: Record<string, string | number | null> = { parentCreateOpId: parent.opId }, baseValues: Record<string, string | number | null> = {};
    for (const key of ['title', 'uploadDate', 'pageCount'] as const) {
      if (values[key] !== baseline[key]) { payload[key] = values[key]; baseValues[key] = baseline[key]; }
    }
    if (Object.keys(baseValues).length === 0) return;
    const operation = createPendingSyncOperation({ clientId, libraryId: parent.libraryId, syncEpoch: parent.syncEpoch,
      entityKind: 'entry', entityUid: parent.entityUid, operationKind: 'entry.update', baseVersion: 0, baseValues, payload }, { randomUUID });
    const normalized = { ...operation, ...transportOperation(operation) } as PendingSyncOperation;
    await enqueueDurably(normalized);
    invalidateOfflineLibrary(); setMode('offline');
    try { await setReplayStateFromStore(); } catch (cause) {
      setReplayStateFromOperations([...operations, normalized]);
      if (options.state) options.state.lastReplayError = `Pending metadata saved, but status could not be refreshed: ${String(cause)}`;
    }
  }

  async function listPendingOfflineEntryCreates(): Promise<PendingOfflineEntryCreate[]> {
    if (!hasOutbox(store)) return [];
    const operations = await store.list();
    const storedByOpId = new Map(operations.map((stored) => [stored.opId, stored]));
    const appends = parsedEntryOperations(operations).filter((operation) => operation.operationKind === 'entry.content.append');
    const active = await readActiveSnapshot(store);
    const contentEnabled = active !== null && await store.readMeta('capability.offlinePendingEntryContents') === '1';
    const metadataEnabled = active !== null && await store.readMeta('capability.offlinePendingEntryMetadata') === '1';
    const authorEnabled = active !== null && await store.readMeta(PENDING_ENTRY_AUTHORS_CAPABILITY_KEY) === '1';
    const tagEnabled = active !== null && await store.readMeta(PENDING_ENTRY_TAGS_CAPABILITY_KEY) === '1';
    const appendEnabled = active !== null && await store.readMeta(PENDING_ENTRY_CONTENT_APPEND_CAPABILITY_KEY) === '1';
    return operations.flatMap((stored) => {
      try {
        const operation = transportOperation(stored);
        if (operation.operationKind !== 'entry.create') return [];
        return [{
          localKey: `local:${operation.entityUid}` as const,
          ...(() => {
            const sameIdentity = active !== null && stored.clientId === clientId && stored.libraryId === active.snapshot.header.libraryId
              && stored.syncEpoch === active.snapshot.header.syncEpoch;
            const edits = operations.filter(row => row.entityKind === 'entry' && row.entityUid === operation.entityUid
              && row.clientId === stored.clientId && row.libraryId === stored.libraryId && row.syncEpoch === stored.syncEpoch
              && row.operationKind === 'entry.update' && row.payload.parentCreateOpId === operation.opId);
            const last = edits.at(-1);
            return { ...(sameIdentity ? pendingMetadataValues(operation, active!.snapshot, operations) : {title:operation.payload.title,uploadDate:operation.payload.uploadDate,pageCount:operation.payload.pageCount}),
              ...(metadataEnabled || last ? { canEditMetadata: metadataEnabled && sameIdentity && stored.status === 'pending'
                && !operations.some(row => row.entityKind === 'entry' && row.entityUid === operation.entityUid && row.clientId === clientId
                  && row.libraryId === stored.libraryId && row.syncEpoch === stored.syncEpoch && row.status !== 'pending'),
                ...(last ? { metadataEditStatus: last.status, metadataEditError: last.lastError ?? null } : {}) } : {}) };
          })(),
          type: operation.payload.type,

          status: stored.status,
          ...(stored.lastError ? { lastError: stored.lastError } : {}),
          ...(() => {
            const siblings = operations.filter(row => row.entityUid === operation.entityUid
              && row.clientId === clientId && row.libraryId === operation.libraryId && row.syncEpoch === operation.syncEpoch);
            const tagEdits = siblings.filter(row => row.operationKind === 'entry.tags.set'
              && (row.payload as { parentCreateOpId?: string }).parentCreateOpId === operation.opId);
            if (!tagEnabled && tagEdits.length === 0) return {};
            const last = tagEdits.at(-1);
            const sameSnapshotIdentity = active !== null && stored.libraryId === active.snapshot.header.libraryId
              && stored.syncEpoch === active.snapshot.header.syncEpoch;
            return { tags: last ? (transportOperation(last) as EntryTagsOperation).payload.tags
              : sameSnapshotIdentity ? pendingOwnerSnapshotTags(active!.snapshot, operation.entityUid) : [],
              ...(last ? { tagEditStatus: last.status, tagEditError: last.lastError ?? null } : {}),
              canEditTags: tagEnabled && stored.status === 'pending'
                && stored.clientId === clientId && stored.libraryId === active?.snapshot.header.libraryId
                && stored.syncEpoch === active?.snapshot.header.syncEpoch
                && !siblings.some(row => row.status !== 'pending') };
          })(),
          ...(() => {
            const siblings = operations.filter(row => row.entityUid === operation.entityUid && row.clientId === clientId
              && row.libraryId === operation.libraryId && row.syncEpoch === operation.syncEpoch);
            const edits = siblings.filter(row => (row.operationKind === 'entry.authors.set' || row.operationKind === 'entry.author.create-and-link')
              && row.payload.parentCreateOpId === operation.opId);
            if (!authorEnabled && edits.length === 0) return {};
            const last = edits.at(-1);
            const sameIdentity = active !== null && stored.clientId === clientId
              && stored.libraryId === active.snapshot.header.libraryId && stored.syncEpoch === active.snapshot.header.syncEpoch;
            let uids = sameIdentity ? pendingOwnerSnapshotAuthors(active!.snapshot, operation.entityUid) : [];
            for (const edit of edits) {
              const row = transportOperation(edit);
              if (row.operationKind === 'entry.authors.set') uids = row.payload.producerUids;
              if (row.operationKind === 'entry.author.create-and-link') uids = [...new Set([...uids, row.payload.producerUid])].sort();
            }
            return { authors: uids.map(producerUid => ({ producerUid,
              name: active?.snapshot.payload.producers.find(row => row.syncUid === producerUid)?.name
                ?? operations.find(row => row.clientId === clientId && row.libraryId === operation.libraryId && row.syncEpoch === operation.syncEpoch && row.operationKind === 'entry.author.create-and-link' && row.payload.producerUid === producerUid)?.payload.name as string ?? producerUid })),
              ...(last ? { authorStatus: last.status, authorLastError: last.lastError ?? null } : {}),
              canEditAuthors: authorEnabled && sameIdentity && stored.status === 'pending'
                && !siblings.some(row => row.status !== 'pending') };
          })(),
          ...(() => {
            const siblings = operations.filter(row => row.entityKind === 'entry' && row.entityUid === operation.entityUid
              && row.clientId === stored.clientId && row.libraryId === stored.libraryId && row.syncEpoch === stored.syncEpoch);
            const edits = siblings.filter(row => row.operationKind === 'entry.contents.set' && row.payload.parentCreateOpId === operation.opId);
            if (!contentEnabled && edits.length === 0) return {};
            const last = edits.at(-1);
            return {canEditContents: contentEnabled && stored.status === 'pending' && stored.clientId === clientId
              && stored.libraryId === active?.snapshot.header.libraryId && stored.syncEpoch === active?.snapshot.header.syncEpoch
              && !siblings.some(row => row.status !== 'pending'),
              ...(last ? {contentEditStatus: last.status, contentEditError: last.lastError ?? null} : {})};
          })(),
          canAppendContent: appendEnabled && stored.status === 'pending'
            && stored.clientId === clientId
            && stored.libraryId === active?.snapshot.header.libraryId
            && stored.syncEpoch === active?.snapshot.header.syncEpoch
            && !operations.some((candidate) => candidate.entityUid === operation.entityUid
              && candidate.clientId === clientId && candidate.libraryId === operation.libraryId
              && candidate.syncEpoch === operation.syncEpoch && candidate.status !== 'pending'),
          ...(operation.payload.contents === undefined && !appends.some((append) => append.entityUid === operation.entityUid) ? {} : {
            contents: [
              ...(operation.payload.contents ?? []).map(({ contentType, content }) => ({ contentType, content })),
              ...appends.filter((append) => append.entityUid === operation.entityUid && append.payload.parentCreateOpId === operation.opId)
                .map((append) => {
                  const child = storedByOpId.get(append.opId)!;
                  return { contentType: append.payload.content.contentType, content: append.payload.content.content,
                    status: child.status, ...(child.lastError ? { lastError: child.lastError } : {}) };
                }),
            ],
          }),
          ...((contentEnabled || operations.some(row => row.operationKind === 'entry.contents.set' && row.payload.parentCreateOpId === operation.opId))
            && active && stored.clientId === clientId && stored.libraryId === active.snapshot.header.libraryId && stored.syncEpoch === active.snapshot.header.syncEpoch
            ? {contents: pendingContentValues(operation, active.snapshot, operations)} : {}),
        }];
      } catch {
        return [];
      }
    });
  }

  async function replayPendingOperations(): Promise<void> {
    if (replayPromise !== null) return replayPromise;
    replayPromise = (async () => {
      if (!hasOutbox(store) || online.replaySyncOperation === undefined) return;
      await ensureClientIdentity();
      // Quiesce the native mirror; typed unchanged retries remain the only receipt authority.
      await options.nativeTransfers?.pause();
      await options.nativeTransfers?.reconcile();
      if (await store.readMeta('pendingSnapshotAck') !== null) {
        await retryPendingSnapshotAck(online, store, await online.getSyncCapabilities(), clientId);
      }
      const operations = await store.list();
      const mediaBeforeReplay = hasMediaOutbox(store) ? await store.listMedia() : [];
      const multiplePreviewEntryUids = new Set(mediaBeforeReplay
        .filter((upload) => upload.kind === 'preview' && upload.ordinal > 0)
        .map((upload) => upload.entryUid));
      const supportsMultiplePreviews = multiplePreviewEntryUids.size === 0
        || await store.readMeta(MEDIA_MULTIPLE_PREVIEWS_CAPABILITY_KEY) === '1';
      await setReplayStateFromStore();
      if (operations.length === 0 && mediaBeforeReplay.length === 0) return;
      const replayBase = store.captureSnapshot ? await store.captureSnapshot() : undefined;
      const activeBeforeReplay = replayBase ? replayBase.active : await readActiveSnapshot(store);
      const appliedOperations: SyncReplayRequest[] = [];
      const appliedMetadataOwnerIds = new Map<string, number>();
      const appliedProducerIds = new Map<string, number>();
      const appliedTagIds = new Map<string, number>();
      const appliedFacetIds = new Map<string, number>();
      const appliedTagOwnerIds = new Map<string, number>();
      const appliedContentOwnerIds = new Map<string, number>();
      const appliedMedia: StagedMediaUpload[] = [];
      const mediaReceipts = new Map<string, import('@t3/shared').SyncMediaUploadResult>();
      let maxAppliedServerSeq = -1;
      const replayPlan = mutationQueuePlan(operations);
      const blockedEntities = new Set<string>();
      const blockedRatingSlotUids = new Set<string>();
      let replayError: string | null = null;
      let attemptedOpId: string | null = null;
      let attemptedUploadId: string | null = null;
      try {
        for (const stored of operations) {
          if (stored.status === 'pending' && !blockedEntities.has(`entry:${stored.entityUid.toLowerCase()}`) && stored.entityKind === 'entry' && stored.baseVersion > 0) {
            const ownerOperations = operations.filter(row=>row.entityKind==='entry' && row.entityUid===stored.entityUid);
            const floor = Math.min(activeBeforeReplay?.snapshot.payload.entries.find(row=>row.syncUid===stored.entityUid)?.syncVersion ?? stored.baseVersion,
              ...ownerOperations.filter(row=>row.baseVersion>0).map(row=>row.baseVersion));
            const earlier = operations.slice(0,operations.indexOf(stored)).filter(row=>row.entityKind==='entry' && row.entityUid===stored.entityUid);
            const advances = parsedEntryOperations(earlier).reduce((total,row)=>total+entryVersionDelta(row),0) + parsedMediaOrderOperations(earlier).length;
            const count = Math.max(0,stored.baseVersion-floor-advances);
            const required = new Set(mediaBeforeReplay.filter(row=>row.entryUid===stored.entityUid && row.existingEntry)
              .sort((a,b)=>a.kind===b.kind ? a.ordinal-b.ordinal : a.kind==='cover' ? -1 : 1).slice(0,count).map(row=>row.uploadId));
            await replayMediaUploads(required);
            if ([...required].some(id=>!appliedMedia.some(row=>row.uploadId===id))) {
              blockedEntities.add(`entry:${stored.entityUid.toLowerCase()}`);
              replayError ??= 'An earlier media dependency is held; Entry edits remain queued'; continue;
            }
          }
          if (stored.status === 'pending' && !blockedEntities.has(`entry:${stored.entityUid.toLowerCase()}`) && stored.operationKind === 'entry.media.set') {
            const operation = transportOperation(stored);
            if (operation.operationKind === 'entry.media.set') {
              const required = new Set(mediaBeforeReplay.filter(row => operation.baseValues.refs.some(ref => ref.includes(`.${row.uploadId}.`))).map(row => row.uploadId));
              await replayMediaUploads(required);
              if ([...required].some(id => !appliedMedia.some(row => row.uploadId === id))) {
                blockedEntities.add(`entry:${stored.entityUid.toLowerCase()}`);
                replayError ??= 'An earlier media dependency is held; Entry edits remain queued';
                continue;
              }
            }
          }
          const entityKey = replayPlan.get(stored.opId)?.ownerKey ?? `${stored.entityKind}:${stored.entityUid.toLowerCase()}`;
          if (stored.status !== 'pending') {
            blockedEntities.add(entityKey);
            replayError ??= stored.lastError;
            try {
              const blockedOperation = transportOperation(stored);
              for (const key of referencedEntityKeys(blockedOperation)) blockedEntities.add(key);
              for (const uid of newlyCreatedRatingSlotUids(blockedOperation)) blockedRatingSlotUids.add(uid);
            } catch {
              // Leave unrecognized persisted operations blocked without guessing dependencies.
            }
            continue;
          }
          if (blockedEntities.has(entityKey)) {
            try {
              for (const uid of newlyCreatedRatingSlotUids(transportOperation(stored))) blockedRatingSlotUids.add(uid);
            } catch {
              // The owning entity is already blocked; no best-effort parsing is needed.
            }
            continue;
          }
          let operation: SyncReplayRequest;
          try {
            operation = transportOperation(stored);
          } catch {
            // An envelope this build can no longer express (for example one queued
            // by another app version) must neither be sent nor silently dropped,
            // and it must not stop unrelated Entries from syncing.
            replayError = 'Invalid offline operation: this version cannot send it';
            await store.update(stored.opId, { status: 'failed', lastError: replayError });
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'entry.authors.set' && operation.payload.producerCreates !== undefined
            && (await store.readMeta('capability.offlineCrossEntryPendingAuthors') !== '1' || operation.payload.producerCreates.some(dep => !appliedOperations.some(row => row.opId.toLowerCase() === dep.createOpId.toLowerCase())))) {
            replayError ??= 'A pending Author dependency is held; linked Entries remain queued';
            blockedEntities.add(entityKey); continue;
          }
          if ((operation.operationKind === 'entry.tag.create' && await store.readMeta(ENTRY_TAG_VOCABULARY_CAPABILITY_KEY) !== '1')
            || (operation.operationKind === 'entry.facet.create' && await store.readMeta('capability.offlineEntryFacetCreate') !== '1')
            || (operation.operationKind === 'entry.tags.set' && ((operation.payload.tagCreates?.length &&
              (await store.readMeta(ENTRY_TAG_VOCABULARY_CAPABILITY_KEY) !== '1'
                || (operation.payload.parentCreateOpId !== undefined && await store.readMeta('capability.offlinePendingEntryTagCreation') !== '1')
                || operation.payload.tagCreates.some(dep => !appliedOperations.some(row => row.operationKind === 'entry.tag.create' && row.opId.toLowerCase() === dep.createOpId.toLowerCase()))))
              || (operation.payload.facetCreates?.length && (await store.readMeta('capability.offlineEntryFacetCreate') !== '1'
                || operation.payload.facetCreates.some(dep => !appliedOperations.some(row => row.operationKind === 'entry.facet.create' && row.opId.toLowerCase() === dep.createOpId.toLowerCase()))))))) {
            replayError ??= 'A pending Tag or Facet dependency is held; dependent edits remain queued';
            blockedEntities.add(entityKey); continue;
          }
          const entityDependencies = referencedEntityKeys(operation);
          if (entityDependencies.some((key) => blockedEntities.has(key))) {
            replayError ??= 'A dependency could not sync; dependent Collection changes remain queued';
            blockedEntities.add(entityKey);
            for (const key of entityDependencies) blockedEntities.add(key);
            continue;
          }
          const slotDependencies = referencedRatingSlotUids(operation);
          if (slotDependencies.some((uid) => blockedRatingSlotUids.has(uid))) {
            replayError ??= 'A pending rating slot could not sync; dependent ratings remain queued';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'rating-layout.slots.set'
            && await store.readMeta(RATING_LAYOUT_CAPABILITY_KEY) !== '1') {
            replayError ??= 'The server does not currently support offline rating-slot layouts';
            for (const uid of newlyCreatedRatingSlotUids(operation)) blockedRatingSlotUids.add(uid);
            blockedEntities.add(entityKey);
            continue;
          }
          if (isCollectionManagementOperation(operation)
            && await store.readMeta(COLLECTION_MANAGEMENT_CAPABILITY_KEY) !== '1') {
            replayError ??= 'The server does not currently support offline Collection management';
            blockedEntities.add(entityKey);
            for (const key of entityDependencies) blockedEntities.add(key);
            continue;
          }
          if (operation.operationKind === 'collection.producer.set'
            && await store.readMeta(COLLECTION_PRODUCER_MEMBERSHIP_CAPABILITY_KEY) !== '1') {
            replayError ??= 'The server does not currently support offline Collection Author membership';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'entry.author.create-and-link'
            && (await store.readMeta(AUTHOR_CREATE_CAPABILITY_KEY) !== '1'
              || (operation.payload.parentCreateOpId !== undefined && await store.readMeta('capability.offlinePendingEntryAuthorCreate') !== '1'))) {
            replayError ??= 'The server does not currently support offline Author creation';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'entry.create'
            && multiplePreviewEntryUids.has(operation.entityUid) && !supportsMultiplePreviews) {
            replayError ??= 'The server does not currently support multiple offline previews; this create remains queued';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'entry.create' && operation.payload.contents?.length
            && await store.readMeta(ENTRY_INITIAL_CONTENTS_CAPABILITY_KEY) !== '1') {
            replayError ??= 'The server does not currently support initial Content in offline Entry creation';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'entry.update' && operation.payload.parentCreateOpId !== undefined
            && await store.readMeta('capability.offlinePendingEntryMetadata') !== '1') {
            replayError ??= 'The server does not currently support pending Entry metadata';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'entry.contents.set' && operation.payload.parentCreateOpId !== undefined
            && await store.readMeta('capability.offlinePendingEntryContents') !== '1') {
            replayError ??= 'The server does not currently support pending Entry Contents';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'entry.content.append'
            && await store.readMeta(PENDING_ENTRY_CONTENT_APPEND_CAPABILITY_KEY) !== '1') {
            replayError ??= 'The server does not currently support pending Entry Content append';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'entry.tags.set' && operation.payload.parentCreateOpId !== undefined
            && await store.readMeta(PENDING_ENTRY_TAGS_CAPABILITY_KEY) !== '1') {
            replayError ??= 'The server does not currently support pending Entry Tags';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'entry.tags.set'
            && await store.readMeta(ENTRY_TAGS_CAPABILITY_KEY) !== '1') {
            replayError ??= 'The server does not currently support offline Entry Tag editing';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'entry.authors.set' && operation.payload.parentCreateOpId !== undefined
            && await store.readMeta(PENDING_ENTRY_AUTHORS_CAPABILITY_KEY) !== '1') {
            replayError ??= 'The server does not currently support pending Entry Authors';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'entry.authors.set'
            && await store.readMeta(ENTRY_AUTHORS_CAPABILITY_KEY) !== '1') {
            replayError ??= 'The server does not currently support offline Entry-Author editing';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'author.directories.set'
            && await store.readMeta(AUTHOR_DIRECTORIES_CAPABILITY_KEY) !== '1') {
            replayError ??= 'The server does not currently support offline Author Directories';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'producer.view-later.set'
            && await store.readMeta(PRODUCER_VIEW_LATER_CAPABILITY_KEY) !== '1') {
            replayError ??= 'The server does not currently support offline Producer View later';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'producer.rating.set'
            && await store.readMeta(PRODUCER_RATING_CAPABILITY_KEY) !== '1') {
            replayError ??= 'The server does not currently support offline Author ratings';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'producer.update'
            && await store.readMeta(PRODUCER_PROFILE_CAPABILITY_KEY) !== '1') {
            replayError ??= 'The server does not currently support offline Author profile editing';
            blockedEntities.add(entityKey);
            continue;
          }
          if (operation.operationKind === 'producer.tags.set'
            && await store.readMeta(PRODUCER_TAGS_CAPABILITY_KEY) !== '1') {
            replayError ??= 'The server does not currently support offline Author tag editing';
            blockedEntities.add(entityKey);
            continue;
          }
          const plan = replayPlan.get(stored.opId);
          const missingFlags=await missingForegroundMutationCapabilities(operation,key=>store.readMeta(key));
          // Absent explicit predecessors can already be covered by the verified
          // snapshot; retain the established typed proof checks above. Present
          // predecessors must settle in this same ordered foreground replay.
          const unsettled=plan?.dependencies.some(id=>operations.some(row=>row.opId.toLowerCase()===id.toLowerCase()) && !appliedOperations.some(row=>row.opId.toLowerCase()===id.toLowerCase()));
          if(missingFlags.length || unsettled) {
            replayError ??= missingFlags.length ? `Current required capability unavailable: ${missingFlags.join(', ')}` : 'A dependency is held; original work remains queued';
            blockedEntities.add(entityKey);continue;
          }
          attemptedOpId = stored.opId;
          await store.update(stored.opId, {
            lastAttemptAt: new Date().toISOString(),
            lastError: null,
          });
          const result = await online.replaySyncOperation(operation);
          operation = authorIdentityView(operation);
          if (result.status === 'applied') {
            if (operation.operationKind === 'entry.facet.create') {
              if (result.opId.toLowerCase() !== operation.opId.toLowerCase() || !Number.isSafeInteger(result.entityId) || result.entityId! <= 0) throw new Error('Facet receipt has invalid identity');
              appliedFacetIds.set(operation.entityUid.toLowerCase(), result.entityId!);
            }
            if (operation.operationKind === 'entry.tag.create') {
              if (result.opId.toLowerCase() !== operation.opId.toLowerCase() || !Number.isSafeInteger(result.entityId) || result.entityId! <= 0) throw new Error('Tag receipt has invalid identity');
              appliedTagIds.set(operation.entityUid.toLowerCase(), result.entityId!);
            }
            if (operation.operationKind === 'entry.tags.set') {
              const ownerId = result.entityId ?? (operation.payload.parentCreateOpId === undefined
                ? activeBeforeReplay?.snapshot.payload.entries.find(row => row.syncUid?.toLowerCase() === operation.entityUid.toLowerCase())?.id : undefined);
              if (ownerId === undefined) throw new Error('Tag receipt has no Entry owner identity');
              appliedTagOwnerIds.set(operation.entityUid.toLowerCase(), ownerId);
            }
            if (operation.operationKind === 'entry.create' || operation.operationKind === 'entry.content.append'
              || (operation.operationKind === 'entry.contents.set' && operation.payload.parentCreateOpId !== undefined)) {
              if (result.entityId === undefined) throw new Error('Pending Content receipt has no owner identity');
              const previous = appliedContentOwnerIds.get(operation.entityUid);
              if (previous !== undefined && previous !== result.entityId) throw new Error('Pending Content receipts disagree on owner identity');
              appliedContentOwnerIds.set(operation.entityUid, result.entityId);
            }
            if (operation.operationKind === 'entry.authors.set' && operation.payload.producerCreates !== undefined) {
              if (result.entityId === undefined) throw new Error('Cross-Entry Author receipt has no owner identity');
              appliedContentOwnerIds.set(operation.entityUid, result.entityId);
            }
            if (operation.operationKind === 'entry.update' && operation.payload.parentCreateOpId !== undefined) {
              if (result.entityId === undefined) throw new Error('Pending metadata receipt has no owner identity');
              appliedMetadataOwnerIds.set(operation.entityUid, result.entityId);
            }
            if (operation.operationKind === 'entry.author.create-and-link') {
              const sourceOwner = activeBeforeReplay?.snapshot.payload.entries.find(row => row.syncUid?.toLowerCase() === operation.entityUid.toLowerCase());
              if (sourceOwner) appliedContentOwnerIds.set(operation.entityUid, sourceOwner.id);
              if (result.entityId === undefined && operation.payload.parentCreateOpId !== undefined) throw new Error('Author receipt has no Producer identity');
              if (result.entityId !== undefined) appliedProducerIds.set(operation.payload.producerUid, result.entityId);
            }
            appliedOperations.push(operation);
            maxAppliedServerSeq = Math.max(maxAppliedServerSeq, result.serverSeq);
            attemptedOpId = null;
            continue;
          }
          if (result.status === 'conflict') {
            replayError = 'An offline edit conflicts with a newer server value';
            await store.update(stored.opId, { status: 'conflict', lastError: replayError });
          } else if (result.status === 'resnapshot-required') {
            replayError = 'The library changed and the offline edit needs review';
            await store.update(stored.opId, { status: 'conflict', lastError: replayError });
          } else {
            replayError = result.detail;
            await store.update(stored.opId, { status: 'failed', lastError: replayError });
          }
          for (const key of entityDependencies) blockedEntities.add(key);
          for (const uid of newlyCreatedRatingSlotUids(operation)) blockedRatingSlotUids.add(uid);
          blockedEntities.add(entityKey);
          attemptedOpId = null;
        }

        await replayMediaUploads();

        async function replayMediaUploads(required?: Set<string>): Promise<void> {
          if (!hasMediaOutbox(store) || online.uploadSyncMedia === undefined) return;
          const readyEntryUids = new Set(
            activeBeforeReplay?.snapshot.payload.entries.map((entry) => entry.syncUid) ?? [],
          );
          for (const operation of appliedOperations) {
            if (operation.operationKind === 'entry.create') readyEntryUids.add(operation.entityUid);
          }
          const blockedCoverOwners = new Set(mediaBeforeReplay.filter(row => row.kind === 'cover' && row.status === 'failed').map(row => row.entryUid));
          const blockedPreviewOrdinals = new Map<string, number>();
          for (const upload of mediaBeforeReplay) {
            if (upload.kind === 'preview' && upload.status === 'failed') {
              blockedPreviewOrdinals.set(upload.entryUid,
                Math.min(upload.ordinal, blockedPreviewOrdinals.get(upload.entryUid) ?? Infinity));
            }
          }
          const orderedMedia = [...mediaBeforeReplay].sort((a, b) => (
            a.entryUid.localeCompare(b.entryUid)
            || (a.kind === b.kind ? a.ordinal - b.ordinal : a.kind === 'cover' ? -1 : 1)
          ));
          const supportsExistingMedia = !orderedMedia.some(row => row.existingEntry) || (await online.getSyncCapabilities()).featureFlags?.existingEntryMedia === true;
          for (const upload of orderedMedia) {
            if ((required && !required.has(upload.uploadId)) || appliedMedia.some(row => row.uploadId === upload.uploadId)) continue;
            if (blockedEntities.has(`entry:${upload.entryUid.toLowerCase()}`)) continue;
            if (upload.existingEntry && !supportsExistingMedia) { replayError ??= 'Existing Entry media remains queued: server capability unavailable'; continue; }
            if (multiplePreviewEntryUids.has(upload.entryUid) && !supportsMultiplePreviews) {
              replayError ??= 'The server does not currently support multiple offline previews; media remains queued';
              continue;
            }
            if (upload.kind === 'preview' && blockedCoverOwners.has(upload.entryUid)) {
              replayError ??= 'An earlier Cover failed; previews remain queued'; continue;
            }
            if (upload.kind === 'preview'
              && upload.ordinal > (blockedPreviewOrdinals.get(upload.entryUid) ?? Infinity)) {
              replayError ??= 'An earlier Preview failed; later previews remain queued';
              continue;
            }
            if (upload.status !== 'pending' || !readyEntryUids.has(upload.entryUid)) continue;
            attemptedUploadId = upload.uploadId;
            await store.updateMedia(upload.uploadId, {
              lastAttemptAt: new Date().toISOString(),
              lastError: null,
            });
            try {
              const result = await online.uploadSyncMedia(upload.uploadId, {
                libraryId: upload.libraryId,
                syncEpoch: upload.syncEpoch,
                entryUid: upload.entryUid,
                kind: upload.kind,
                ordinal: upload.ordinal,
                mimeType: upload.mimeType,
                byteLength: upload.byteLength,
                sha256: upload.sha256,
                ...(upload.existingEntry ? {existingEntry:upload.existingEntry} : {}),
              }, upload.blob);
              if (upload.existingEntry && result.uploadId !== upload.uploadId) throw new Error('Media receipt upload identity mismatch');
              mediaReceipts.set(upload.uploadId,result);
              appliedMedia.push(upload);
              maxAppliedServerSeq = Math.max(maxAppliedServerSeq, result.serverSeq);
              attemptedUploadId = null;
            } catch (cause) {
              // The server answered: it refused these bytes (a bad image, a
              // conflict, or an internal error for this payload). Retrying the
              // identical bytes is pointless, and rethrowing here aborted the
              // whole replay — one unacceptable image left every later upload
              // and operation queued forever (measured on the device: the
              // queue sat at 8 pending, nothing failed, nothing attempted).
              // Mark this row failed so it is visible and discardable, and let
              // the rest of the queue proceed. Only a transport failure — where
              // the server never answered — stays queued for the next attempt.
              if (!(cause instanceof ApiError)) throw cause;
              replayError = cause.message;
              await store.updateMedia(upload.uploadId, { status: 'failed', lastError: replayError });
              blockedEntities.add(`entry:${upload.entryUid.toLowerCase()}`);
              if (upload.kind === 'cover') blockedCoverOwners.add(upload.entryUid);
              else blockedPreviewOrdinals.set(upload.entryUid, upload.ordinal);
              attemptedUploadId = null;
              continue;
            }
          }
        }

        if (appliedOperations.length > 0 || appliedMedia.length > 0) {
          const first = appliedOperations[0];
          const candidate = store.captureSnapshot && store.installSnapshot && store.compareSnapshotMeta && online.fetchSnapshotDelta && online.ackSnapshotDelta
            ? await fetchSnapshotCandidate(online, activeBeforeReplay, await online.getSyncCapabilities(), clientId, await readSnapshotMediaMode(store))
            : { snapshot: await online.fetchSyncSnapshot() };
          const snapshot = candidate.snapshot;
          if (snapshot.header.changeSeq === undefined || snapshot.header.changeSeq < maxAppliedServerSeq) {
            throw new Error(
              `Snapshot refresh failed: change sequence ${String(snapshot.header.changeSeq)} does not cover replay ${maxAppliedServerSeq}`,
            );
          }
          const currentLibraryId = first?.libraryId
            ?? activeBeforeReplay?.snapshot.header.libraryId;
          const currentSyncEpoch = first?.syncEpoch
            ?? activeBeforeReplay?.snapshot.header.syncEpoch;
          if (currentLibraryId === undefined || currentSyncEpoch === undefined) {
            throw new Error('Snapshot refresh failed: no paired offline library identity');
          }
          // Fold the applied timeline per owner. A later complete set intentionally
          // removes earlier create/append rows; append after that set must survive.
          const contentTimelines = new Map<string, {contents: PendingOfflineEntryContentValue[]; complete: boolean}>();
          for (const operation of appliedOperations) {
            if (operation.operationKind !== 'entry.create' && operation.operationKind !== 'entry.content.append'
              && !(operation.operationKind === 'entry.contents.set' && operation.payload.parentCreateOpId !== undefined)) continue;
            const timeline = contentTimelines.get(operation.entityUid) ?? {contents: [], complete: false};
            if (operation.operationKind === 'entry.create') timeline.contents = (operation.payload.contents ?? []).map(row => ({...row}));
            if (operation.operationKind === 'entry.contents.set') {
              timeline.contents = operation.payload.contents.map(row => ({...row}));
              timeline.complete = true;
            }
            if (operation.operationKind === 'entry.content.append') {
              timeline.contents.push({...operation.payload.content, sortOrder: Math.max(-1, ...timeline.contents.map(row => row.sortOrder)) + 1});
            }
            contentTimelines.set(operation.entityUid, timeline);
          }
          for (const [uid, timeline] of contentTimelines) {
            const owner = snapshot.payload.entries.find(row => row.syncUid === uid);
            if (!owner || owner.id !== appliedContentOwnerIds.get(uid)) throw new Error('Snapshot refresh failed: pending Content owner identity is missing');
            const actual = snapshot.payload.entryContents.filter(row => row.entryId === owner.id);
            if ((timeline.complete && actual.length !== timeline.contents.length) || timeline.contents.some(content =>
              !actual.some(row => row.syncUid === content.syncUid && row.contentType === content.contentType
                && row.content === content.content && (!timeline.complete || row.sortOrder === content.sortOrder)))) {
              throw new Error('Snapshot refresh failed: pending Content final timeline is missing');
            }
          }
          const lastAppliedMetadata = new Map<string, Record<string, unknown>>();
          for (const operation of appliedOperations) {
            if (operation.operationKind !== 'entry.update' || operation.payload.parentCreateOpId === undefined) continue;
            const desired = lastAppliedMetadata.get(operation.entityUid) ?? {};
            for (const key of ['title', 'uploadDate', 'pageCount'] as const) {
              if (Object.hasOwn(operation.payload, key)) desired[key] = operation.payload[key];
            }
            lastAppliedMetadata.set(operation.entityUid, desired);
          }
          for (const [uid, desired] of lastAppliedMetadata) {
            const owner = snapshot.payload.entries.find(row => row.syncUid === uid);
            if (!owner || owner.id !== appliedMetadataOwnerIds.get(uid) || Object.entries(desired).some(([key, value]) => owner[key as 'title' | 'uploadDate' | 'pageCount'] !== value)) {
              throw new Error('Snapshot refresh failed: pending metadata desired fields are missing');
            }
          }
          const lastAppliedAuthors = new Map<string, string[]>();
          for (const operation of appliedOperations) {
            if (operation.operationKind === 'entry.authors.set' && (operation.payload.parentCreateOpId !== undefined || operation.payload.producerCreates !== undefined || appliedOperations.some(row => row.operationKind === 'entry.author.create-and-link' && row.entityUid === operation.entityUid))) {
              lastAppliedAuthors.set(operation.entityUid, [...operation.payload.producerUids]);
            }
            if (operation.operationKind === 'entry.author.create-and-link') {
              const before = lastAppliedAuthors.get(operation.entityUid) ?? operation.baseValues.producerUids;
              lastAppliedAuthors.set(operation.entityUid, [...new Set([...before, operation.payload.producerUid])]);
            }
          }
          for (const [uid, producerUids] of lastAppliedAuthors) {
            if (!snapshot.payload.entries.some(row => row.syncUid?.toLowerCase() === uid.toLowerCase() && row.id === appliedContentOwnerIds.get(uid))) {
              throw new Error('Snapshot refresh failed: pending Author owner identity is missing');
            }
            const actual = pendingOwnerSnapshotAuthors(snapshot, uid);
            const desired = producerUids.map(uid => uid.toLowerCase()).sort();
            if (JSON.stringify(actual) !== JSON.stringify(desired)) {
              throw new Error('Snapshot refresh failed: pending Author desired set is missing');
            }
          }
          // A canonical-name/alias reuse can return an existing Tag whose UUID
          // differs from the local origin. Only a verified receipt ID plus the
          // authoritative canonical name reconciles it; never rewrite the queue.
          for (const operation of appliedOperations) {
            if (operation.operationKind !== 'entry.tag.create') continue;
            const tag = snapshot.payload.tags.find(row => row.id === appliedTagIds.get(operation.entityUid.toLowerCase()));
            const normalized = normalizeTag(operation.payload.name);
            const alias = snapshot.payload.taxonomyAliases?.find(row => row.vocabulary === 'entry' && row.normalizedAlias === normalized && row.normalizedCanonical !== '');
            if (!tag || normalizeTag(tag.name) !== (alias?.normalizedCanonical ?? normalized)) throw new Error('Snapshot refresh failed: Tag receipt identity is missing');
          }
          for (const operation of appliedOperations) {
            if (operation.operationKind !== 'entry.facet.create') continue;
            const facet = snapshot.payload.tagGroups.find(row => row.id === appliedFacetIds.get(operation.entityUid.toLowerCase()));
            const section = snapshot.payload.tagGroups.find(row => row.syncUid?.toLowerCase() === operation.payload.sectionUid.toLowerCase());
            if (!facet || facet.groupKind !== 'facet' || facet.name !== operation.payload.name || facet.entryType !== operation.payload.entryType
              || !section || section.groupKind !== 'section' || section.entryType !== operation.payload.entryType || facet.parentId !== section.id) throw new Error('Snapshot refresh failed: Facet receipt identity is missing');
          }
          const lastAppliedTags = new Map<string, EntryTagsOperation>();
          for (const operation of appliedOperations) {
            if (operation.operationKind === 'entry.tags.set') {
              lastAppliedTags.set(operation.entityUid, operation);
            }
          }
          for (const operation of lastAppliedTags.values()) {
            const entry = snapshot.payload.entries.find(row => row.syncUid === operation.entityUid);
            if (!entry || entry.id !== appliedTagOwnerIds.get(operation.entityUid.toLowerCase())) throw new Error('Snapshot refresh failed: pending Tag owner identity is missing');
            const actual = snapshot.payload.entryTags.filter(row => row.entryId === entry.id).map(row => ({
              name: normalizeTag(snapshot.payload.tags.find(tag => tag.id === row.tagId)?.name ?? ''), facetId: row.facetId,
            })).sort((a, b) => a.name.localeCompare(b.name));
            const desired = operation.payload.tags.map(row => {
              const receiptTag = row.tagUid === undefined ? undefined : snapshot.payload.tags.find(tag => tag.id === appliedTagIds.get(row.tagUid!.toLowerCase()));
              const alias = snapshot.payload.taxonomyAliases?.find(alias => alias.vocabulary === 'entry' && alias.normalizedAlias === normalizeTag(row.name) && alias.normalizedCanonical !== '');
              return { name: receiptTag ? normalizeTag(receiptTag.name) : alias?.normalizedCanonical ?? normalizeTag(row.name),
                facetId: row.facetUid === undefined ? row.facetId : appliedFacetIds.get(row.facetUid.toLowerCase()) ?? snapshot.payload.tagGroups.find(facet => facet.syncUid?.toLowerCase() === row.facetUid!.toLowerCase())?.id };
            })
              .sort((a, b) => a.name.localeCompare(b.name));
            if (JSON.stringify(actual) !== JSON.stringify(desired)) throw new Error('Snapshot refresh failed: pending Tag desired set is missing');
          }
          for (const upload of appliedMedia) {
            if (!upload.existingEntry) continue;
            const receipt = mediaReceipts.get(upload.uploadId)!;
            const owner = snapshot.payload.entries.find(row => row.syncUid === upload.entryUid);
            let expectedRef: string | undefined = receipt.relativeRef;
            let expectedPosition = upload.kind === 'cover' ? 0 : upload.ordinal + 1;
            for (const operation of appliedOperations) {
              if (operation.operationKind !== 'entry.media.set' || operation.entityUid !== upload.entryUid || operation.baseVersion < receipt.resourceVersion) continue;
              const position = operation.payload.refs.indexOf(expectedRef!);
              expectedPosition = position;
              expectedRef = position < 0 ? undefined : renamedEntryMediaRefs(receipt.entityId, operation.payload.refs)[position];
            }
            if (!owner || owner.id !== receipt.entityId || (owner.syncVersion ?? 0) < receipt.resourceVersion
              || (expectedRef !== undefined && [owner.coverRef, ...owner.previewRefs][expectedPosition] !== expectedRef)) {
              throw new Error('Snapshot refresh failed: applied media receipt is missing from the authoritative Entry');
            }
            if (expectedRef !== undefined) {
              const response = await fetch(online.assetUrl(expectedRef), {cache:'no-store'});
              if (!response.ok || await sha256Hex(await response.blob()) !== upload.sha256) throw new Error('Snapshot refresh failed: applied media bytes do not match');
            }
          }
          await store.writeMeta('verifiedReplayProjection', JSON.stringify({
            checksum: snapshot.header.checksum,
            operations: operations.filter(row => appliedOperations.some(applied => applied.opId === row.opId)).map(operationFingerprint),
            media: appliedMedia.map(row => row.uploadId),
          }));
          const applied = await applySnapshot(snapshot, {
            store,
            expectedBase: activeBeforeReplay,
            expectedClientId: clientId,
            ...(replayBase ? {expectedRevision:replayBase.revision} : {}),
            ...(candidate.acknowledgement ? {acknowledgement:candidate.acknowledgement} : {}),
            currentLibraryId,
            currentSyncEpoch,
            ...(activeBeforeReplay === null
              ? {}
              : { currentSnapshotSeq: activeBeforeReplay.snapshot.header.snapshotSeq }),
          });
          if (!applied.ok) throw new Error(`Snapshot refresh failed: ${applied.failure.reason}`);
          const reconciledAuthors: Record<string, number> = {};
          for (const operation of appliedOperations) {
            if (operation.operationKind !== 'entry.author.create-and-link') continue;
            const producer = snapshot.payload.producers.find((row) => row.syncUid?.toLowerCase() === operation.payload.producerUid.toLowerCase());
            const entry = snapshot.payload.entries.find((row) => row.syncUid?.toLowerCase() === operation.entityUid.toLowerCase());
            if (producer === undefined || producer.id !== appliedProducerIds.get(operation.payload.producerUid) || entry === undefined) {
              throw new Error('Snapshot refresh did not include the new Author identity or final relation');
            }
            reconciledAuthors[String(localCollectionId(operation.payload.producerUid))] = producer.id;
          }
          await acknowledgeSnapshotCandidate(online, store, candidate, applied.generationId, applied.revision);
          await store.removeApplied(appliedOperations.map(row => row.opId));
          if (hasMediaOutbox(store)) {
            for (const upload of appliedMedia) await store.removeMedia(upload.uploadId);
          }
          await options.nativeTransfers?.reconcile();
          invalidateOfflineLibrary();
          if (options.state !== undefined) {
            options.state.reconciledAuthorIds = reconciledAuthors;
            options.state.lastReplaySnapshotSeq = snapshot.header.snapshotSeq;
          }
          const reconciled = new Map<number, number>();
          for (const operation of appliedOperations) {
            if (operation.operationKind !== 'collection.create') continue;
            const row = snapshot.payload.collections.find((collection) => collection.syncUid === operation.entityUid);
            if (row !== undefined) reconciled.set(localCollectionId(operation.entityUid), row.id);
          }
          if (reconciled.size > 0) {
            for (const listener of reconciliationListeners) {
              try { listener(reconciled); } catch { /* A view cannot undo a committed replay. */ }
            }
          }
        }
      } catch (cause) {
        replayError = cause instanceof Error ? cause.message : String(cause);
        if (attemptedOpId !== null) {
          await store.update(attemptedOpId, { status: 'pending', lastError: replayError });
        }
        if (attemptedUploadId !== null && hasMediaOutbox(store)) {
          await store.updateMedia(attemptedUploadId, { status: 'pending', lastError: replayError });
        }
      } finally {
        await setReplayStateFromStore(replayError);
      }
    })().finally(() => {
      replayPromise = null;
    });
    return replayPromise;
  }

  async function discardBlockedOfflineOperations(): Promise<void> {
    if (!hasOutbox(store)) return;
    const operations = await store.list();
    const active = await readActiveSnapshot(store);
    const currentLibraryId = active?.snapshot.header.libraryId;
    const currentSyncEpoch = active?.snapshot.header.syncEpoch;
    const firstBlockedIndexByEntity = new Map<string, number>();
    const blockedRatingSlotUids = new Set<string>();
    operations.forEach((operation, index) => {
      if (operation.status !== 'conflict' && operation.status !== 'failed'
        && (currentLibraryId === undefined || (operation.libraryId === currentLibraryId && operation.syncEpoch === currentSyncEpoch))) return;
      const ownKey = `${operation.entityKind}:${operation.entityUid}`;
      if (!firstBlockedIndexByEntity.has(ownKey)) firstBlockedIndexByEntity.set(ownKey, index);
      try {
        const blocked = transportOperation(operation);
        for (const key of referencedEntityKeys(blocked)) {
          if (!firstBlockedIndexByEntity.has(key)) firstBlockedIndexByEntity.set(key, index);
        }
        for (const uid of newlyCreatedRatingSlotUids(blocked)) blockedRatingSlotUids.add(uid);
      } catch {
        // Unknown envelopes are still discarded only along their own entity chain.
      }
    });
    const discarded = operations.filter((operation, index) => {
      const ownKey = `${operation.entityKind}:${operation.entityUid}`;
      const blockedIndex = firstBlockedIndexByEntity.get(ownKey);
      if (blockedIndex !== undefined && index >= blockedIndex) return true;
      try {
        const parsed = transportOperation(operation);
        return referencedEntityKeys(parsed).some((key) => {
          const dependencyIndex = firstBlockedIndexByEntity.get(key);
          return dependencyIndex !== undefined && index >= dependencyIndex;
        }) || referencedRatingSlotUids(parsed).some((uid) => blockedRatingSlotUids.has(uid));
      } catch {
        return false;
      }
    });
    const discardedCreateEntityUids = new Set(discarded
      .filter((operation) => operation.operationKind === 'entry.create')
      .map((operation) => operation.entityUid));
    // Media-only failure discard also needs a tombstone before source deletion.
    await options.nativeTransfers?.pause();
    await store.removeMany(discarded.map((operation) => operation.opId));
    if (hasMediaOutbox(store)) {
      const media = await store.listMedia();
      const failedCoverOwners = new Set(media.filter(row=>row.kind==='cover' && row.status==='failed').map(row=>row.entryUid));
      const failedPreviewOrdinals = new Map<string, number>();
      for (const upload of media) {
        if (upload.status === 'failed' && upload.kind === 'preview') {
          failedPreviewOrdinals.set(upload.entryUid,
            Math.min(upload.ordinal, failedPreviewOrdinals.get(upload.entryUid) ?? Infinity));
        }
      }
      await Promise.all(media
        .filter((upload) => upload.status === 'failed' || discardedCreateEntityUids.has(upload.entryUid)
          || failedCoverOwners.has(upload.entryUid)
          || (upload.kind === 'preview'
            && upload.ordinal >= (failedPreviewOrdinals.get(upload.entryUid) ?? Infinity)))
        .map((upload) => store.removeMedia(upload.uploadId)));
    }
    invalidateOfflineLibrary();
    await setReplayStateFromStore();
  }

  void setReplayStateFromStore().catch(() => undefined);

  const facade: GalleryApi = {
    ...online,
    async uploadEntryMedia(entryId, kind, file) {
      const enqueue = async () => {
        if (!hasMediaOutbox(store) || !store.enqueueExistingEntryMedia || !store.captureSnapshot) throw new Error('Offline media storage is unavailable');
        if (await store.readMeta('capability.existingEntryMedia') !== '1') throw new Error('Existing Entry media is not enabled; refresh the offline copy');
        const captured = await store.captureSnapshot();
        const active = captured.active;
        const entry = active?.snapshot.payload.entries.find(row => row.id === entryId && row.id > 0);
        if (!active || !entry?.syncUid) throw new Error('Existing Entry is unavailable in the offline copy');
        if (!ALLOWED_MEDIA_TYPES.has(file.type as StagedMediaUpload['mimeType']) || file.size <= 0 || file.size > MAX_STAGED_MEDIA_BYTES) throw new Error('Unsupported offline image type or size');
        const rows = await store.listMedia();
        const prior = rows.filter(row => row.entryUid === entry.syncUid);
        if (prior.some(row => !row.existingEntry || row.status !== 'pending')) throw new Error('Earlier media needs review before adding images');
        const operations = await store.list();
        const predecessor = parsedMediaOrderOperations(operations).filter(row => row.entityUid === entry.syncUid).at(-1);
        const canonical = predecessor ? renamedEntryMediaRefs(entry.id, predecessor.payload.refs) : [entry.coverRef, ...entry.previewRefs];
        let cover = canonical[0] ?? null;
        const previews = canonical.slice(1).filter((ref): ref is string => ref !== null);
        const extensions = {'image/avif':'avif','image/gif':'gif','image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
        for (const row of prior.sort((a,b) => a.kind === b.kind ? a.ordinal-b.ordinal : a.kind === 'cover' ? -1 : 1)) {
          const name = row.kind === 'cover' ? 'cover' : row.ordinal === 0 ? 'preview' : `preview-${row.ordinal+1}`;
          const ref = `/api/assets/entries/${entry.id}/${name}.${row.uploadId}.${extensions[row.mimeType]}`;
          if (row.kind === 'cover') cover = ref; else previews.push(ref);
        }
        if (kind === 'cover' && (cover !== null || prior.length)) throw new Error('Offline media cannot replace an occupied cover or reorder pending media');
        const ordinal = kind === 'cover' ? 0 : previews.length;
        if (ordinal > 31 || (ordinal > 0 && await store.readMeta(MEDIA_MULTIPLE_PREVIEWS_CAPABILITY_KEY) !== '1')) throw new Error('Multiple offline previews are unavailable');
        let uploadId=randomUUID();
        try { uploadId=await options.nativeTransfers?.allocateUploadId?.() ?? uploadId; }catch { /* old/uncertain native originals remain foreground replayable, not cancelable */ }
        const upload: StagedMediaUpload = {uploadId,libraryId:active.snapshot.header.libraryId,syncEpoch:active.snapshot.header.syncEpoch,entryUid:entry.syncUid,kind,ordinal,mimeType:file.type as StagedMediaUpload['mimeType'],byteLength:file.size,sha256:await sha256Hex(file),blob:file,existingEntry:{expectedCoverRef:cover,expectedPreviewRefs:previews},status:'pending',lastAttemptAt:null,lastError:null};
        await store.enqueueExistingEntryMedia(upload,{snapshot:JSON.stringify(active.snapshot),revision:captured.revision,media:mediaQueueIdentity(rows)});
        invalidateOfflineLibrary(); setMode('offline');
        try { await setReplayStateFromStore(); } catch { /* durable commit already succeeded */ }
        try { await options.nativeTransfers?.handoff(); } catch { /* original media remains available to foreground retry */ }
        return (await loadOfflineLibrary())!.getEntry(entryId);
      };
      const touchedNow = async (): Promise<string[]> => {
        const entry = await entryMediaRefsOf(entryId);
        return entry;
      };
      if (mode === 'offline') return enqueue();
      if (hasMediaOutbox(store) && (await store.listMedia()).length) return enqueue();
      try {
        const entry = await online.uploadEntryMedia(entryId,kind,file);
        await forgetEntryMedia(await touchedNow());
        return entry;
      } catch (cause) {
        if (!isOfflineTransportError(cause)) throw cause;
        return enqueue();
      }
    },
    /**
     * Deletes and/or reorders an Entry's media by handing over the whole list
     * in its new order — the first ref is the cover.
     *
     * Online this is an ordinary REST write beside the upload above; offline
     * (or when the write does not reach the server) it becomes one durable
     * command carrying the revision the person actually reviewed, so the
     * server refuses a list that moved underneath them.
     */
    async getEntryMediaRemovalBlockReason(entryId) {
      if(entryId<=0)return 'This Entry has no server row yet; sync it before deleting or moving images';
      if(!hasMediaOutbox(store))return null;
      const active=await readActiveSnapshot(store);const uid=active?.snapshot.payload.entries.find(row=>row.id===entryId)?.syncUid;
      const staged=(await store.listMedia()).filter(row=>row.entryUid===uid);
      if(!staged.length)return null;
      if(staged.some(row=>row.status!=='pending' || row.lastAttemptAt!==null || row.kind!=='preview'))return 'Upload attempted or uncertain; use foreground Update before deleting or moving images';
      if(options.nativeTransfers && !await options.nativeTransfers.inspectPreviewCancel?.(staged))return 'Native upload attempted or uncertain; use foreground Update before deleting or moving images';
      return null;
    },
    async setEntryMediaOrder(entryId, refs) {
      // The record the callers get back is the copy's own view of the Entry,
      // already wearing the order that was just queued.
      const recordFrom = (snapshot: SyncSnapshot): EntryRecordDto => {
        const row = snapshot.payload.entries.find((candidate) => candidate.id === entryId);
        if (row === undefined) throw new Error('This Entry is not in the offline copy yet; sync it first');
        return {
          id: row.id, title: row.title, type: row.type,
          coverRef: row.coverRef ?? null, previewRef: row.previewRef ?? null,
          previewRefs: row.previewRefs, uploadDate: row.uploadDate ?? null, pageCount: row.pageCount ?? null,
        };
      };
      const enqueue = async () => {
        if (!hasOutbox(store)) throw new Error('Offline media storage is unavailable');
        if (await store.readMeta(ENTRY_MEDIA_ORDER_CAPABILITY_KEY) !== '1') {
          throw new Error('This offline copy does not support changing Entry media; update it while online');
        }
        await options.nativeTransfers?.pause();
        await options.nativeTransfers?.reconcile();
        const captured = store.captureSnapshot ? await store.captureSnapshot() : undefined;
        const active = captured ? captured.active : await readActiveSnapshot(store);
        if (active === null) throw new Error('Download an offline copy before changing its media');
        const operations = await store.list();
        const projected = snapshotWithOverlays(active.snapshot, operations);
        const entry = projected.payload.entries.find((row) => row.id === entryId);
        // A pending create has no server row yet: its staged images are the
        // upload path's business, not this one's.
        if (entry === undefined || entry.syncUid === undefined || entry.id <= 0) {
          throw new Error('This Entry is not in the offline copy yet; sync it first');
        }
        const staged = hasMediaOutbox(store) ? (await store.listMedia()).filter(row => row.entryUid === entry.syncUid) : [];
        const visible = (await loadOfflineLibrary())!.getEntry(entryId);
        const current = [...(visible.coverRef ? [visible.coverRef] : []), ...visible.previewRefs];
        if (JSON.stringify(current) === JSON.stringify(refs)) {
          return recordFrom(projected);
        }
        const removedStaged = staged.filter(row => !refs.some(ref => ref.endsWith(`#t3-upload=${row.uploadId}`) || ref.includes(`.${row.uploadId}.`)));
        if (removedStaged.length) {
          if (options.nativeTransfers) {
            if(!options.nativeTransfers.authorizePreviewCancel)throw new Error('Native upload attempt state is uncertain; replay in foreground before deleting this preview');
            // Every later preview may be rebased: require authority for the whole owner chain.
            await options.nativeTransfers.authorizePreviewCancel(staged);
          }
          if (!hasMediaOutbox(store) || !store.cancelExistingEntryPreviews || !captured) throw new Error('Safe staged cancellation is unavailable');
          const persisted = current.filter(ref => !ref.includes('#t3-upload='));
          if (JSON.stringify(refs.filter(ref => !ref.includes('#t3-upload='))) !== JSON.stringify(persisted)) throw new Error('Cancel staged previews separately before changing stored media');
          const allMedia = await store.listMedia();
          await store.cancelExistingEntryPreviews(entry.syncUid, staged.filter(row => !removedStaged.includes(row)).map(row=>row.uploadId),
            {snapshot:JSON.stringify(active.snapshot),revision:captured.revision,media:mediaQueueIdentity(allMedia)});
          invalidateOfflineLibrary(); setMode('offline');
          await setReplayStateFromStore();
          return (await loadOfflineLibrary())!.getEntry(entryId);
        }
        const predecessor = parsedMediaOrderOperations(operations).filter(row => row.entityUid === entry.syncUid).at(-1);
        const wireBase = predecessor ? renamedEntryMediaRefs(entry.id, predecessor.payload.refs) : [...(entry.coverRef ? [entry.coverRef] : []), ...entry.previewRefs];
        const extensions = {'image/avif':'avif','image/gif':'gif','image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
        for (const row of staged) {
          const name = row.kind === 'cover' ? 'cover' : row.ordinal === 0 ? 'preview' : `preview-${row.ordinal+1}`;
          const ref = `/api/assets/entries/${entry.id}/${name}.${row.uploadId}.${extensions[row.mimeType]}`;
          if (!wireBase.includes(ref)) wireBase.push(ref);
        }
        const wireDesired = refs.map(ref => {
          const index = current.indexOf(ref);
          if (index < 0 || wireBase[index] === undefined) throw new Error('Entry media identity is not in the reviewed list');
          return wireBase[index]!;
        });
        const operation = createPendingSyncOperation({
          clientId,
          libraryId: active.snapshot.header.libraryId,
          syncEpoch: active.snapshot.header.syncEpoch,
          entityKind: 'entry',
          entityUid: entry.syncUid,
          operationKind: 'entry.media.set',
          baseVersion: (entry.syncVersion ?? 0) + staged.length,
          baseValues: { refs: wireBase },
          payload: { refs: wireDesired },
        }, { randomUUID });
        // The wire shape is the request union's, not the replay union's: media
        // order is the one operation the synchronous replay does not carry.
        const normalized = { ...operation, ...syncReplayRequestSchema.parse(wireFields(operation)) } as PendingSyncOperation;
        await enqueueDurably(normalized);
        invalidateOfflineLibrary();
        setMode('offline');
        try { await setReplayStateFromStore(); } catch { /* durable commit already succeeded */ }
        try { await options.nativeTransfers?.handoff(); } catch { /* foreground retry remains available */ }
        return recordFrom(snapshotWithOverlays(active.snapshot, [...operations, normalized]));
      };
      // Both the list that was there and the one going in: a name can be
      // reused by a different picture, and either side may be cached.
      const previous = await entryMediaRefsOf(entryId);
      const touched = [...previous, ...refs];
      if (mode === 'offline') {
        return enqueue();
      }
      try {
        const updated = await online.setEntryMediaOrder!(entryId, refs);
        await forgetEntryMedia(touched);
        return updated;
      } catch (cause) {
        if (!isOfflineTransportError(cause)) throw cause;
        return enqueue();
      }
    },
    preferOfflineSnapshot,
    replayOfflineOperations: replayPendingOperations,
    async getClientId() {
      await ensureClientIdentity();
      return clientId;
    },
    async getSyncCapabilities(probeOptions?: { replay?: boolean }) {
      try {
        const result = await online.getSyncCapabilities();
        if(result.featureFlags?.offlineMutations !== undefined)await store.writeMeta('capability.offlineMutations',result.featureFlags.offlineMutations === true ? '1' : '0');
        if(result.featureFlags?.offlineEntryUpdate !== undefined)await store.writeMeta('capability.offlineEntryUpdate',result.featureFlags.offlineEntryUpdate === true ? '1' : '0');
        await store.writeMeta(GALLERY_ORDER_CAPABILITY_KEY, result.featureFlags?.offlineMutations === true && result.featureFlags.offlineGalleryOrder === true ? '1' : '0');
        await store.writeMeta('capability.existingEntryMedia', result.featureFlags?.existingEntryMedia === true ? '1' : '0');
        await store.writeMeta('capability.completeSnapshotDelta', result.featureFlags?.completeSnapshotDelta === true ? '1' : '0');
        const offlinePendingEntryAuthorCreate = ['offlineMutations', 'offlineAuthorCreate', 'offlineEntryAuthors', 'offlinePendingEntryAuthors', 'offlinePendingEntryAuthorCreate'].every(flag => result.featureFlags?.[flag] === true);
        await store.writeMeta('capability.offlinePendingEntryAuthorCreate', offlinePendingEntryAuthorCreate ? '1' : '0');
        await store.writeMeta('capability.offlineCrossEntryPendingAuthors', offlinePendingEntryAuthorCreate && result.featureFlags?.offlineCrossEntryPendingAuthors === true ? '1' : '0');
        await Promise.all([
          store.writeMeta(
            ENTRY_CREATE_CAPABILITY_KEY,
            result.featureFlags?.offlineEntryCreate === true ? '1' : '0',
          ),
          store.writeMeta(
            ENTRY_INITIAL_CONTENTS_CAPABILITY_KEY,
            result.featureFlags?.offlineMutations === true
              && result.featureFlags.offlineEntryInitialContents === true ? '1' : '0',
          ),
          store.writeMeta(PENDING_ENTRY_CONTENT_APPEND_CAPABILITY_KEY,
            result.featureFlags?.offlineMutations === true
              && result.featureFlags.offlineEntryContentAppend === true ? '1' : '0'),
          store.writeMeta(
            ENTRY_MEDIA_ORDER_CAPABILITY_KEY,
            result.featureFlags?.offlineEntryMediaOrder === true ? '1' : '0',
          ),
          store.writeMeta(
            MEDIA_UPLOAD_CAPABILITY_KEY,
            result.featureFlags?.offlineMediaUpload === true ? '1' : '0',
          ),
          store.writeMeta(
            MEDIA_MULTIPLE_PREVIEWS_CAPABILITY_KEY,
            result.featureFlags?.offlineMediaUpload === true
              && result.featureFlags.offlineMediaMultiplePreviews === true ? '1' : '0',
          ),
          store.writeMeta(
            USAGE_EVENTS_CAPABILITY_KEY,
            result.featureFlags?.offlineUsageEvents === true ? '1' : '0',
          ),
          store.writeMeta(
            ENTRY_VIEW_LATER_CAPABILITY_KEY,
            result.featureFlags?.offlineEntryViewLater === true ? '1' : '0',
          ),
          store.writeMeta(
            ENTRY_RATING_CAPABILITY_KEY,
            result.featureFlags?.offlineEntryRating === true ? '1' : '0',
          ),
          store.writeMeta(
            ENTRY_AUTHORS_CAPABILITY_KEY,
            result.featureFlags?.offlineMutations === true
              && result.featureFlags.offlineEntryAuthors === true ? '1' : '0',
          ),
          store.writeMeta(
            AUTHOR_CREATE_CAPABILITY_KEY,
            result.featureFlags?.offlineMutations === true
              && result.featureFlags.offlineAuthorCreate === true ? '1' : '0',
          ),
          store.writeMeta('capability.offlinePendingEntryContents', result.featureFlags?.offlineMutations === true && result.featureFlags.offlineEntryContents === true && result.featureFlags.offlinePendingEntryContents === true ? '1' : '0'),
          store.writeMeta('capability.offlinePendingEntryMetadata', result.featureFlags?.offlineMutations === true && result.featureFlags.offlinePendingEntryMetadata === true ? '1' : '0'),
            store.writeMeta(PENDING_ENTRY_AUTHORS_CAPABILITY_KEY,
            result.featureFlags?.offlineMutations === true
              && result.featureFlags.offlineEntryAuthors === true
              && result.featureFlags.offlinePendingEntryAuthors === true ? '1' : '0'),
          store.writeMeta(PENDING_ENTRY_TAGS_CAPABILITY_KEY,
            result.featureFlags?.offlineMutations === true
              && result.featureFlags.offlineEntryTags === true
              && result.featureFlags.offlinePendingEntryTags === true ? '1' : '0'),
          store.writeMeta('capability.offlineEntryFacetCreate', result.featureFlags?.offlineMutations === true && result.featureFlags.offlineEntryTags === true && result.featureFlags.offlineEntryFacetCreate === true ? '1' : '0'),
          store.writeMeta('capability.offlinePendingEntryTagCreation',
            result.featureFlags?.offlineMutations === true && result.featureFlags.offlineEntryTags === true
              && result.featureFlags.offlineEntryTagVocabulary === true && result.featureFlags.offlinePendingEntryTags === true
              && result.featureFlags.offlinePendingEntryTagCreation === true ? '1' : '0'),
          store.writeMeta(
            ENTRY_TAG_VOCABULARY_CAPABILITY_KEY,
            result.featureFlags?.offlineMutations === true && result.featureFlags.offlineEntryTags === true
              && result.featureFlags.offlineEntryTagVocabulary === true ? '1' : '0',
          ),
          store.writeMeta(
            ENTRY_TAGS_CAPABILITY_KEY,
            result.featureFlags?.offlineMutations === true
              && result.featureFlags.offlineEntryTags === true ? '1' : '0',
          ),
          store.writeMeta(
            ENTRY_CONTENTS_CAPABILITY_KEY,
            result.featureFlags?.offlineEntryContents === true ? '1' : '0',
          ),
          store.writeMeta(
            PRODUCER_VIEW_LATER_CAPABILITY_KEY,
            result.featureFlags?.offlineProducerViewLater === true ? '1' : '0',
          ),
          store.writeMeta(
            PRODUCER_RATING_CAPABILITY_KEY,
            result.featureFlags?.offlineProducerRating === true ? '1' : '0',
          ),
          store.writeMeta(
            PRODUCER_PROFILE_CAPABILITY_KEY,
            result.featureFlags?.offlineProducerProfile === true ? '1' : '0',
          ),
          store.writeMeta(
            PRODUCER_TAGS_CAPABILITY_KEY,
            result.featureFlags?.offlineProducerTags === true ? '1' : '0',
          ),
          store.writeMeta(
            RATING_LAYOUT_CAPABILITY_KEY,
            result.featureFlags?.offlineRatingSlotLayout === true ? '1' : '0',
          ),
          store.writeMeta(
            COLLECTION_PRODUCER_MEMBERSHIP_CAPABILITY_KEY,
            result.featureFlags?.offlineCollectionProducerMembership === true ? '1' : '0',
          ),
          store.writeMeta(
            COLLECTION_MANAGEMENT_CAPABILITY_KEY,
            result.featureFlags?.offlineMutations === true
              && result.featureFlags.offlineCollectionManagement === true ? '1' : '0',
          ),
          store.writeMeta(
            AUTHOR_DIRECTORIES_CAPABILITY_KEY,
            result.featureFlags?.offlineAuthorDirectories === true ? '1' : '0',
          ),
        ]);
        if (options.state !== undefined) {
          const at = new Date().toISOString();
          const offlineUsageEvents = result.featureFlags?.offlineUsageEvents === true;
          const offlineEntryViewLater = result.featureFlags?.offlineEntryViewLater === true;
          const offlineEntryRating = result.featureFlags?.offlineEntryRating === true;
          const offlineEntryAuthors = result.featureFlags?.offlineMutations === true
            && result.featureFlags.offlineEntryAuthors === true;
          const offlinePendingEntryAuthors = offlineEntryAuthors && result.featureFlags.offlinePendingEntryAuthors === true;
          const offlineAuthorCreate = result.featureFlags?.offlineMutations === true
            && result.featureFlags.offlineAuthorCreate === true;
          const offlineEntryTags = result.featureFlags?.offlineMutations === true
            && result.featureFlags.offlineEntryTags === true;
          const offlineEntryContents = result.featureFlags?.offlineEntryContents === true;
          const offlineProducerViewLater = result.featureFlags?.offlineProducerViewLater === true;
          const offlineProducerRating = result.featureFlags?.offlineProducerRating === true;
          const offlineProducerProfile = result.featureFlags?.offlineProducerProfile === true;
          const offlineProducerTags = result.featureFlags?.offlineProducerTags === true;
          const offlineRatingSlotLayout = result.featureFlags?.offlineRatingSlotLayout === true;
          const offlineCollectionProducerMembership = result.featureFlags?.offlineCollectionProducerMembership === true;


          const offlineCollectionManagement = result.featureFlags?.offlineMutations === true
            && result.featureFlags.offlineCollectionManagement === true;
          const offlineAuthorDirectories = result.featureFlags?.offlineAuthorDirectories === true;
          options.state.lastCapabilityProbe = {
            at,
            status: 'success',
            serverBuild: result.serverBuild,
            offlineUsageEvents,
            offlineEntryViewLater,
            offlineEntryRating,
            offlineEntryAuthors,
            offlinePendingEntryMetadata: result.featureFlags?.offlineMutations === true && result.featureFlags.offlinePendingEntryMetadata === true,
            offlinePendingEntryAuthors,
            offlinePendingEntryAuthorCreate,
            offlineAuthorCreate,
            offlineEntryTags,
            offlineEntryContents,
            offlineProducerViewLater,
            offlineProducerRating,
            offlineProducerProfile,
            offlineProducerTags,
            offlineRatingSlotLayout,
            offlineCollectionProducerMembership,
            offlineCollectionManagement,
            offlineAuthorDirectories,
            error: null,
          };
          options.state.lastSuccessfulCapabilityProbe = {
            at,
            serverBuild: result.serverBuild,
            offlineUsageEvents,
            offlineEntryViewLater,
            offlineEntryRating,
            offlineEntryAuthors,
            offlinePendingEntryMetadata: result.featureFlags?.offlineMutations === true && result.featureFlags.offlinePendingEntryMetadata === true,
            offlinePendingEntryAuthors,
            offlinePendingEntryAuthorCreate,
            offlineAuthorCreate,
            offlineEntryTags,
            offlineEntryContents,
            offlineProducerViewLater,
            offlineProducerRating,
            offlineProducerProfile,
            offlineProducerTags,
            offlineRatingSlotLayout,
            offlineCollectionProducerMembership,
            offlineCollectionManagement,
            offlineAuthorDirectories,
          };
        }
        setMode('online');
        setConnectionPhase(null);
        if (probeOptions?.replay !== false) await replayPendingOperations();
        return result;
      } catch (cause) {
        if (options.state !== undefined) {
          options.state.lastCapabilityProbe = {
            at: new Date().toISOString(),
            status: 'error',
            serverBuild: null,
            offlineUsageEvents: null,
            offlineEntryViewLater: null,
            offlineEntryRating: null,
            offlineEntryAuthors: null,
            offlinePendingEntryMetadata: null,
            offlinePendingEntryAuthors: null,
            offlineAuthorCreate: null,
            offlineEntryTags: null,
            offlineEntryContents: null,
            offlineProducerViewLater: null,
            offlineProducerRating: null,
            offlineProducerProfile: null,
            offlineProducerTags: null,
            offlineRatingSlotLayout: null,
            offlineCollectionProducerMembership: null,
            offlineCollectionManagement: null,
            offlineAuthorDirectories: null,
            error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
          };
        }
        throw cause;
      }
    },
    async fetchSyncSnapshot(requestOptions) {
      const result = await online.fetchSyncSnapshot(requestOptions);
      setMode('online');
      return result;
    },
    ...(typeof (store as Partial<AtomicPendingWorkStore>).restorePendingWork === 'function'
      && typeof (store as Partial<AtomicPendingWorkStore>).bindPendingWorkClient === 'function' ? {
      async previewPendingWorkRestore(text: string) {
        const atomic = store as OfflineStore & AtomicPendingWorkStore;
        const work = await preparePendingWork(text);
        await atomic.bindPendingWorkClient(clientId);
        const preview = await atomic.restorePendingWork(work, clientId, false);
        pendingRestorePreview = {text,identity:preview.snapshotIdentity};
        return preview;
      },
      async restorePendingWork(text: string) {
        const atomic = store as OfflineStore & AtomicPendingWorkStore;
        const work = await preparePendingWork(text);
        await atomic.bindPendingWorkClient(clientId);
        if (pendingRestorePreview?.text===text) work.expectedSnapshot=pendingRestorePreview.identity;
        const result = await atomic.restorePendingWork(work, clientId, true);
        pendingRestorePreview = null;
        invalidateOfflineLibrary();
        // Committed success must not be turned into a retry on diagnostic refresh failure.
        try { if (hasOutbox(store)) setReplayStateFromOperations(await store.list()); } catch { /* next explicit Update refreshes */ }
        return result;
      },
    } : {}),
    ...(options.nativeTransfers?.resume ? {resumeNativeTransfers: () => options.nativeTransfers!.resume!()} : {}),
    flushOfflineOutbox: replayPendingOperations,
    enqueueOfflineEntryCreate,
    getPendingOfflineEntryContentOptions,
    enqueueOfflinePendingEntryContents,
    enqueueOfflinePendingEntryMetadata,
    enqueueOfflinePendingEntryContent,
    getPendingOfflineEntryAuthorOptions,
    enqueueOfflinePendingEntryAuthors,
    enqueueOfflinePendingEntryAuthorCreate,
    getPendingOfflineEntryTagOptions,
    enqueueOfflinePendingEntryTags,
    enqueueOfflinePendingEntryTagCreate,
    async enqueueOfflinePendingEntryFacetCreate(localKey, name, sectionId) {
      const context = await pendingTagContext(localKey);
      const section = context.snapshot.payload.tagGroups.find(row => row.id === sectionId && row.groupKind === 'section' && row.entryType === context.parent.payload.type);
      if (!section) throw new Error('Select a saved Section of the same Entry type');
      await enqueueOfflineFacet({ sectionId, name });
    },
    async createFacet(input) {
      if (mode === 'offline') return enqueueOfflineFacet(input);
      try { await online.createFacet(input); setMode('online'); }
      catch (cause) { if (!isOfflineTransportError(cause)) throw cause; await enqueueOfflineFacet(input); }
    },
    listPendingOfflineEntryCreates,
    discardBlockedOfflineOperations,
    async updateEntry(entryId, input) {
      if (mode === 'offline') {
        return enqueueEntryUpdate(entryId, input, new TypeError('Server is unavailable'));
      }
      try {
        const result = await online.updateEntry(entryId, input);
        setMode('online');
        return result;
      } catch (cause) {
        if (!isOfflineTransportError(cause)) throw cause;
        return enqueueEntryUpdate(entryId, input, cause);
      }
    },
    async recordEntryView(entryId) {
      return diagnoseMutation('view', USAGE_EVENTS_CAPABILITY_KEY, async () => {
        if (mode === 'offline') return enqueueUsageEvent(entryId, 'view');
        try {
          const result = await online.recordEntryView(entryId);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueueUsageEvent(entryId, 'view', cause);
        }
      });
    },
    async likeEntry(entryId) {
      return diagnoseMutation('like', USAGE_EVENTS_CAPABILITY_KEY, async () => {
        if (mode === 'offline') return enqueueUsageEvent(entryId, 'like');
        try {
          const result = await online.likeEntry(entryId);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueueUsageEvent(entryId, 'like', cause);
        }
      });
    },
    async addViewLaterEntry(entryId) {
      return diagnoseMutation('view-later-add', ENTRY_VIEW_LATER_CAPABILITY_KEY, async () => {
        if (mode === 'offline') return enqueueEntryViewLater(entryId, true);
        try {
          const result = await online.addViewLaterEntry(entryId);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueueEntryViewLater(entryId, true, cause);
        }
      });
    },
    async removeViewLaterEntry(entryId) {
      return diagnoseMutation('view-later-remove', ENTRY_VIEW_LATER_CAPABILITY_KEY, async () => {
        if (mode === 'offline') return enqueueEntryViewLater(entryId, false);
        try {
          const result = await online.removeViewLaterEntry(entryId);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueueEntryViewLater(entryId, false, cause);
        }
      });
    },
    async addViewLaterAuthor(producerId) {
      return diagnoseMutation('producer-view-later-add', PRODUCER_VIEW_LATER_CAPABILITY_KEY, async () => {
        if (mode === 'offline') return enqueueProducerViewLater(producerId, true);
        try {
          const result = await online.addViewLaterAuthor(producerId);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueueProducerViewLater(producerId, true, cause);
        }
      });
    },
    async removeViewLaterAuthor(producerId) {
      return diagnoseMutation('producer-view-later-remove', PRODUCER_VIEW_LATER_CAPABILITY_KEY, async () => {
        if (mode === 'offline') return enqueueProducerViewLater(producerId, false);
        try {
          const result = await online.removeViewLaterAuthor(producerId);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueueProducerViewLater(producerId, false, cause);
        }
      });
    },
    async assignEntryTag(entryId, input) {
      return diagnoseMutation('entry-tags-set', ENTRY_TAGS_CAPABILITY_KEY, async () => {
        const enqueue = async (cause?: unknown) => {
          await enqueueEntryTags(entryId, (tags, snapshot) => {
          const normalized = normalizeTag(input.name);
          const alias = (snapshot.payload.taxonomyAliases ?? []).find((row) => (
            row.vocabulary === 'entry' && row.normalizedAlias === normalized
          ));
          const normalizedCanonical = alias?.normalizedCanonical ?? normalized;
          const known = snapshot.payload.tags.find((tag) => tag.normalizedName === normalizedCanonical);
          const displayName = known?.name ?? alias?.canonicalName ?? input.name;
          return [...tags.filter((tag) => normalizeTag(tag.name) !== normalizedCanonical),
            { name: displayName, facetId: input.facetId }];
          }, cause);
          return offlineAssignedTag(entryId, input);
        };
        if (mode === 'offline' || input.facetId < 0 || await hasQueuedEntryTags(entryId) || await hasStagedTag(input.name)) return enqueue();
        try {
          const result = await online.assignEntryTag(entryId, input);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueue(cause);
        }
      });
    },
    async moveEntryTag(entryId, tagId, targetFacetId) {
      return diagnoseMutation('entry-tags-set', ENTRY_TAGS_CAPABILITY_KEY, async () => {
        const enqueue = (cause?: unknown) => enqueueEntryTags(entryId, (tags, snapshot) => {
          const tag = snapshot.payload.tags.find((row) => row.id === tagId);
          if (tag === undefined || !snapshot.payload.entryTags.some((row) => row.entryId === entryId && row.tagId === tagId)) {
            throw new Error('Entry Tag is not assigned in this offline copy');
          }
          return tags.map((row) => normalizeTag(row.name) === tag.normalizedName
            ? { ...row, facetId: targetFacetId } : row);
        }, cause);
        if (mode === 'offline' || tagId < 0 || targetFacetId < 0 || await hasQueuedEntryTags(entryId)) return enqueue();
        try {
          await online.moveEntryTag(entryId, tagId, targetFacetId);
          setMode('online');
        } catch (cause) {
          return enqueue(cause);
        }
      });
    },
    async removeEntryTag(entryId, tagId) {
      return diagnoseMutation('entry-tags-set', ENTRY_TAGS_CAPABILITY_KEY, async () => {
        const enqueue = (cause?: unknown) => enqueueEntryTags(entryId, (tags, snapshot) => {
          const tag = snapshot.payload.tags.find((row) => row.id === tagId);
          if (tag === undefined || !snapshot.payload.entryTags.some((row) => row.entryId === entryId && row.tagId === tagId)) {
            throw new Error('Entry Tag is not assigned in this offline copy');
          }
          return tags.filter((row) => normalizeTag(row.name) !== tag.normalizedName);
        }, cause);
        if (mode === 'offline' || tagId < 0 || await hasQueuedEntryTags(entryId)) return enqueue();
        try {
          await online.removeEntryTag(entryId, tagId);
          setMode('online');
        } catch (cause) {
          return enqueue(cause);
        }
      });
    },
    async linkEntryAuthorByName(entryId, name) {
      return diagnoseMutation('entry-author-by-name', ENTRY_AUTHORS_CAPABILITY_KEY, async () => {
        const enqueue = async (cause?: unknown) => {
          if (cause !== undefined && !isOfflineTransportError(cause)) throw cause;
          const active = await readActiveSnapshot(store);
          if (active === null) throw cause ?? new Error('Offline Author catalog is unavailable');
          if (!hasOutbox(store)) throw cause ?? new Error('Offline Author Outbox is unavailable');
          const pending = await store.list();
          const snapshot = snapshotWithOverlays(active.snapshot, pending);
          const existing = resolveOfflineAuthorByName(snapshot, name);
          if (existing === null) return enqueueEntryAuthorCreate(entryId, canonicalOfflineAuthorName(snapshot, name), cause);
          if (existing.id < 0 && !snapshot.payload.entryProducers.some((row) => (
            row.entryId === entryId && row.producerId === existing.id
          ))) throw new Error('Sync the newly created Author before linking it to another Entry');
          await enqueueEntryAuthors(entryId, existing.id, true, cause);
          return { entryId, producerId: existing.id, producerName: existing.name,
            created: false, ...(existing.matchedAlias === undefined ? {} : { matchedAlias: existing.matchedAlias }) };
        };
        if (mode === 'offline') return enqueue();
        try {
          const result = await online.linkEntryAuthorByName(entryId, name);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueue(cause);
        }
      });
    },
    async linkEntryAuthor(entryId, authorId) {
      return diagnoseMutation('entry-authors-set', ENTRY_AUTHORS_CAPABILITY_KEY, async () => {
        if (mode === 'offline' || authorId < 0) return enqueueEntryAuthors(entryId, authorId, true);
        try {
          await online.linkEntryAuthor(entryId, authorId);
          setMode('online');
        } catch (cause) {
          return enqueueEntryAuthors(entryId, authorId, true, cause);
        }
      });
    },
    async unlinkEntryAuthor(entryId, authorId) {
      return diagnoseMutation('entry-authors-set', ENTRY_AUTHORS_CAPABILITY_KEY, async () => {
        if (mode === 'offline' || authorId < 0) return enqueueEntryAuthors(entryId, authorId, false);
        try {
          await online.unlinkEntryAuthor(entryId, authorId);
          setMode('online');
        } catch (cause) {
          return enqueueEntryAuthors(entryId, authorId, false, cause);
        }
      });
    },
    async setEntryRating(entryId, slotId, stars) {
      return diagnoseMutation('rating-set', ENTRY_RATING_CAPABILITY_KEY, async () => {
        if (mode === 'offline') return enqueueEntryRating(entryId, slotId, stars);
        try {
          const result = await online.setEntryRating(entryId, slotId, stars);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueueEntryRating(entryId, slotId, stars, cause);
        }
      });
    },
    async updateAuthor(authorId, input) {
      return diagnoseMutation('producer-profile-update', PRODUCER_PROFILE_CAPABILITY_KEY, async () => {
        if (mode === 'offline') return enqueueProducerProfileUpdate(authorId, input);
        try {
          const result = await online.updateAuthor(authorId, input);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueueProducerProfileUpdate(authorId, input, cause);
        }
      });
    },
    async assignAuthorTag(authorId, name) {
      return diagnoseMutation('producer-tags-set', PRODUCER_TAGS_CAPABILITY_KEY, async () => {
        const enqueue = (cause?: unknown) => enqueueProducerTags(authorId, (tags, snapshot) => {
          const displayName = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
          const normalizedName = normalizeTag(displayName);
          if (normalizedName === '' || tags.some((tag) => normalizeTag(tag.name) === normalizedName)) return tags;
          const known = snapshot.payload.producerTags.find((tag) => tag.normalizedName === normalizedName);
          if (known?.syncUid === undefined && known !== undefined) {
            throw new Error('Refresh this offline copy before assigning Author tags; stable tag identities are missing');
          }
          return [...tags, { syncUid: known?.syncUid ?? randomUUID(), name: known?.name ?? displayName }];
        }, cause);
        if (mode === 'offline') return enqueue();
        try {
          await online.assignAuthorTag(authorId, name);
          setMode('online');
        } catch (cause) {
          await enqueue(cause);
        }
      });
    },
    async renameAuthorTag(authorId, tagId, name) {
      return diagnoseMutation('producer-tags-set', PRODUCER_TAGS_CAPABILITY_KEY, async () => {
        const enqueue = (cause?: unknown) => enqueueProducerTags(authorId, (tags, snapshot) => {
          const source = snapshot.payload.producerTags.find((tag) => tag.id === tagId);
          if (source?.syncUid === undefined || !tags.some((tag) => tag.syncUid === source.syncUid)) {
            throw new Error('Author tag is unavailable in this offline copy; refresh before editing');
          }
          const displayName = name.normalize('NFKC').trim().replace(/\s+/gu, ' ');
          const normalizedName = normalizeTag(displayName);
          if (normalizedName === '' || normalizedName === source.normalizedName) return tags;
          const known = snapshot.payload.producerTags.find((tag) => tag.normalizedName === normalizedName);
          if (known?.syncUid === undefined && known !== undefined) {
            throw new Error('Refresh this offline copy before renaming Author tags; stable tag identities are missing');
          }
          const targetUid = known?.syncUid ?? randomUUID();
          const desired = tags.filter((tag) => tag.syncUid !== source.syncUid);
          if (!desired.some((tag) => tag.syncUid === targetUid)) {
            desired.push({ syncUid: targetUid, name: known?.name ?? displayName });
          }
          return desired;
        }, cause);
        if (mode === 'offline') return enqueue();
        try {
          await online.renameAuthorTag(authorId, tagId, name);
          setMode('online');
        } catch (cause) {
          await enqueue(cause);
        }
      });
    },
    async removeAuthorTag(authorId, tagId) {
      return diagnoseMutation('producer-tags-set', PRODUCER_TAGS_CAPABILITY_KEY, async () => {
        const enqueue = (cause?: unknown) => enqueueProducerTags(authorId, (tags, snapshot) => {
          const source = snapshot.payload.producerTags.find((tag) => tag.id === tagId);
          if (source?.syncUid === undefined || !tags.some((tag) => tag.syncUid === source.syncUid)) {
            throw new Error('Author tag is unavailable in this offline copy; refresh before editing');
          }
          return tags.filter((tag) => tag.syncUid !== source.syncUid);
        }, cause);
        if (mode === 'offline') return enqueue();
        try {
          await online.removeAuthorTag(authorId, tagId);
          setMode('online');
        } catch (cause) {
          await enqueue(cause);
        }
      });
    },
    async setAuthorRating(authorId, slotId, stars) {
      return diagnoseMutation('producer-rating-set', PRODUCER_RATING_CAPABILITY_KEY, async () => {
        if (mode === 'offline') return enqueueProducerRating(authorId, slotId, stars);
        try {
          const result = await online.setAuthorRating(authorId, slotId, stars);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueueProducerRating(authorId, slotId, stars, cause);
        }
      });
    },
    async createEntryRatingSlot(entryId, name) {
      return diagnoseMutation('rating-layout-set', RATING_LAYOUT_CAPABILITY_KEY, async () => {
        const normalizedName = name.trim();
        if (normalizedName === '') throw new Error('Rating slot name cannot be empty');
        const createdUid = randomUUID();
        const enqueue = async (cause?: unknown) => {
          const projected = await enqueueRatingSlotLayout('entry', entryId, (slots) => {
            if (slots.some((slot) => slot.name === normalizedName)) return slots;
            const sortOrder = slots.reduce((maximum, slot) => Math.max(maximum, slot.sortOrder), -1) + 1;
            return [...slots, { syncUid: createdUid, name: normalizedName, sortOrder }];
          }, cause);
          const entryType = projected.payload.entries.find((entry) => entry.id === entryId)?.type;
          const slot = projected.payload.ratingSlots.find((row) => row.syncUid === createdUid)
            ?? projected.payload.ratingSlots.find((row) => row.subjectKind === 'entry'
              && row.entryType === entryType && row.name === normalizedName);
          if (slot === undefined) throw new Error('Rating slot could not be added to the offline layout');
          return { id: slot.id, name: slot.name, sortOrder: slot.sortOrder };
        };
        if (mode === 'offline') return enqueue();
        try {
          const result = await online.createEntryRatingSlot(entryId, normalizedName);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueue(cause);
        }
      });
    },
    async reorderEntryRatingSlots(entryId, orderedSlotIds) {
      return diagnoseMutation('rating-layout-set', RATING_LAYOUT_CAPABILITY_KEY, async () => {
        const enqueue = async (cause?: unknown) => {
          await enqueueRatingSlotLayout('entry', entryId, (slots, snapshot) => {
            if (orderedSlotIds.length !== slots.length || new Set(orderedSlotIds).size !== slots.length) {
              throw new Error('Rating slot order must contain every current slot exactly once');
            }
            const entryType = snapshot.payload.entries.find((entry) => entry.id === entryId)?.type;
            if (entryType === undefined) throw new Error('Entry is unavailable in this offline copy');
            const byId = new Map(snapshot.payload.ratingSlots
              .filter((slot) => slot.subjectKind === 'entry' && slot.entryType === entryType)
              .map((slot) => [slot.id, slot]));
            return orderedSlotIds.map((id, sortOrder) => {
              const slot = byId.get(id);
              if (slot?.syncUid === undefined) throw new Error('Rating slot order does not match this offline layout');
              const base = slots.find((value) => value.syncUid === slot.syncUid);
              if (base === undefined) throw new Error('Rating slot order does not match this offline layout');
              return { ...base, sortOrder };
            });
          }, cause);
        };
        if (mode === 'offline') return enqueue();
        try {
          await online.reorderEntryRatingSlots(entryId, orderedSlotIds);
          setMode('online');
        } catch (cause) {
          await enqueue(cause);
        }
      });
    },
    async createAuthorRatingSlot(authorId, name) {
      return diagnoseMutation('rating-layout-set', RATING_LAYOUT_CAPABILITY_KEY, async () => {
        const normalizedName = name.trim();
        if (normalizedName === '') throw new Error('Rating slot name cannot be empty');
        const createdUid = randomUUID();
        const enqueue = async (cause?: unknown) => {
          const projected = await enqueueRatingSlotLayout('producer', authorId, (slots) => {
            if (slots.some((slot) => slot.name === normalizedName)) return slots;
            const sortOrder = slots.reduce((maximum, slot) => Math.max(maximum, slot.sortOrder), -1) + 1;
            return [...slots, { syncUid: createdUid, name: normalizedName, sortOrder }];
          }, cause);
          const galleryType = createOfflineLibrary(projected).getAuthor(authorId).galleryType;
          const slot = projected.payload.ratingSlots.find((row) => row.syncUid === createdUid)
            ?? projected.payload.ratingSlots.find((row) => row.subjectKind === 'producer'
              && row.entryType === galleryType && row.name === normalizedName);
          if (slot === undefined) throw new Error('Rating slot could not be added to the offline layout');
          return { id: slot.id, name: slot.name, sortOrder: slot.sortOrder };
        };
        if (mode === 'offline') return enqueue();
        try {
          const result = await online.createAuthorRatingSlot(authorId, normalizedName);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueue(cause);
        }
      });
    },
    async reorderAuthorRatingSlots(authorId, orderedSlotIds) {
      return diagnoseMutation('rating-layout-set', RATING_LAYOUT_CAPABILITY_KEY, async () => {
        const enqueue = async (cause?: unknown) => {
          await enqueueRatingSlotLayout('producer', authorId, (slots, snapshot) => {
            if (orderedSlotIds.length !== slots.length || new Set(orderedSlotIds).size !== slots.length) {
              throw new Error('Rating slot order must contain every current slot exactly once');
            }
            const galleryType = createOfflineLibrary(snapshot).getAuthor(authorId).galleryType;
            if (galleryType === null) throw new Error('Cannot reorder rating slots for an Author without works');
            const byId = new Map(snapshot.payload.ratingSlots
              .filter((slot) => slot.subjectKind === 'producer' && slot.entryType === galleryType)
              .map((slot) => [slot.id, slot]));
            return orderedSlotIds.map((id, sortOrder) => {
              const slot = byId.get(id);
              if (slot?.syncUid === undefined) throw new Error('Rating slot order does not match this offline layout');
              const base = slots.find((value) => value.syncUid === slot.syncUid);
              if (base === undefined) throw new Error('Rating slot order does not match this offline layout');
              return { ...base, sortOrder };
            });
          }, cause);
        };
        if (mode === 'offline') return enqueue();
        try {
          await online.reorderAuthorRatingSlots(authorId, orderedSlotIds);
          setMode('online');
        } catch (cause) {
          await enqueue(cause);
        }
      });
    },
    async setGalleryOrder(orderedTypes) {
      if (mode === 'offline') { await enqueueGalleryOrder(orderedTypes); return [...orderedTypes]; }
      try { const result = await online.setGalleryOrder(orderedTypes); setMode('online'); return result; }
      catch (cause) { await enqueueGalleryOrder(orderedTypes, cause); return [...orderedTypes]; }
    },
    async createCollection(input) {
      return diagnoseMutation('collection-management-set', COLLECTION_MANAGEMENT_CAPABILITY_KEY, async () => {
        const parent = input.parentId === undefined ? null : await resolveCollectionId(input.parentId);
        const resolvedInput = parent === null ? input : { ...input, parentId: parent.id };
        if (mode === 'offline' || parent?.pending) return enqueueCollectionCreate(resolvedInput);
        try {
          const result = await online.createCollection(resolvedInput);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueueCollectionCreate(resolvedInput, cause);
        }
      });
    },
    async updateCollection(collectionId, input) {
      return diagnoseMutation('collection-management-set', COLLECTION_MANAGEMENT_CAPABILITY_KEY, async () => {
        const target = await resolveCollectionId(collectionId);
        if (mode === 'offline' || target.pending) return enqueueCollectionMetadata(target.id, input);
        try {
          const result = await online.updateCollection(target.id, input);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueueCollectionMetadata(target.id, input, undefined, cause);
        }
      });
    },
    async setCollectionNsfw(collectionId, nsfw) {
      return diagnoseMutation('collection-management-set', COLLECTION_MANAGEMENT_CAPABILITY_KEY, async () => {
        const target = await resolveCollectionId(collectionId);
        if (mode === 'offline' || target.pending) return enqueueCollectionMetadata(target.id, {}, nsfw);
        try {
          const result = await online.setCollectionNsfw(target.id, nsfw);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueueCollectionMetadata(target.id, {}, nsfw, cause);
        }
      });
    },
    async reorderCollections(kind, orderedCollectionIds) {
      return diagnoseMutation('collection-management-set', COLLECTION_MANAGEMENT_CAPABILITY_KEY, async () => {
        const targets = await Promise.all(orderedCollectionIds.map(resolveCollectionId));
        const ids = targets.map((target) => target.id);
        if (mode === 'offline' || targets.some((target) => target.pending)) return enqueueCollectionOrder(kind, ids);
        try {
          await online.reorderCollections(kind, ids);
          setMode('online');
        } catch (cause) {
          await enqueueCollectionOrder(kind, ids, cause);
        }
      });
    },
    async addCollectionEntry(collectionId, entryId) {
      return diagnoseMutation('collection-management-set', COLLECTION_MANAGEMENT_CAPABILITY_KEY, async () => {
        const target = await resolveCollectionId(collectionId);
        if (mode === 'offline' || target.pending) return enqueueCollectionEntryMembership(target.id, entryId, true);
        try {
          await online.addCollectionEntry(target.id, entryId);
          setMode('online');
        } catch (cause) {
          await enqueueCollectionEntryMembership(target.id, entryId, true, cause);
        }
      });
    },
    async removeCollectionEntry(collectionId, entryId) {
      return diagnoseMutation('collection-management-set', COLLECTION_MANAGEMENT_CAPABILITY_KEY, async () => {
        const target = await resolveCollectionId(collectionId);
        if (mode === 'offline' || target.pending) return enqueueCollectionEntryMembership(target.id, entryId, false);
        try {
          await online.removeCollectionEntry(target.id, entryId);
          setMode('online');
        } catch (cause) {
          await enqueueCollectionEntryMembership(target.id, entryId, false, cause);
        }
      });
    },
    async addCollectionProducer(collectionId, producerId) {
      return diagnoseMutation('collection-producer-set', COLLECTION_PRODUCER_MEMBERSHIP_CAPABILITY_KEY, async () => {
        const target = await resolveCollectionId(collectionId);
        if (mode === 'offline' || target.pending) return enqueueCollectionProducerMembership(target.id, producerId, true);
        try {
          await online.addCollectionProducer(target.id, producerId);
          setMode('online');
        } catch (cause) {
          await enqueueCollectionProducerMembership(target.id, producerId, true, cause);
        }
      });
    },
    async removeCollectionProducer(collectionId, producerId) {
      return diagnoseMutation('collection-producer-set', COLLECTION_PRODUCER_MEMBERSHIP_CAPABILITY_KEY, async () => {
        const target = await resolveCollectionId(collectionId);
        if (mode === 'offline' || target.pending) return enqueueCollectionProducerMembership(target.id, producerId, false);
        try {
          await online.removeCollectionProducer(target.id, producerId);
          setMode('online');
        } catch (cause) {
          await enqueueCollectionProducerMembership(target.id, producerId, false, cause);
        }
      });
    },
    async createAuthorDirectory(authorId, input) {
      return diagnoseMutation('author-directories-set', AUTHOR_DIRECTORIES_CAPABILITY_KEY, async () => {
        const directoryUid = randomUUID();
        const enqueue = async (cause?: unknown) => {
          const updated = await enqueueAuthorDirectories(authorId, (directories, snapshot) => {
            const rawSelectedIds = input.entryIds ?? [];
            if (new Set(rawSelectedIds).size !== rawSelectedIds.length) {
              throw new Error('Directory Entry selection may contain each Entry only once');
            }
            const selectedIds = [...rawSelectedIds];
            const entryById = new Map(snapshot.payload.entries.map((entry) => [entry.id, entry]));
            const ownedEntryIds = new Set(snapshot.payload.entryProducers
              .filter((relation) => relation.producerId === authorId).map((relation) => relation.entryId));
            const selected = selectedIds.map((entryId, sortOrder) => {
              const entry = entryById.get(entryId);
              if (entry?.syncUid === undefined || !ownedEntryIds.has(entryId)) {
                throw new Error('Directory Entries must belong to this Author and have stable identities');
              }
              return { syncUid: entry.syncUid, sortOrder };
            });
            const selectedUids = new Set(selected.map((entry) => entry.syncUid));
            const next = directories.map((directory) => ({
              ...directory,
              entries: directory.entries.filter((entry) => !selectedUids.has(entry.syncUid)),
            }));
            const sortOrder = next.reduce((maximum, directory) => Math.max(maximum, directory.sortOrder), -1) + 1;
            next.push({
              syncUid: directoryUid,
              title: input.title.trim(),
              description: input.description ?? '',
              sortOrder,
              entries: selected,
            });
            return next.sort((left, right) => left.sortOrder - right.sortOrder || left.syncUid.localeCompare(right.syncUid));
          }, cause);
          const row = updated.payload.authorDirectories.find((directory) => directory.syncUid === directoryUid);
          const author = createOfflineLibrary(updated).getAuthor(authorId);
          const directory = row === undefined ? undefined : author.directories.find((item) => item.id === row.id);
          if (directory === undefined) throw new Error('Directory could not be added to the offline copy');
          return directory;
        };
        if (mode === 'offline') return enqueue();
        try {
          const result = await online.createAuthorDirectory(authorId, input);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueue(cause);
        }
      });
    },
    async updateAuthorDirectory(directoryId, input) {
      return diagnoseMutation('author-directories-set', AUTHOR_DIRECTORIES_CAPABILITY_KEY, async () => {
        if (Object.keys(input).length === 0) throw new Error('At least one author directory field is required');
        const enqueue = async (cause?: unknown) => {
          if (!hasOutbox(store)) throw cause ?? new Error('Offline Directory storage is unavailable');
          const active = await readActiveSnapshot(store);
          if (active === null) throw cause ?? new Error('Directory is unavailable in the offline copy');
          const pending = await store.list();
          const projected = snapshotWithOverlays(active.snapshot, pending);
          const row = projected.payload.authorDirectories.find((directory) => directory.id === directoryId);
          if (row?.syncUid === undefined) throw new Error('Directory is unavailable or missing stable identity; refresh while online');
          const updated = await enqueueAuthorDirectories(row.producerId, (directories) => directories.map((directory) => (
            directory.syncUid === row.syncUid
              ? {
                  ...directory,
                  ...(input.title === undefined ? {} : { title: input.title.trim() }),
                  ...(input.description === undefined ? {} : { description: input.description }),
                }
              : directory
          )), cause);
          const current = updated.payload.authorDirectories.find((directory) => directory.syncUid === row.syncUid);
          const author = createOfflineLibrary(updated).getAuthor(row.producerId);
          const directory = current === undefined ? undefined : author.directories.find((item) => item.id === current.id);
          if (directory === undefined) throw new Error('Directory could not be updated in the offline copy');
          return directory;
        };
        if (mode === 'offline') return enqueue();
        try {
          const result = await online.updateAuthorDirectory(directoryId, input);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueue(cause);
        }
      });
    },
    async moveEntryToAuthorDirectory(authorId, directoryId, entryId) {
      return diagnoseMutation('author-directories-set', AUTHOR_DIRECTORIES_CAPABILITY_KEY, async () => {
        const enqueue = async (cause?: unknown) => {
          const updated = await enqueueAuthorDirectories(authorId, (directories, snapshot) => {
            const directoryRow = snapshot.payload.authorDirectories.find((directory) => (
              directory.id === directoryId && directory.producerId === authorId
            ));
            const entry = snapshot.payload.entries.find((candidate) => candidate.id === entryId);
            const ownsEntry = snapshot.payload.entryProducers.some((relation) => (
              relation.producerId === authorId && relation.entryId === entryId
            ));
            if (directoryRow?.syncUid === undefined || entry?.syncUid === undefined || !ownsEntry) {
              throw new Error('Directory or Entry is unavailable in this offline Author copy');
            }
            const alreadyThere = directories.find((directory) => directory.syncUid === directoryRow.syncUid)
              ?.entries.some((member) => member.syncUid === entry.syncUid) === true;
            if (alreadyThere) return directories;
            const next = directories.map((directory) => ({
              ...directory,
              entries: directory.entries.filter((member) => member.syncUid !== entry.syncUid),
            }));
            const target = next.find((directory) => directory.syncUid === directoryRow.syncUid);
            if (target === undefined) throw new Error('Directory is unavailable in this offline copy');
            const sortOrder = target.entries.reduce((maximum, member) => Math.max(maximum, member.sortOrder), -1) + 1;
            target.entries.push({ syncUid: entry.syncUid, sortOrder });
            return next;
          }, cause);
          const row = updated.payload.authorDirectories.find((directory) => directory.id === directoryId);
          const author = createOfflineLibrary(updated).getAuthor(authorId);
          const directory = row === undefined ? undefined : author.directories.find((item) => item.id === row.id);
          if (directory === undefined) throw new Error('Directory membership could not be updated in the offline copy');
          return directory;
        };
        if (mode === 'offline') return enqueue();
        try {
          const result = await online.moveEntryToAuthorDirectory(authorId, directoryId, entryId);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueue(cause);
        }
      });
    },
    async removeEntryFromAuthorDirectory(authorId, directoryId, entryId) {
      return diagnoseMutation('author-directories-set', AUTHOR_DIRECTORIES_CAPABILITY_KEY, async () => {
        const enqueue = async (cause?: unknown) => {
          const updated = await enqueueAuthorDirectories(authorId, (directories, snapshot) => {
            const directoryRow = snapshot.payload.authorDirectories.find((directory) => (
              directory.id === directoryId && directory.producerId === authorId
            ));
            const entry = snapshot.payload.entries.find((candidate) => candidate.id === entryId);
            if (directoryRow?.syncUid === undefined || entry?.syncUid === undefined) {
              throw new Error('Directory or Entry is unavailable in this offline Author copy');
            }
            return directories.map((directory) => directory.syncUid === directoryRow.syncUid
              ? { ...directory, entries: directory.entries.filter((member) => member.syncUid !== entry.syncUid) }
              : directory);
          }, cause);
          const row = updated.payload.authorDirectories.find((directory) => directory.id === directoryId);
          const author = createOfflineLibrary(updated).getAuthor(authorId);
          const directory = row === undefined ? undefined : author.directories.find((item) => item.id === row.id);
          if (directory === undefined) throw new Error('Directory membership could not be updated in the offline copy');
          return directory;
        };
        if (mode === 'offline') return enqueue();
        try {
          const result = await online.removeEntryFromAuthorDirectory(authorId, directoryId, entryId);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueue(cause);
        }
      });
    },
    async createEntryContent(entryId, input) {
      return diagnoseMutation('contents-set', ENTRY_CONTENTS_CAPABILITY_KEY, async () => {
        const contentUid = randomUUID();
        const enqueue = async (cause?: unknown) => {
          const updated = await enqueueEntryContents(entryId, (contents) => {
            const nextSortOrder = contents.reduce((maximum, content) => Math.max(maximum, content.sortOrder), -1) + 1;
            return [...contents, {
              id: -1,
              entryId,
              syncUid: contentUid,
              syncVersion: 1,
              contentType: input.contentType.trim(),
              content: input.content,
              sortOrder: input.sortOrder ?? nextSortOrder,
            }];
          }, cause);
          const created = updated.find((content) => content.syncUid === contentUid);
          if (created === undefined) throw new Error('Entry Content could not be added to the offline copy');
          return toEntryContentRecord(created);
        };
        if (mode === 'offline' || await hasQueuedEntryContents(entryId)) return enqueue();
        try {
          const result = await online.createEntryContent(entryId, input);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueue(cause);
        }
      });
    },
    async updateEntryContent(contentId, input) {
      return diagnoseMutation('contents-set', ENTRY_CONTENTS_CAPABILITY_KEY, async () => {
        const enqueue = async (cause?: unknown) => {
          const existing = await getProjectedContent(contentId);
          if (existing === null) {
            throw cause ?? new Error('Entry Content is unavailable in the offline copy');
          }
          const updated = await enqueueEntryContents(existing.entryId, (contents) => contents.map((content) => (
            content.id === contentId
              ? {
                  ...content,
                  ...(input.contentType === undefined ? {} : { contentType: input.contentType.trim() }),
                  ...(input.content === undefined ? {} : { content: input.content }),
                }
              : content
          )), cause);
          const row = updated.find((content) => content.id === contentId);
          if (row === undefined) throw new Error('Entry Content could not be updated in the offline copy');
          return toEntryContentRecord(row);
        };
        const existing = await getProjectedContent(contentId);
        if (mode === 'offline' || (existing !== null && await hasQueuedEntryContents(existing.entryId))) {
          return enqueue();
        }
        try {
          const result = await online.updateEntryContent(contentId, input);
          setMode('online');
          return result;
        } catch (cause) {
          return enqueue(cause);
        }
      });
    },
    async deleteEntryContent(contentId) {
      return diagnoseMutation('contents-set', ENTRY_CONTENTS_CAPABILITY_KEY, async () => {
        const enqueue = async (cause?: unknown) => {
          const existing = await getProjectedContent(contentId);
          if (existing === null) throw cause ?? new Error('Entry Content is unavailable in the offline copy');
          await enqueueEntryContents(existing.entryId, (contents) => (
            contents.filter((content) => content.id !== contentId)
          ), cause);
        };
        const existing = await getProjectedContent(contentId);
        if (mode === 'offline' || (existing !== null && await hasQueuedEntryContents(existing.entryId))) {
          return enqueue();
        }
        try {
          await online.deleteEntryContent(contentId);
          setMode('online');
        } catch (cause) {
          return enqueue(cause);
        }
      });
    },
    async reorderEntryContents(entryId, orderedContentIds) {
      return diagnoseMutation('contents-set', ENTRY_CONTENTS_CAPABILITY_KEY, async () => {
        const enqueue = async (cause?: unknown) => enqueueEntryContents(entryId, (contents) => {
          if (orderedContentIds.length !== contents.length
            || new Set(orderedContentIds).size !== contents.length) {
            throw new Error('Entry Content order must contain every current item exactly once');
          }
          const byId = new Map(contents.map((content) => [content.id, content]));
          const reordered = orderedContentIds.map((id, sortOrder) => {
            const content = byId.get(id);
            if (content === undefined) throw new Error('Entry Content order does not match this offline copy');
            return { ...content, sortOrder };
          });
          return reordered;
        }, cause);
        if (mode === 'offline' || await hasQueuedEntryContents(entryId)) {
          await enqueue();
          return;
        }
        try {
          await online.reorderEntryContents(entryId, orderedContentIds);
          setMode('online');
        } catch (cause) {
          await enqueue(cause);
        }
      });
    },
    async mergeViewLaterEntries(entryIds) {
      if (mode !== 'offline') {
        try {
          const result = await online.mergeViewLaterEntries(entryIds);
          setMode('online');
          return result;
        } catch (cause) {
          if (!isOfflineTransportError(cause)) throw cause;
          setMode('offline');
          if (options.state !== undefined) options.state.lastFallbackAt = new Date().toISOString();
        }
      }
      let state = await withFallback(
        () => online.getViewLaterState(),
        (library) => library.getViewLaterState(),
      );
      for (const entryId of [...new Set(entryIds)]) {
        state = await enqueueEntryViewLater(entryId, true);
      }
      return state;
    },
    getViewLaterState() {
      return withFallback(() => online.getViewLaterState(), (library) => library.getViewLaterState());
    },
    listGalleries() {
      return withFallback(() => online.listGalleries(), (library) => library.listGalleries());
    },
    queryEntryPage(input) {
      return withFallback(() => online.queryEntryPage(input), (library) => library.queryEntryPage(input));
    },
    listFacetFilterOptions(entryType, authorId) {
      return withFallback(
        () => online.listFacetFilterOptions(entryType, authorId),
        (library) => library.listFacetFilterOptions(entryType, authorId),
      );
    },
    getEntry(entryId) {
      return withFallback(async () => {
        const remote = await online.getEntry(entryId);
        const operations = await listOperations();
        const stagedLayout = operations.some(row => row.operationKind === 'entry.facet.create' && row.payload.entryType === remote.type);
        const queuedTags = await hasQueuedEntryTags(entryId);
        if (!stagedLayout && !queuedTags) return remote;
        const library = await loadOfflineLibrary();
        if (!library) return remote;
        const local = library.getEntry(entryId);
        return { ...remote, sections: remote.sections.map(section => {
          const projected = local.sections.find(row => row.id === section.id);
          if (!projected) return section;
          return { ...section, facets: [
            ...section.facets.map(facet => ({ ...facet, ...(queuedTags ? { tags: projected.facets.find(row => row.id === facet.id)?.tags ?? [] } : {}) })),
            ...projected.facets.filter(facet => facet.id < 0 && !section.facets.some(row => row.id === facet.id)),
          ] };
        }) };
      }, (library) => library.getEntry(entryId));
    },
    listCollections(kind, includeNsfw) {
      return withFallback(
        () => online.listCollections(kind, includeNsfw),
        (library) => library.listCollections(kind, includeNsfw),
      );
    },
    listCollectionsForEntry(entryId) {
      return withFallback(
        () => online.listCollectionsForEntry(entryId),
        (library) => library.listCollectionsForEntry(entryId),
      );
    },
    listAuthors() {
      return withFallback(() => online.listAuthors(), (library) => library.listAuthors());
    },
    async suggestProducers(input, signal) {
      const query = producerSuggestionQuerySchema.parse(input);
      const suggestions = await withFallback(() => online.suggestProducers(input, signal), (library) => library.suggestProducers(query));
      // Recovery changes transport, not the identity of Authors still in the Outbox.
      if (isOnlineMode() && hasOutbox(store) && await store.readMeta('capability.offlineCrossEntryPendingAuthors') === '1') {
        const library = await loadOfflineLibrary();
        const staged = library?.suggestProducers(query).filter(row => row.id < 0) ?? [];
        return [...suggestions, ...staged.filter(row => !suggestions.some(existing => existing.id === row.id))].slice(0, 20);
      }
      return suggestions;
    },
    suggestTags(input, signal) {
      return withFallback(() => online.suggestTags(input, signal), (library) => (
        library.suggestTags(tagSuggestionQuerySchema.parse(input))
      ));
    },
    queryProducerPage(input) {
      return withFallback(() => online.queryProducerPage(input), (library) => library.queryProducerPage(input));
    },
    getAuthor(authorId) {
      return withFallback(() => online.getAuthor(authorId), (library) => library.getAuthor(authorId));
    },
    listAuthorFilterOptions(entryType, includeNsfw) {
      return withFallback(
        () => online.listAuthorFilterOptions(entryType, includeNsfw),
        (library) => library.listAuthorFilterOptions(entryType, includeNsfw),
      );
    },
    searchTags(query, includeNsfw) {
      return withFallback(() => online.searchTags(query, includeNsfw), (library) => library.searchTags(query, includeNsfw));
    },
    listGalleryTags(entryType) {
      return withFallback(() => online.listGalleryTags(entryType), (library) => library.listGalleryTags(entryType));
    },
    listCollectionsForProducer(producerId) {
      return withFallback(
        () => online.listCollectionsForProducer(producerId),
        (library) => library.listCollectionsForProducer(producerId),
      );
    },
    listTaxonomyAliases(vocabulary) {
      return withFallback(
        () => online.listTaxonomyAliases(vocabulary),
        (library) => library.listTaxonomyAliases(vocabulary),
      );
    },
  };
  // The synchronous methods build URLs from values already in memory — there is no service call to
  // wait for, and wrapping one makes it return a Promise, which an `<img :src>` renders as
  // `[object Promise]` (measured on 2026-10-04: the review's cover, served through
  // `siteprobeExportFileUrl`, read exactly that in the DOM). All *service* calls wait for the same
  // durable identity before enqueue, restore, projection or replay.
  const synchronous = new Set(['assetUrl', 'siteprobeExportFileUrl']);
  for (const key of Object.keys(facade)) {
    if (synchronous.has(key)) continue;
    const method = Reflect.get(facade, key) as unknown;
    if (typeof method === 'function') Reflect.set(facade, key, async (...args: unknown[]) => {
      await ensureClientIdentity();
      return Reflect.apply(method, facade, args) as unknown;
    });
  }
  collectionReconciliationListeners.set(facade, reconciliationListeners);
  return facade;
}
