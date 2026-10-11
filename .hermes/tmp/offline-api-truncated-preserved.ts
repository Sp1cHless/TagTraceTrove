import {
  normalizeTag,
  producerSuggestionQuerySchema,
  tagSuggestionQuerySchema,
  COLLECTION_ORDER_SCOPE_UIDS,
  entryContentRecordSchema,
  syncReplayOperationSchema,
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
  nativeTransfers?: { handoff(): Promise<void>; pause(opIds?: string[]): Promise<void>; reconcile(): Promise<unknown>; resume?(): Promise<{active:number;completed:number;held:number;remainingOperations:number;standaloneMedia?:number;foregroundMedia?:number;dependencyHeld?:number;capabilityHeld?:number;foregroundReason?:string}> };
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
    entry.coverRef = operation.payload.refs[0] ?? null;
    entry.previewRefs = operation.payload.refs.slice(1);
    entry.previewRef = operation.payload.refs[1] ?? null;
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
      const projected = snapshotWithOverlays(active.snapshot, operations.filter(row => row.clientId === clientId && row.libraryId === active.snapshot.header.libraryId && row.syncEpoch === active.snapshot.header.syncEpoch));
      // A queued create's staged cover is shown from its own bytes: the work
      // is visible with its picture the moment it is created offline, instead
      // of waiting for the replay to move the file onto the server.
      const liveUploadIds = new Set(media.map(row => row.uploadId));
      for (const [id, ref] of stagedObjectUrls) {
        if (!liveUploadIds.has(id)) { URL.revokeObjectURL(ref.split('#')[0]!); stagedObjectUrls.delete(id); }
      }
      for (const row of [...media].sort((a, b) => a.kind === b.kind ? a.ordinal - b.ordinal : a.kind === 'cover' ? -1 : 1)) {
        if (row.libraryId !== active.snapshot.header.libraryId || row.syncEpoch !== active.snapshot.header.syncEpoch) continue;
        const entry = projected.payload.entries.find(entry => entry.syncUid === row.entryUid);
        if (!entry) continue;
        // A snapshot may already contain a committed upload while its ACK is
        // uncertain. Do not project that durable row a second time.
        const existingRefs = [entry.coverRef, ...entry.previewRefs];
        if (existingRefs.some(ref => ref?.includes(`.${row.uploadId}.`))) continue;
        let ref = stagedObjectUrls.get(row.uploadId);
        if (!ref) { ref = `${URL.createObjectURL(row.blob)}#t3-upload=${row.uploadId}`; stagedObjectUrls.set(row.uploadId, ref); }
        if (row.kind === 'cover') { if (entry.coverRef === null) entry.coverRef = ref; }
        else { entry.previewRefs.push(ref); entry.previewRef = entry.previewRefs[0] ?? null; }
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
