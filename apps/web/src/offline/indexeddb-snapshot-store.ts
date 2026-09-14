import type { SnapshotStore } from './snapshot-store.js';

const DATABASE_VERSION = 1;
const GENERATIONS_STORE = 'snapshotGenerations';
const META_STORE = 'meta';

export const DEFAULT_OFFLINE_DATABASE_NAME = 't3-offline';

export interface IndexedDbSnapshotStore extends SnapshotStore {
  close(): void;
}

export interface IndexedDbSnapshotStoreOptions {
  indexedDB?: IDBFactory;
  databaseName?: string;
}

/**
 * Browser-backed snapshot generations. Outbox and unsynced media will use
 * separate stores in later phases; clearing/pruning a snapshot must never
 * become capable of deleting them by accident.
 */
export function createIndexedDbSnapshotStore(
  options: IndexedDbSnapshotStoreOptions = {},
): IndexedDbSnapshotStore {
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
    storeName: typeof GENERATIONS_STORE | typeof META_STORE,
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
    close() {
      const pending = databasePromise;
      databasePromise = null;
      if (pending !== null) void pending.then((database) => database.close());
    },
  };
}
