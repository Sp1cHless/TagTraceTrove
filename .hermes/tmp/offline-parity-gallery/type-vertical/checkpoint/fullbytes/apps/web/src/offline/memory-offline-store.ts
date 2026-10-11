import { snapshotState, nextSnapshotRevision, SNAPSHOT_REVISION_KEY, type SnapshotStore } from './snapshot-store.js';
import { operationFingerprint, validatePendingParent, appliedRemovalIds, type OutboxStore, type PendingSyncOperation } from './outbox-store.js';
import { validateExistingMediaStage, type MediaOutboxStore, type StagedMediaUpload } from './media-outbox-store.js';
import { planPendingWorkRestore, RESTORE_CLIENT_KEY, type AtomicPendingWorkStore } from './pending-work-restore.js';

/** Unified memory adapter, not a composition of independently awaited enqueue loops. */
export function createMemoryOfflineStore(): SnapshotStore & OutboxStore & MediaOutboxStore & AtomicPendingWorkStore {
  const generations = new Map<number,string>();
  const meta = new Map<string,string>();
  const operations = new Map<string,PendingSyncOperation>();
  const media = new Map<string,StagedMediaUpload>();
  const clone = <T>(value:T):T => structuredClone(value);
  return {
    async captureSnapshot() { return snapshotState(meta.get('activeGeneration'), generations.get(Number(meta.get('activeGeneration'))), meta.get(SNAPSHOT_REVISION_KEY)); },
    async getOrCreateMeta(key, create) { const existing = meta.get(key); if (existing !== undefined) return existing; const value = create(); meta.set(key, value); return value; },
    async clearSnapshot() {
      // Check and delete synchronously: enqueue/media/activation cannot interleave.
      if (operations.size || media.size) throw new Error('Cannot clear the offline snapshot while unsynced edits or media are pending');
      meta.set(SNAPSHOT_REVISION_KEY,nextSnapshotRevision(meta.get(SNAPSHOT_REVISION_KEY)));
      meta.set('activeGeneration','0'); meta.delete('pendingSnapshotAck'); generations.clear();
    },
    async compareSnapshotMeta(active, key, expected, value, clientId) {
      if ((active?.revision !== undefined && (meta.get(SNAPSHOT_REVISION_KEY) ?? '0') !== active.revision) || (clientId !== undefined && meta.get('t3.offline-client-id') !== clientId) || (meta.get(key) ?? null) !== expected || (active
        ? meta.get('activeGeneration') !== String(active.generationId) || generations.get(active.generationId) !== JSON.stringify(active.snapshot)
        : meta.has('activeGeneration') && meta.get('activeGeneration') !== '0')) return false;
      if (value === null) meta.delete(key); else meta.set(key, value);
      return true;
    },
    async installSnapshot(base,value,acknowledgement,revision=base?.revision,clientId=acknowledgement?.clientId,discardPrevious=false) {
      if (clientId !== undefined && meta.get('t3.offline-client-id') !== clientId) return null;
      if (revision !== undefined && (meta.get(SNAPSHOT_REVISION_KEY) ?? '0') !== revision) return null;
      const active=meta.get('activeGeneration');
      if (base ? active!==String(base.generationId) || generations.get(base.generationId)!==JSON.stringify(base.snapshot)
        : active!==undefined && active!=='0') return null;
      if (meta.has('pendingSnapshotAck')) return null;
      if (discardPrevious && (operations.size || media.size)) return null;
      const id=Math.max(0,...generations.keys())+1;
      const prunedGenerations=[...generations.keys()].filter(key=>discardPrevious || key!==base?.generationId);
      const nextRevision=nextSnapshotRevision(meta.get(SNAPSHOT_REVISION_KEY));
      const pending=acknowledgement ? JSON.stringify({generationId:id,snapshot:value,body:acknowledgement,revision:nextRevision}) : undefined;
      meta.set(SNAPSHOT_REVISION_KEY,nextRevision);
      generations.set(id,value); meta.set('activeGeneration',String(id));
      if (pending !== undefined) meta.set('pendingSnapshotAck',pending);
      for (const key of prunedGenerations) generations.delete(key);
      return {generationId:id,prunedGenerations,revision:nextRevision};
    },
    async listGenerationIds() { return [...generations.keys()].sort((a,b)=>a-b); },
    async writeGeneration(id,value) { generations.set(id,value); },
    async readGeneration(id) { return generations.get(id) ?? null; },
    async deleteGeneration(id) { generations.delete(id); },
    async readMeta(key) { return meta.get(key) ?? null; },
    async writeMeta(key,value) { meta.set(key,value); },
    async bindPendingWorkClient(clientId) {
      const existing=meta.get(RESTORE_CLIENT_KEY);
      if (existing!==undefined && existing!==clientId) throw new Error('Pending-work restore belongs to a different device');
      meta.set(RESTORE_CLIENT_KEY,clientId);
    },
    async restorePendingWork(work,clientId,commit) {
      const result=planPendingWorkRestore(work,clientId,meta.get(RESTORE_CLIENT_KEY),
        generations.get(Number(meta.get('activeGeneration'))),[...operations.values()],[...media.values()],meta.get('activeGeneration'));
      if (commit) {
        // Clone everything before publishing anything; no await/observable partial state.
        const preparedOperations=result.operations.map(clone); const preparedMedia=result.media.map(clone);
        for (const row of preparedOperations) operations.set(row.opId,row);
        for (const row of preparedMedia) media.set(row.uploadId,row);
      }
      return result.preview;
    },
    async enqueue(operation) {
      const existing=operations.get(operation.opId);
      if (existing) {
        if (operationFingerprint(existing)!==operationFingerprint(operation)) throw new Error('Outbox operation ID already exists with different content');
        return 'duplicate';
      }
      validatePendingParent(operation,[...operations.values()]);
      operations.set(operation.opId,clone(operation)); return 'queued';
    },
    async enqueueExistingEntryMedia(upload, guard) {
      validateExistingMediaStage(generations.get(Number(meta.get('activeGeneration'))),meta.get(SNAPSHOT_REVISION_KEY),[...media.values()],upload,guard,meta.get('capability.existingEntryMedia'),[...operations.values()]);
      media.set(upload.uploadId,clone(upload));
    },
    async enqueueEntryCreate(operation,uploads) {
      if (operations.has(operation.opId) || [...operations.values()].some(row=>row.operationKind==='entry.create' && row.entityUid===operation.entityUid)) throw new Error('Entry create already exists');
      const ids=new Set<string>();
      for (const row of uploads) { if (media.has(row.uploadId)||ids.has(row.uploadId)) throw new Error('Media upload ID already exists'); ids.add(row.uploadId); }
      const preparedOperation=clone(operation); const preparedMedia=uploads.map(clone);
      operations.set(operation.opId,preparedOperation);
      for (const row of preparedMedia) media.set(row.uploadId,row);
    },
    async list() { return [...operations.values()].map(clone); },
    async listMedia() { return [...media.values()].map(clone); },
    async update(opId,patch) { const row=operations.get(opId); if (row) operations.set(opId,clone({...row,...patch})); },
    async updateMedia(uploadId,patch) { const row=media.get(uploadId); if (row) media.set(uploadId,clone({...row,...patch})); },
    async remove(opId) { operations.delete(opId); },
    async removeMany(opIds) { for (const id of opIds) operations.delete(id); },
    async removeApplied(opIds) { for (const id of appliedRemovalIds([...operations.values()],opIds)) operations.delete(id); },
    async removeMedia(uploadId) { media.delete(uploadId); },
  };
}
