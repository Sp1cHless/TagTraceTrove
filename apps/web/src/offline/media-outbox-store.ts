import type { PendingSyncOperation } from './outbox-store.js';

export type StagedMediaStatus = 'pending' | 'failed';

export interface StagedMediaUpload {
  uploadId: string;
  libraryId: string;
  syncEpoch: string;
  entryUid: string;
  kind: 'cover' | 'preview';
  ordinal: 0;
  mimeType: 'image/avif' | 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
  byteLength: number;
  sha256: string;
  blob: Blob;
  status: StagedMediaStatus;
  lastAttemptAt: string | null;
  lastError: string | null;
}

export interface MediaOutboxStore {
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
