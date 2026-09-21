import {
  syncReplayOperationSchema,
  type EntryRecordDto,
  type RatingRow,
  type SyncReplayOperation,
  type SyncSnapshot,
  type UpdateEntryRequest,
  type UsageInfo,
  type ViewLaterState,
} from '@t3/shared';
import type {
  GalleryApi,
  OfflineEntryCreateRequest,
  PendingOfflineEntryCreate,
} from '../api/gallery.js';
import { ApiError } from '../api/client.js';
import { isOfflineTransportError } from '../api/transport-error.js';
import { createOfflineLibrary, type OfflineLibrary } from './offline-library.js';
import type { MediaOutboxStore, StagedMediaUpload } from './media-outbox-store.js';
import {
  createPendingSyncOperation,
  operationFingerprint,
  type OutboxStore,
  type PendingSyncOperation,
} from './outbox-store.js';
import { randomUuid } from './random-id.js';
import {
  ACTIVE_GENERATION_KEY,
  applySnapshot,
  readActiveSnapshot,
  type SnapshotStore,
} from './snapshot-store.js';

/** Online remains authoritative. Read calls may fall back to a verified snapshot.
 * Offline mutation allowlist: Entry basic-field update and staged manual Entry create. */
export interface OfflineMutationDiagnostic {
  at: string;
  action: 'view' | 'like' | 'view-later-add' | 'view-later-remove' | 'rating-set';
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
    error: string | null;
  } | null;
  lastSuccessfulCapabilityProbe?: {
    at: string;
    serverBuild: string;
    offlineUsageEvents: boolean;
    offlineEntryViewLater: boolean;
    offlineEntryRating: boolean;
  } | null;
  lastMutationDiagnostic?: OfflineMutationDiagnostic | null;
  mutationDiagnostics?: OfflineMutationDiagnostic[];
}

export type OfflineStore = SnapshotStore & Partial<OutboxStore> & Partial<MediaOutboxStore>;

interface OfflineApiOptions {
  state?: OfflineApiState;
  randomUUID?: () => string;
  clientId?: string;
}

const CLIENT_ID_KEY = 't3.offline-client-id';
const ENTRY_CREATE_CAPABILITY_KEY = 'capability.offlineEntryCreate';
const MEDIA_UPLOAD_CAPABILITY_KEY = 'capability.offlineMediaUpload';
const USAGE_EVENTS_CAPABILITY_KEY = 'capability.offlineUsageEvents';
const ENTRY_VIEW_LATER_CAPABILITY_KEY = 'capability.offlineEntryViewLater';
const ENTRY_RATING_CAPABILITY_KEY = 'capability.offlineEntryRating';
const MAX_STAGED_MEDIA_BYTES = 20 * 1024 * 1024;
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

