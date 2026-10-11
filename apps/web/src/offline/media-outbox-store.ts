import { operationFingerprint, type PendingSyncOperation } from './outbox-store.js';

export type StagedMediaStatus = 'pending' | 'failed';

export interface StagedMediaUpload {
  uploadId: string;
  libraryId: string;
  syncEpoch: string;
  entryUid: string;
  existingEntry?: { expectedCoverRef: string | null; expectedPreviewRefs: string[] } | undefined;
  replace?: boolean | undefined;
  kind: 'cover' | 'preview';
  ordinal: number;
  mimeType: 'image/avif' | 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  byteLength: number;
  sha256: string;
  blob: Blob;
  status: StagedMediaStatus;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface ExistingMediaGuard { snapshot: string; media: string; revision: string; operations: string }
export interface MediaOutboxStore {
  cancelExistingEntryPreviews?(entryUid: string, retainedIds: string[], guard: ExistingMediaGuard): Promise<void>;
  enqueueExistingEntryMedia?(upload: StagedMediaUpload, guard: ExistingMediaGuard): Promise<void>;
  enqueueEntryCreate(
    operation: PendingSyncOperation,
    media: StagedMediaUpload[],
  ): Promise<void>;
  listMedia(): Promise<StagedMediaUpload[]>;
  updateMedia(
    uploadId: string,
    patch: Partial<Pick<StagedMediaUpload, 'status' | 'lastAttemptAt' | 'lastError'>>,
  ): Promise<void>;
  removeMedia(uploadId: string): Promise<void>;
}

export function mediaQueueIdentity(rows: StagedMediaUpload[]): string {
  return JSON.stringify([...rows].sort((a,b) => a.uploadId.localeCompare(b.uploadId)).map(row => [
    row.uploadId,row.libraryId,row.syncEpoch,row.entryUid,row.kind,row.ordinal,row.mimeType,row.byteLength,row.sha256,
    row.existingEntry === undefined ? null : [row.existingEntry.expectedCoverRef,row.existingEntry.expectedPreviewRefs],
    row.status,row.lastAttemptAt,row.lastError,
  ]));
}

export function operationQueueIdentity(rows: PendingSyncOperation[]): string {
  return JSON.stringify(rows.map(row => [operationFingerprint(row),row.status,row.lastAttemptAt,row.lastError]));
}

export function validateExistingMediaStage(raw: unknown, revision: unknown, rows: StagedMediaUpload[], upload: StagedMediaUpload, guard: ExistingMediaGuard, capability: unknown, operations: PendingSyncOperation[]): void {
  if (operationQueueIdentity(operations) !== guard.operations) throw new Error('Pending operation queue changed; review the Entry and try again');
  if (capability !== '1' || raw !== guard.snapshot || (revision ?? '0') !== guard.revision || mediaQueueIdentity(rows) !== guard.media) throw new Error('Offline copy or pending media changed; try again');
  const snapshot = JSON.parse(String(raw)) as import('@t3/shared').SyncSnapshot;
  const owner = snapshot.payload.entries.find(row => row.syncUid === upload.entryUid);
  if (!owner || upload.libraryId !== snapshot.header.libraryId || upload.syncEpoch !== snapshot.header.syncEpoch || !upload.existingEntry || rows.some(row => row.uploadId === upload.uploadId)) throw new Error('Existing Entry media identity is unavailable');
}

function cloneMedia(value: StagedMediaUpload): StagedMediaUpload {
  return structuredClone(value);
}

export function createMemoryMediaOutboxStore(
  enqueueOperation: (operation: PendingSyncOperation) => Promise<unknown>,
): MediaOutboxStore {
  const media = new Map<string, StagedMediaUpload>();
  return {
    async enqueueEntryCreate(operation, uploads) {
      // Memory tests cannot offer a real multi-store transaction. Validate every
      // media key first, then enqueue the operation before publishing media.
      for (const upload of uploads) {
        if (media.has(upload.uploadId)) throw new Error('Media upload ID already exists');
      }
      await enqueueOperation(operation);
      for (const upload of uploads) media.set(upload.uploadId, cloneMedia(upload));
    },
    async listMedia() {
      return [...media.values()].map(cloneMedia);
    },
    async updateMedia(uploadId, patch) {
      const existing = media.get(uploadId);
      if (existing !== undefined) media.set(uploadId, cloneMedia({ ...existing, ...patch }));
    },
    async removeMedia(uploadId) {
      media.delete(uploadId);
    },
  };
}
