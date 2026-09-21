import type { SnapshotStore } from './snapshot-store.js';
import {
  operationFingerprint,
  type OutboxStore,
  type PendingSyncOperation,
} from './outbox-store.js';
import type { MediaOutboxStore, StagedMediaUpload } from './media-outbox-store.js';

const DATABASE_VERSION = 3;
const GENERATIONS_STORE = 'snapshotGenerations';
const META_STORE = 'meta';
const OUTBOX_STORE = 'outbox';
const MEDIA_OUTBOX_STORE = 'mediaOutbox';
const OUTBOX_OPERATION_ID_INDEX = 'opId';

export const DEFAULT_OFFLINE_DATABASE_NAME = 't3-offline';

export interface IndexedDbOfflineStore extends SnapshotStore, OutboxStore, MediaOutboxStore {
  close(): void;
}

export interface IndexedDbOfflineStoreOptions {
  indexedDB?: IDBFactory;
  databaseName?: string;
}

/**
 * Browser-backed offline storage. Snapshot generations and the durable Outbox
 * use separate object stores, so snapshot pruning cannot delete queued intent.
 */
export function createIndexedDbOfflineStore(
  options: IndexedDbOfflineStoreOptions = {},
): IndexedDbOfflineStore {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (factory === undefined) throw new Error('IndexedDB is unavailable');
  const databaseName = options.databaseName ?? DEFAULT_OFFLINE_DATABASE_NAME;
  let databasePromise: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    if (databasePromise !== null) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = factory.open(databaseName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(GENERATIONS_STORE)) {
          database.createObjectStore(GENERATIONS_STORE);
        }
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE);
        }
        if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
          const outbox = database.createObjectStore(OUTBOX_STORE, {
            keyPath: 'sequence',
            autoIncrement: true,
          });
          outbox.createIndex(OUTBOX_OPERATION_ID_INDEX, 'opId', { unique: true });
        }
        if (!database.objectStoreNames.contains(MEDIA_OUTBOX_STORE)) {
          const media = database.createObjectStore(MEDIA_OUTBOX_STORE, { keyPath: 'uploadId' });
          media.createIndex('entryUid', 'entryUid', { unique: false });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => {
        databasePromise = null;
        reject(request.error ?? new Error('Failed to open offline storage'));
      };
      request.onblocked = () => {
        databasePromise = null;
        reject(new Error('Offline storage upgrade is blocked by another T3 tab'));
      };
    });
    return databasePromise;
  }

  async function transact<T>(
    storeName: typeof GENERATIONS_STORE | typeof META_STORE | typeof OUTBOX_STORE | typeof MEDIA_OUTBOX_STORE,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      let value: T;
      request.onsuccess = () => {
        value = request.result;
      };
      request.onerror = () => reject(request.error ?? new Error('Offline storage request failed'));
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error ?? new Error('Offline storage transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Offline storage transaction aborted'));
    });
  }

  return {
    async listGenerationIds() {
      const keys = await transact(GENERATIONS_STORE, 'readonly', (store) => store.getAllKeys());
      return keys
        .filter((key): key is number => typeof key === 'number' && Number.isInteger(key) && key > 0)
        .sort((left, right) => left - right);
    },
    async writeGeneration(generationId, value) {
      await transact(GENERATIONS_STORE, 'readwrite', (store) => store.put(value, generationId));
    },
    async readGeneration(generationId) {
      const value = await transact(GENERATIONS_STORE, 'readonly', (store) => store.get(generationId));
      return typeof value === 'string' ? value : null;
    },
    async deleteGeneration(generationId) {
      await transact(GENERATIONS_STORE, 'readwrite', (store) => store.delete(generationId));
    },
    async readMeta(key) {
      const value = await transact(META_STORE, 'readonly', (store) => store.get(key));
      return typeof value === 'string' ? value : null;
    },
    async writeMeta(key, value) {
      await transact(META_STORE, 'readwrite', (store) => store.put(value, key));
    },
    async enqueue(operation) {
      const database = await open();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(OUTBOX_STORE, 'readwrite');
        const store = transaction.objectStore(OUTBOX_STORE);
        const fingerprint = operationFingerprint(operation);
        const lookup = store.index(OUTBOX_OPERATION_ID_INDEX).get(operation.opId);
        let result: 'queued' | 'duplicate' = 'queued';
        let explicitError: Error | null = null;
        lookup.onsuccess = () => {
          const existing = lookup.result as { fingerprint?: unknown } | undefined;
          if (existing !== undefined) {
            if (existing.fingerprint !== fingerprint) {
              explicitError = new Error('Outbox operation ID already exists with different content');
              transaction.abort();
              return;
            }
            result = 'duplicate';
            return;
          }
          store.add({ opId: operation.opId, fingerprint, operation });
        };
        lookup.onerror = () => reject(lookup.error ?? new Error('Outbox lookup failed'));
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error ?? new Error('Outbox transaction failed'));
        transaction.onabort = () => reject(explicitError ?? transaction.error ?? new Error('Outbox transaction aborted'));
      });
    },
    async enqueueEntryCreate(operation, media) {
      const database = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([OUTBOX_STORE, MEDIA_OUTBOX_STORE], 'readwrite');
        const outbox = transaction.objectStore(OUTBOX_STORE);
        outbox.add({
          opId: operation.opId,
          fingerprint: operationFingerprint(operation),
          operation,
        });
        const mediaOutbox = transaction.objectStore(MEDIA_OUTBOX_STORE);
        for (const upload of media) mediaOutbox.add(upload);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Offline create staging failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Offline create staging aborted'));
      });
    },
    async listMedia() {
      const records = await transact(MEDIA_OUTBOX_STORE, 'readonly', (store) => store.getAll());
      return (records as StagedMediaUpload[]).map((record) => ({
        ...record,
        status: record.status ?? 'pending',
        lastAttemptAt: record.lastAttemptAt ?? null,
        lastError: record.lastError ?? null,
      }));
    },
    async updateMedia(uploadId, patch) {
      const database = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(MEDIA_OUTBOX_STORE, 'readwrite');
        const store = transaction.objectStore(MEDIA_OUTBOX_STORE);
        const lookup = store.get(uploadId);
        lookup.onsuccess = () => {
          const record = lookup.result as StagedMediaUpload | undefined;
          if (record !== undefined) store.put({ ...record, ...patch });
        };
        lookup.onerror = () => reject(lookup.error ?? new Error('Media Outbox lookup failed'));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Media Outbox update failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Media Outbox update aborted'));
      });
    },
    async removeMedia(uploadId) {
      await transact(MEDIA_OUTBOX_STORE, 'readwrite', (store) => store.delete(uploadId));
    },
    async list() {
      const records = await transact(OUTBOX_STORE, 'readonly', (store) => store.getAll()) as Array<{
        sequence?: unknown;
        operation?: unknown;
      }>;
      return records
        .filter((record): record is { sequence: number; operation: PendingSyncOperation } => (
          typeof record.sequence === 'number' && record.operation !== undefined
        ))
        .sort((left, right) => left.sequence - right.sequence)
        .map((record) => ({
          ...record.operation,
          status: record.operation.status ?? 'pending',
          lastAttemptAt: record.operation.lastAttemptAt ?? null,
          lastError: record.operation.lastError ?? null,
        }));
    },
    async update(opId, patch) {
      const database = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(OUTBOX_STORE, 'readwrite');
        const store = transaction.objectStore(OUTBOX_STORE);
        const lookup = store.index(OUTBOX_OPERATION_ID_INDEX).get(opId);
        lookup.onsuccess = () => {
          const record = lookup.result as {
            sequence: number;
            opId: string;
            fingerprint: string;
            operation: PendingSyncOperation;
          } | undefined;
          if (record !== undefined) {
            store.put({ ...record, operation: { ...record.operation, ...patch } });
          }
        };
        lookup.onerror = () => reject(lookup.error ?? new Error('Outbox lookup failed'));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Outbox transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Outbox transaction aborted'));
      });
    },
    async remove(opId) {
      const database = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(OUTBOX_STORE, 'readwrite');
        const store = transaction.objectStore(OUTBOX_STORE);
        const lookup = store.index(OUTBOX_OPERATION_ID_INDEX).getKey(opId);
        lookup.onsuccess = () => {
          if (lookup.result !== undefined) store.delete(lookup.result);
        };
        lookup.onerror = () => reject(lookup.error ?? new Error('Outbox lookup failed'));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Outbox transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Outbox transaction aborted'));
      });
    },
    async removeMany(opIds) {
      const uniqueIds = [...new Set(opIds)];
      if (uniqueIds.length === 0) return;
      const database = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(OUTBOX_STORE, 'readwrite');
        const store = transaction.objectStore(OUTBOX_STORE);
        const index = store.index(OUTBOX_OPERATION_ID_INDEX);
        for (const opId of uniqueIds) {
          const lookup = index.getKey(opId);
          lookup.onsuccess = () => {
            if (lookup.result !== undefined) store.delete(lookup.result);
          };
          lookup.onerror = () => transaction.abort();
        }
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Outbox transaction failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Outbox transaction aborted'));
      });
    },
    close() {
      const pending = databasePromise;
      databasePromise = null;
      if (pending !== null) void pending.then((database) => database.close());
    },
  };
}