function defaultClientId(randomUUID: () => string): string {
  try {
    const existing = globalThis.localStorage?.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const created = randomUUID();
    globalThis.localStorage?.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch {
    return randomUUID();
  }
}

function transportOperation(operation: PendingSyncOperation): SyncReplayOperation {
  return syncReplayOperationSchema.parse({
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
  });
}

function parsedEntryOperations(operations: PendingSyncOperation[]): SyncReplayOperation[] {
  return operations.flatMap((operation) => {
    try {
      return [transportOperation(operation)];
    } catch {
      return [];
    }
  });
}

type EntryUpdateOperation = Extract<SyncReplayOperation, { operationKind: 'entry.update' }>;
type EntryUsageOperation = Extract<SyncReplayOperation, { operationKind: 'entry.usage' }>;
type EntryViewLaterOperation = Extract<SyncReplayOperation, { operationKind: 'entry.view-later.set' }>;
type EntryRatingOperation = Extract<SyncReplayOperation, { operationKind: 'entry.rating.set' }>;

function isEntryUpdateOperation(
  operation: SyncReplayOperation,
): operation is EntryUpdateOperation {
  return operation.operationKind === 'entry.update';
}

function isEntryUsageOperation(
  operation: SyncReplayOperation,
): operation is EntryUsageOperation {
  return operation.operationKind === 'entry.usage';
}

function isEntryViewLaterOperation(
  operation: SyncReplayOperation,
): operation is EntryViewLaterOperation {
  return operation.operationKind === 'entry.view-later.set';
}

function isEntryRatingOperation(
  operation: SyncReplayOperation,
): operation is EntryRatingOperation {
  return operation.operationKind === 'entry.rating.set';
}

function advancesEntryVersion(operation: SyncReplayOperation): boolean {
  return operation.operationKind === 'entry.update'
    || operation.operationKind === 'entry.usage'
    || operation.operationKind === 'entry.view-later.set'
    || operation.operationKind === 'entry.rating.set';
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

function snapshotWithOverlays(
  snapshot: SyncSnapshot,
  operations: PendingSyncOperation[],
): SyncSnapshot {
  const parsed = parsedEntryOperations(operations);
  const entryOperations = parsed.filter(isEntryUpdateOperation);
  const usageOperations = parsed.filter(isEntryUsageOperation);
  const viewLaterOperations = parsed.filter(isEntryViewLaterOperation);
  const ratingOperations = parsed.filter(isEntryRatingOperation);
  if (entryOperations.length === 0
    && usageOperations.length === 0
    && viewLaterOperations.length === 0
    && ratingOperations.length === 0) return snapshot;

  const entries = snapshot.payload.entries.map((entry) => {
    const patches = entryOperations.filter((operation) => operation.entityUid === entry.syncUid);
    return patches.reduce((current, operation) => applyEntryPatch(current, operation.payload), entry);
  });
  const entryIdsByUid = new Map(entries.map((entry) => [entry.syncUid, entry.id]));
  const usageByEntryId = new Map(snapshot.payload.entryUsage.map((usage) => [
    usage.entryId,
    { ...usage },
  ]));
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
  const entryRatingValues = snapshot.payload.entryRatingValues.map((value) => ({ ...value }));
  const ratingSlotIdsByUid = new Map(snapshot.payload.ratingSlots.flatMap((slot) => (
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

  return {
    ...snapshot,
    payload: {
      ...snapshot.payload,
      entries,
      entryUsage: [...usageByEntryId.values()].sort((left, right) => left.entryId - right.entryId),
      viewLaterEntries,
      entryRatingValues,
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

export function createOfflineAwareGalleryApi(
  online: GalleryApi,
  store: OfflineStore,
  options: OfflineApiOptions = {},
): GalleryApi {
  let mode: OfflineApiState['mode'] = options.state?.mode ?? 'online';
  let cachedLibraryKey: string | null = null;
  let cachedLibrary: OfflineLibrary | null = null;
  let replayPromise: Promise<void> | null = null;
  const randomUUID = options.randomUUID ?? randomUuid;
  const clientId = options.clientId ?? defaultClientId(randomUUID);

  function setMode(nextMode: OfflineApiState['mode']): void {
    mode = nextMode;
    if (options.state !== undefined) options.state.mode = nextMode;
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
  }

  async function listOperations(): Promise<PendingSyncOperation[]> {
    return hasOutbox(store) ? store.list() : [];
  }

  async function loadOfflineLibrary(): Promise<OfflineLibrary | null> {
    const generationId = await store.readMeta(ACTIVE_GENERATION_KEY);
    if (generationId === null) return null;
    const operations = await listOperations();
    const key = `${generationId}:${operations.map(operationFingerprint).join('|')}`;
    if (cachedLibrary !== null && cachedLibraryKey === key) return cachedLibrary;
    const active = await readActiveSnapshot(store);
    if (active === null) return null;
    cachedLibraryKey = key;
    cachedLibrary = createOfflineLibrary(snapshotWithOverlays(active.snapshot, operations));
    return cachedLibrary;
  }

  async function withFallback<T>(
    onlineCall: () => Promise<T>,
    offlineCall: (library: OfflineLibrary) => T,
  ): Promise<T> {
    if (mode === 'offline') {
      try {
        const library = await loadOfflineLibrary();
        if (library !== null) return offlineCall(library);
      } catch {
        // IndexedDB can be transiently unavailable; retry the authoritative API.
      }
      setMode('online');
    }
    try {
      const result = await onlineCall();
      setMode('online');
      return result;
    } catch (onlineError) {
      if (!isOfflineTransportError(onlineError)) throw onlineError;
      let library;
      try {
        library = await loadOfflineLibrary();
      } catch {
        throw onlineError;
      }
      if (library === null) throw onlineError;
      setMode('offline');
      if (options.state !== undefined) options.state.lastFallbackAt = new Date().toISOString();
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
    const versionAdvances = parsed.filter((operation) => (
      operation.entityUid === original.syncUid && advancesEntryVersion(operation)
    )).length;
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
    await store.enqueue(normalized);
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
    await store.enqueue(normalized);
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
    const versionAdvances = parsed.filter((operation) => (
      operation.entityUid === original.syncUid && advancesEntryVersion(operation)
    )).length;
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
    await store.enqueue(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
    return viewLaterStateFromSnapshot(snapshotWithOverlays(active.snapshot, pending));
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
    const slot = active.snapshot.payload.ratingSlots.find((candidate) => (
      candidate.id === slotId
      && candidate.subjectKind === 'entry'
      && candidate.entryType === original.type
    ));
    if (slot?.syncUid === undefined) {
      throw new Error('Rating slot is unavailable in this offline copy; update it while online');
    }

    const operations = await store.list();
    const parsed = parsedEntryOperations(operations);
    const projectedBefore = snapshotWithOverlays(active.snapshot, operations);
    const currentStars = projectedBefore.payload.entryRatingValues.find((value) => (
      value.entryId === entryId && value.slotId === slotId
    ))?.stars ?? null;
    if (currentStars === desiredStars) {
      return { slotId, name: slot.name, stars: desiredStars };
    }
    const versionAdvances = parsed.filter((operation) => (
      operation.entityUid === original.syncUid && advancesEntryVersion(operation)
    )).length;
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
    await store.enqueue(normalized);
    const pending = [...operations, normalized];
    setReplayStateFromOperations(pending);
    invalidateOfflineLibrary();
    setMode('offline');
    return { slotId, name: slot.name, stars: desiredStars };
  }

  async function enqueueOfflineEntryCreate(
    input: OfflineEntryCreateRequest,
    transportError?: unknown,
  ): Promise<{ localKey: string }> {
    if (transportError !== undefined && !isOfflineTransportError(transportError)) throw transportError;
    if (!hasMediaOutbox(store)) throw new Error('Offline create storage is unavailable');
    const active = await readActiveSnapshot(store);
    if (active === null) throw new Error('Download an offline copy before creating Entries offline');
    if (await store.readMeta(ENTRY_CREATE_CAPABILITY_KEY) !== '1') {
      throw new Error('This offline copy has not enabled offline Entry creation; update it while online');
    }
    const title = input.title.trim();
    const type = input.type.trim();
    if (title.length === 0 || type.length === 0) throw new Error('Title and Gallery are required');
    if (!active.snapshot.payload.entries.some((entry) => entry.type === type)) {
      throw new Error('Offline creation can only use an existing Gallery from this offline copy');
    }
    const files = [
      ...(input.coverFile === null ? [] : [{ kind: 'cover' as const, file: input.coverFile }]),
      ...(input.previewFile === null ? [] : [{ kind: 'preview' as const, file: input.previewFile }]),
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
    const entityUid = randomUUID();
    const operation = createPendingSyncOperation({
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
        ratings: [...input.ratings].sort((left, right) => left.slotId - right.slotId),
        viewLater: input.viewLater,
      },
    }, { randomUUID });
    const normalized = {
      ...operation,
      ...transportOperation(operation),
    } as PendingSyncOperation;
    const media: StagedMediaUpload[] = [];
    for (const { kind, file } of files) {
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
        ordinal: 0,
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
    await setReplayStateFromStore();
    invalidateOfflineLibrary();
    setMode('offline');
    return { localKey: `local:${entityUid}` };
  }

  async function listPendingOfflineEntryCreates(): Promise<PendingOfflineEntryCreate[]> {
    if (!hasOutbox(store)) return [];
    return (await store.list()).flatMap((stored) => {
      try {
        const operation = transportOperation(stored);
        if (operation.operationKind !== 'entry.create') return [];
        return [{
          localKey: `local:${operation.entityUid}` as const,
          title: operation.payload.title,
          type: operation.payload.type,
          uploadDate: operation.payload.uploadDate,
          pageCount: operation.payload.pageCount,
          status: stored.status,
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
      const operations = await store.list();
      const mediaBeforeReplay = hasMediaOutbox(store) ? await store.listMedia() : [];
      await setReplayStateFromStore();
      if (operations.length === 0 && mediaBeforeReplay.length === 0) return;
      const activeBeforeReplay = await readActiveSnapshot(store);
      const appliedOperations: SyncReplayOperation[] = [];
      const appliedMedia: StagedMediaUpload[] = [];
      let maxAppliedServerSeq = -1;
      const blockedEntities = new Set<string>();
      let replayError: string | null = null;
      let attemptedOpId: string | null = null;
      let attemptedUploadId: string | null = null;
      try {
        for (const stored of operations) {
          const entityKey = `${stored.entityKind}:${stored.entityUid}`;
          if (stored.status !== 'pending') {
            blockedEntities.add(entityKey);
            replayError ??= stored.lastError;
            continue;
          }
          if (blockedEntities.has(entityKey)) continue;
          let operation: SyncReplayOperation;
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
          attemptedOpId = stored.opId;
          await store.update(stored.opId, {
            lastAttemptAt: new Date().toISOString(),
            lastError: null,
          });
          const result = await online.replaySyncOperation(operation);
          if (result.status === 'applied') {
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
          blockedEntities.add(entityKey);
          attemptedOpId = null;
        }

        if (hasMediaOutbox(store) && online.uploadSyncMedia !== undefined) {
          const readyEntryUids = new Set(
            activeBeforeReplay?.snapshot.payload.entries.map((entry) => entry.syncUid) ?? [],
          );
          for (const operation of appliedOperations) {
            if (operation.operationKind === 'entry.create') readyEntryUids.add(operation.entityUid);
          }
          for (const upload of mediaBeforeReplay) {
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
              }, upload.blob);
              appliedMedia.push(upload);
              maxAppliedServerSeq = Math.max(maxAppliedServerSeq, result.serverSeq);
              attemptedUploadId = null;
            } catch (cause) {
              if (cause instanceof ApiError && [400, 404, 409].includes(cause.status)) {
                replayError = cause.message;
                await store.updateMedia(upload.uploadId, { status: 'failed', lastError: replayError });
                attemptedUploadId = null;
                continue;
              }
              throw cause;
            }
          }
        }

        if (appliedOperations.length > 0 || appliedMedia.length > 0) {
          const first = appliedOperations[0];
          const snapshot = await online.fetchSyncSnapshot();
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
          const applied = await applySnapshot(snapshot, {
            store,
            currentLibraryId,
            currentSyncEpoch,
            ...(activeBeforeReplay === null
              ? {}
              : { currentSnapshotSeq: activeBeforeReplay.snapshot.header.snapshotSeq }),
          });
          if (!applied.ok) throw new Error(`Snapshot refresh failed: ${applied.failure.reason}`);
          for (const operation of appliedOperations) await store.remove(operation.opId);
          if (hasMediaOutbox(store)) {
            for (const upload of appliedMedia) await store.removeMedia(upload.uploadId);
          }
          invalidateOfflineLibrary();
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
    const firstBlockedIndexByEntity = new Map<string, number>();
    operations.forEach((operation, index) => {
      if (operation.status !== 'conflict' && operation.status !== 'failed') return;
      if (!firstBlockedIndexByEntity.has(operation.entityUid)) {
        firstBlockedIndexByEntity.set(operation.entityUid, index);
      }
    });
    const discarded = operations.filter((operation, index) => {
      const blockedIndex = firstBlockedIndexByEntity.get(operation.entityUid);
      return blockedIndex !== undefined && index >= blockedIndex;
    });
    const discardedCreateEntityUids = new Set(discarded
      .filter((operation) => operation.operationKind === 'entry.create')
      .map((operation) => operation.entityUid));
    await store.removeMany(discarded.map((operation) => operation.opId));
    if (hasMediaOutbox(store)) {
      const media = await store.listMedia();
      await Promise.all(media
        .filter((upload) => upload.status === 'failed' || discardedCreateEntityUids.has(upload.entryUid))
        .map((upload) => store.removeMedia(upload.uploadId)));
    }
    invalidateOfflineLibrary();
    await setReplayStateFromStore();
  }

  void setReplayStateFromStore().catch(() => undefined);

  return {
    ...online,
    async getSyncCapabilities() {
      try {
        const result = await online.getSyncCapabilities();
        await Promise.all([
          store.writeMeta(
            ENTRY_CREATE_CAPABILITY_KEY,
            result.featureFlags?.offlineEntryCreate === true ? '1' : '0',
          ),
          store.writeMeta(
            MEDIA_UPLOAD_CAPABILITY_KEY,
            result.featureFlags?.offlineMediaUpload === true ? '1' : '0',
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
        ]);
        if (options.state !== undefined) {
          const at = new Date().toISOString();
          const offlineUsageEvents = result.featureFlags?.offlineUsageEvents === true;
          const offlineEntryViewLater = result.featureFlags?.offlineEntryViewLater === true;
          const offlineEntryRating = result.featureFlags?.offlineEntryRating === true;
          options.state.lastCapabilityProbe = {
            at,
            status: 'success',
            serverBuild: result.serverBuild,
            offlineUsageEvents,
            offlineEntryViewLater,
            offlineEntryRating,
            error: null,
          };
          options.state.lastSuccessfulCapabilityProbe = {
            at,
            serverBuild: result.serverBuild,
            offlineUsageEvents,
            offlineEntryViewLater,
            offlineEntryRating,
          };
        }
        setMode('online');
        await replayPendingOperations();
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
            error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
          };
        }
        throw cause;
      }
    },
    async fetchSyncSnapshot() {
      const result = await online.fetchSyncSnapshot();
      setMode('online');
      return result;
    },
    flushOfflineOutbox: replayPendingOperations,
    enqueueOfflineEntryCreate,
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
      return withFallback(() => online.getEntry(entryId), (library) => library.getEntry(entryId));
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
}
