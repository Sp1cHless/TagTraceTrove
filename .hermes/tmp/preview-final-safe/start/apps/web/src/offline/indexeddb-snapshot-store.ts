import { snapshotState, nextSnapshotRevision, SNAPSHOT_REVISION_KEY, type SnapshotState, type SnapshotStore } from './snapshot-store.js';
import { planPendingWorkRestore, RESTORE_CLIENT_KEY, type AtomicPendingWorkStore } from './pending-work-restore.js';
import {
  operationFingerprint,
  appliedRemovalIds,
  validatePendingParent,
  type OutboxStore,
  type PendingSyncOperation,
} from './outbox-store.js';
import { mediaQueueIdentity, validateExistingMediaStage, type MediaOutboxStore, type StagedMediaUpload } from './media-outbox-store.js';

const DATABASE_VERSION = 3;
const GENERATIONS_STORE = 'snapshotGenerations';
const META_STORE = 'meta';
const OUTBOX_STORE = 'outbox';
const MEDIA_OUTBOX_STORE = 'mediaOutbox';
const OUTBOX_OPERATION_ID_INDEX = 'opId';

export const DEFAULT_OFFLINE_DATABASE_NAME = 't3-offline';

export interface IndexedDbOfflineStore extends SnapshotStore, OutboxStore, MediaOutboxStore, AtomicPendingWorkStore {
  captureNativeTransfers(): Promise<import("./native-background-transfer.js").NativeTransferCapture>;
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
    async captureNativeTransfers() {
      const database = await open();
      return new Promise<import('./native-background-transfer.js').NativeTransferCapture>((resolve, reject) => {
        const tx = database.transaction([META_STORE, GENERATIONS_STORE, OUTBOX_STORE, MEDIA_OUTBOX_STORE], 'readonly');
        const meta = tx.objectStore(META_STORE);
        const pointer = meta.get('activeGeneration'); const revision = meta.get(SNAPSHOT_REVISION_KEY);
        const client = meta.get('t3.offline-client-id');
        const rows = tx.objectStore(OUTBOX_STORE).getAll(); const images = tx.objectStore(MEDIA_OUTBOX_STORE).getAll();
        let raw: IDBRequest | undefined;
        pointer.onsuccess = () => { raw = tx.objectStore(GENERATIONS_STORE).get(Number(pointer.result) || 0); };
        tx.oncomplete = () => resolve({ snapshot: typeof raw?.result === 'string' ? raw.result : null,
          revision: String(revision.result ?? '0'), clientId: String(client.result ?? ''),
          operations: (rows.result as Array<{operation: PendingSyncOperation}>).map(row => row.operation), media: images.result as StagedMediaUpload[] });
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Native handoff capture aborted'));
      });
    },
    async captureSnapshot() {
      const database=await open();
      return new Promise<SnapshotState>((resolve,reject)=>{
        const tx=database.transaction([META_STORE,GENERATIONS_STORE],'readonly');
        const meta=tx.objectStore(META_STORE); const pointer=meta.get('activeGeneration'); const revision=meta.get(SNAPSHOT_REVISION_KEY);
        let raw: IDBRequest | undefined;
        pointer.onsuccess=()=>{raw=tx.objectStore(GENERATIONS_STORE).get(Number(pointer.result)||0);};
        tx.oncomplete=()=>resolve(snapshotState(pointer.result,raw?.result,revision.result));
        tx.onabort=tx.onerror=()=>reject(tx.error ?? new Error('Snapshot capture aborted'));
      });
    },
    async getOrCreateMeta(key, create) {
      const database = await open();
      return new Promise<string>((resolve, reject) => {
        const transaction = database.transaction(META_STORE, 'readwrite');
        const meta = transaction.objectStore(META_STORE); const lookup = meta.get(key);
        let value: string; let error: unknown;
        lookup.onsuccess = () => {
          try { value = typeof lookup.result === 'string' ? lookup.result : create(); if (lookup.result === undefined) meta.add(value, key); }
          catch (cause) { error = cause; transaction.abort(); }
        };
        transaction.oncomplete = () => resolve(value);
        transaction.onabort = transaction.onerror = () => reject(error ?? transaction.error ?? new Error('Device identity unavailable'));
      });
    },
    async bindPendingWorkClient(clientId) {
      const database = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(META_STORE, 'readwrite');
        const meta = transaction.objectStore(META_STORE);
        const lookup = meta.get(RESTORE_CLIENT_KEY);
        let error: Error | null = null;
        lookup.onsuccess = () => {
          if (lookup.result !== undefined && lookup.result !== clientId) {
            error = new Error('Pending-work restore belongs to a different device'); transaction.abort();
          } else if (lookup.result === undefined) meta.add(clientId, RESTORE_CLIENT_KEY);
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(error ?? transaction.error ?? new Error('Device identity unavailable'));
      });
    },
    async restorePendingWork(work, clientId, commit) {
      const database = await open();
      return new Promise((resolve, reject) => {
        // Shared stores serialize restore with enqueue, retry state, cleanup and snapshot activation.
        const transaction = database.transaction([OUTBOX_STORE, MEDIA_OUTBOX_STORE, META_STORE, GENERATIONS_STORE], 'readwrite');
        const outbox = transaction.objectStore(OUTBOX_STORE);
        const media = transaction.objectStore(MEDIA_OUTBOX_STORE);
        const meta = transaction.objectStore(META_STORE);
        const generations = transaction.objectStore(GENERATIONS_STORE);
        let explicitError: Error | null = null;
        let result: ReturnType<typeof planPendingWorkRestore> | undefined;
        const rows = outbox.getAll(); const images = media.getAll();
        const client = meta.get(RESTORE_CLIENT_KEY); const active = meta.get('activeGeneration');
        let raw: IDBRequest | undefined;
        function validate() {
          if (rows.readyState !== 'done' || images.readyState !== 'done' || client.readyState !== 'done' || !raw || raw.readyState !== 'done') return;
          try {
            result = planPendingWorkRestore(work, clientId, client.result, raw.result,
              (rows.result as Array<{operation: PendingSyncOperation}>).map(row=>row.operation), images.result as StagedMediaUpload[], active.result);
            if (commit) {
              for (const operation of result.operations) outbox.add({opId:operation.opId,fingerprint:operationFingerprint(operation),operation});
              for (const upload of result.media) media.add(upload);
            }
          } catch (cause) { explicitError = cause instanceof Error ? cause : new Error('Pending-work restore failed'); transaction.abort(); }
        }
        rows.onsuccess = images.onsuccess = client.onsuccess = validate;
        active.onsuccess = () => { raw = generations.get(Number(active.result)); raw.onsuccess = validate; };
        transaction.oncomplete = () => result ? resolve(result.preview) : reject(new Error('Pending-work validation did not complete'));
        transaction.onerror = transaction.onabort = () => reject(explicitError ?? transaction.error ?? new Error('Pending-work restore aborted; nothing was restored'));
      });
    },
    async clearSnapshot() {
      const database = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([GENERATIONS_STORE, META_STORE, OUTBOX_STORE, MEDIA_OUTBOX_STORE], 'readwrite');
        const operations = transaction.objectStore(OUTBOX_STORE).count();
        const media = transaction.objectStore(MEDIA_OUTBOX_STORE).count();
        const revision = transaction.objectStore(META_STORE).get(SNAPSHOT_REVISION_KEY);
        let explicitError: Error | null = null;
        function clear() {
          if (operations.readyState !== 'done' || media.readyState !== 'done' || revision.readyState !== 'done') return;
          if (operations.result > 0 || media.result > 0) {
            explicitError = new Error('Cannot clear the offline snapshot while unsynced edits or media are pending');
            transaction.abort(); return;
          }
          transaction.objectStore(META_STORE).put(nextSnapshotRevision(revision.result as string | undefined), SNAPSHOT_REVISION_KEY);
          transaction.objectStore(META_STORE).put('0', 'activeGeneration');
          transaction.objectStore(META_STORE).delete('pendingSnapshotAck');
          transaction.objectStore(GENERATIONS_STORE).clear();
        }
        operations.onsuccess = media.onsuccess = revision.onsuccess = clear;
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => reject(explicitError ?? transaction.error ?? new Error('Snapshot Clear aborted'));
      });
    },
    async compareSnapshotMeta(expectedActive, key, expected, value, clientId) {
      const database = await open();
      return new Promise<boolean>((resolve, reject) => {
        const transaction = database.transaction([META_STORE, GENERATIONS_STORE], 'readwrite');
        const meta = transaction.objectStore(META_STORE); const generations = transaction.objectStore(GENERATIONS_STORE);
        const active = meta.get('activeGeneration'); const stored = meta.get(key); const client = meta.get('t3.offline-client-id'); const revision = meta.get(SNAPSHOT_REVISION_KEY);
        let raw: IDBRequest | undefined; let result = false;
        function compare() {
          if (!raw || raw.readyState !== 'done' || stored.readyState !== 'done' || client.readyState !== 'done' || revision.readyState !== 'done') return;
          if (expectedActive?.revision !== undefined && (revision.result ?? '0') !== expectedActive.revision) return;
          if ((clientId !== undefined && client.result !== clientId) || (stored.result ?? null) !== expected || (expectedActive
            ? active.result !== String(expectedActive.generationId) || raw.result !== JSON.stringify(expectedActive.snapshot)
            : active.result !== undefined && active.result !== '0')) return;
          result = true; if (value === null) meta.delete(key); else meta.put(value, key);
        }
        stored.onsuccess = client.onsuccess = revision.onsuccess = compare;
        active.onsuccess = () => { raw = generations.get(Number(active.result) || 0); raw.onsuccess = compare; };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Snapshot metadata comparison aborted'));
      });
    },
    async installSnapshot(base,value,acknowledgement,expectedRevision=base?.revision,clientId=acknowledgement?.clientId,discardPrevious=false) {
      const database=await open();
      return new Promise<{generationId:number;prunedGenerations:number[];revision:string}|null>((resolve,reject)=>{
        // Serialize activation with restore/enqueue/media work. No pending row is removed.
        const transaction=database.transaction([GENERATIONS_STORE,META_STORE,OUTBOX_STORE,MEDIA_OUTBOX_STORE],'readwrite');
        const generations=transaction.objectStore(GENERATIONS_STORE); const meta=transaction.objectStore(META_STORE);
        const active=meta.get('activeGeneration'); const keys=generations.getAllKeys(); const pending=meta.get('pendingSnapshotAck');
        const revision=meta.get(SNAPSHOT_REVISION_KEY); const client=meta.get('t3.offline-client-id');
        const operations=transaction.objectStore(OUTBOX_STORE).count(); const media=transaction.objectStore(MEDIA_OUTBOX_STORE).count();
        let raw:IDBRequest|undefined; let result:number|null=null;
        const prunedGenerations:number[]=[]; let installedRevision='0';
        function install() {
          if (keys.readyState!=='done' || active.readyState!=='done' || pending.readyState!=='done' || !raw || raw.readyState!=='done') return;
          if (revision.readyState !== 'done' || client.readyState !== 'done' || operations.readyState !== 'done' || media.readyState !== 'done') return;
          if (discardPrevious && (operations.result > 0 || media.result > 0)) return;
          if (clientId !== undefined && client.result !== clientId) return;
          if (expectedRevision !== undefined && (revision.result ?? '0') !== expectedRevision) return;
          if (pending.result !== undefined) return;
          if (base ? active.result!==String(base.generationId) || raw.result!==JSON.stringify(base.snapshot)
            : active.result!==undefined && active.result!=='0') return;
          result=Math.max(0,...keys.result.filter((key):key is number=>typeof key==='number'))+1;
          installedRevision=nextSnapshotRevision(revision.result as string | undefined);
          meta.put(installedRevision,SNAPSHOT_REVISION_KEY);
          generations.add(value,result); meta.put(String(result),'activeGeneration');
          if (acknowledgement) meta.put(JSON.stringify({generationId:result,snapshot:value,body:acknowledgement,revision:installedRevision}),'pendingSnapshotAck');
          for (const key of keys.result) if (key !== result && (discardPrevious || key !== base?.generationId)) {
            generations.delete(key); if (typeof key === 'number') prunedGenerations.push(key);
          }
        }
        keys.onsuccess=pending.onsuccess=revision.onsuccess=client.onsuccess=operations.onsuccess=media.onsuccess=install;
        active.onsuccess=()=>{raw=generations.get(Number(active.result)||0);raw.onsuccess=install;};
        transaction.oncomplete=()=>resolve(result===null ? null : {generationId:result,prunedGenerations,revision:installedRevision});
        transaction.onerror=transaction.onabort=()=>reject(transaction.error??new Error('Snapshot install aborted'));
      });
    },
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
          const rows = store.getAll();
          rows.onsuccess = () => {
            try {
              validatePendingParent(operation, (rows.result as Array<{ operation: PendingSyncOperation }>).map(row => row.operation));
              store.add({ opId: operation.opId, fingerprint, operation });
            } catch (cause) {
              explicitError = cause instanceof Error ? cause : new Error(String(cause));
              transaction.abort();
            }
          };
          rows.onerror = () => transaction.abort();
        };
        lookup.onerror = () => reject(lookup.error ?? new Error('Outbox lookup failed'));
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error ?? new Error('Outbox transaction failed'));
        transaction.onabort = () => reject(explicitError ?? transaction.error ?? new Error('Outbox transaction aborted'));
      });
    },
    async cancelExistingEntryPreviews(entryUid, retainedIds, guard) {
      const database = await open();
      await new Promise<void>((resolve,reject) => {
        const tx = database.transaction([META_STORE,GENERATIONS_STORE,OUTBOX_STORE,MEDIA_OUTBOX_STORE], 'readwrite');
        const meta = tx.objectStore(META_STORE); const media = tx.objectStore(MEDIA_OUTBOX_STORE);
        const active = meta.get('activeGeneration'); const revision = meta.get(SNAPSHOT_REVISION_KEY);
        const rows = media.getAll(); const operations = tx.objectStore(OUTBOX_STORE).getAll();
        let explicitError: unknown;
        active.onsuccess = () => {
          const raw = tx.objectStore(GENERATIONS_STORE).get(Number(active.result));
          raw.onsuccess = () => {
            try {
              if (raw.result !== guard.snapshot || (revision.result ?? '0') !== guard.revision || mediaQueueIdentity(rows.result) !== guard.media) throw new Error('Offline media changed; try again');
              const owner = (rows.result as StagedMediaUpload[]).filter(row => row.entryUid === entryUid).sort((a,b)=>a.ordinal-b.ordinal);
              if (owner.some(row => row.lastAttemptAt !== null || row.status !== 'pending')) throw new Error('An attempted or uncertain upload cannot be cancelled');
              if ((operations.result as {operation: PendingSyncOperation}[]).some(row => row.operation.entityUid === entryUid)) throw new Error('Queued Entry edits depend on these images; replay or review them before cancellation');
              if (!owner.length || owner.some(row => !row.existingEntry || row.kind !== 'preview') || retainedIds.some(id => !owner.some(row => row.uploadId === id))) throw new Error('Only unsent existing Entry previews can be cancelled');
              const previews = [...owner[0]!.existingEntry!.expectedPreviewRefs];
              const extensions = {'image/avif':'avif','image/gif':'gif','image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
              const snapshot = JSON.parse(guard.snapshot) as import('@t3/shared').SyncSnapshot;
              const entry = snapshot.payload.entries.find(row => row.syncUid === entryUid)!;
              for (const row of owner) {
                if (!retainedIds.includes(row.uploadId)) { media.delete(row.uploadId); continue; }
                const ordinal = previews.length;
                media.put({...row,ordinal,existingEntry:{expectedCoverRef:row.existingEntry!.expectedCoverRef,expectedPreviewRefs:[...previews]}});
                const name = ordinal === 0 ? 'preview' : `preview-${ordinal+1}`;
                previews.push(`/api/assets/entries/${entry.id}/${name}.${row.uploadId}.${extensions[row.mimeType]}`);
              }
            } catch (cause) { explicitError = cause; tx.abort(); }
          };
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(explicitError ?? tx.error);
        tx.onabort = () => reject(explicitError ?? tx.error ?? new Error('Media cancellation aborted'));
      });
    },
    async enqueueExistingEntryMedia(upload, guard) {
      const database = await open();
      await new Promise<void>((resolve,reject) => {
        const tx = database.transaction([META_STORE,GENERATIONS_STORE,MEDIA_OUTBOX_STORE], 'readwrite');
        const meta = tx.objectStore(META_STORE);
        const media = tx.objectStore(MEDIA_OUTBOX_STORE);
        const active = meta.get('activeGeneration');
        const revision = meta.get(SNAPSHOT_REVISION_KEY);
        const capability = meta.get('capability.existingEntryMedia');
        const rows = media.getAll();
        let explicitError: unknown;
        active.onsuccess = () => {
          const raw = tx.objectStore(GENERATIONS_STORE).get(Number(active.result));
          raw.onsuccess = () => {
            try {
              validateExistingMediaStage(raw.result,revision.result,rows.result,upload,guard,capability.result);
              media.add(upload);
            } catch (cause) { explicitError = cause; tx.abort(); }
          };
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(explicitError ?? tx.error);
        tx.onabort = () => reject(explicitError ?? tx.error ?? new Error('Media staging aborted'));
      });
    },
    async enqueueEntryCreate(operation, media) {
      const database = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([OUTBOX_STORE, MEDIA_OUTBOX_STORE], 'readwrite');
        const outbox = transaction.objectStore(OUTBOX_STORE);
        let explicitError: Error | null = null;
        const lookup = outbox.getAll();
        lookup.onsuccess = () => {
          const duplicate = (lookup.result as Array<{ operation: PendingSyncOperation }>).some(({ operation: existing }) => (
            existing.operationKind === 'entry.create'
            && existing.entityUid === operation.entityUid
            && existing.libraryId === operation.libraryId
            && existing.syncEpoch === operation.syncEpoch
          ));
          if (duplicate) {
            explicitError = new Error('An offline Entry create is already queued for this identity');
            transaction.abort();
            return;
          }
          outbox.add({
            opId: operation.opId,
            fingerprint: operationFingerprint(operation),
            operation,
          });
          const mediaOutbox = transaction.objectStore(MEDIA_OUTBOX_STORE);
          for (const upload of media) mediaOutbox.add(upload);
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Offline create staging failed'));
        transaction.onabort = () => reject(explicitError ?? transaction.error ?? new Error('Offline create staging aborted'));
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
    async removeApplied(opIds) {
      if (opIds.length === 0) return;
      const database = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(OUTBOX_STORE, 'readwrite');
        const store = transaction.objectStore(OUTBOX_STORE);
        const lookup = store.getAll();
        lookup.onsuccess = () => {
          const rows = lookup.result as Array<{ sequence: number; operation: PendingSyncOperation }>;
          const removable = new Set(appliedRemovalIds(rows.map(row => row.operation), opIds));
          for (const row of rows) if (removable.has(row.operation.opId)) store.delete(row.sequence);
        };
        lookup.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('Outbox cleanup failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('Outbox cleanup aborted'));
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
