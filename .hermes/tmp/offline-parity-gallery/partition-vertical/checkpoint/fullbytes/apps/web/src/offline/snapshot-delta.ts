import { syncAckRequestSchema, syncDeltaPageSchema, syncSnapshotSchema, type SyncSnapshot, type SyncCapabilities, type SyncDeltaRequest, type SyncDeltaPage, type SyncAckRequest } from '@t3/shared';
import { PENDING_SNAPSHOT_ACK_KEY, verifyChecksum, readActiveSnapshot, type ActiveSnapshot, type SnapshotStore } from './snapshot-store.js';

export interface SnapshotDeltaApi {
  fetchSyncSnapshot(options?: { media: 'none' | 'thumbnails' }): Promise<SyncSnapshot>;
  fetchSnapshotDelta?(request:SyncDeltaRequest):Promise<SyncDeltaPage>;
  ackSnapshotDelta?(request:SyncAckRequest):Promise<{ackSeq:number}>;
}
export interface SnapshotCandidate { snapshot:SyncSnapshot; acknowledgement?:SyncAckRequest }
/** A missing/expired server-owned baseline is a verified FULL fetch, not a delta. */
export async function fetchSnapshotCandidate(api:SnapshotDeltaApi,base:ActiveSnapshot|null,
  capabilities:SyncCapabilities,clientId:string,media: 'none' | 'thumbnails' = 'thumbnails'):Promise<SnapshotCandidate> {
  if (!base || !api.fetchSnapshotDelta || !api.ackSnapshotDelta || capabilities.featureFlags.completeSnapshotDelta!==true
    || base.snapshot.header.libraryId!==capabilities.libraryId || base.snapshot.header.syncEpoch!==capabilities.syncEpoch
    || capabilities.syncProtocolVersion!==1 || base.snapshot.header.changeSeq===undefined
    || !(await verifyChecksum(base.snapshot,base.snapshot.header.checksum))) return {snapshot:await api.fetchSyncSnapshot({media})};
  // The persisted user choice controls manifests; originals remain explicit preload work.
  const request:SyncDeltaRequest={libraryId:capabilities.libraryId,syncEpoch:capabilities.syncEpoch,
    protocolVersion:1,clientId,media,baseChecksum:base.snapshot.header.checksum,baseChangeSeq:base.snapshot.header.changeSeq};
  try {
    const text=JSON.stringify(base.snapshot); let inserted=''; let first:SyncDeltaPage|undefined;
    for (let pages=0;pages<3073;pages++) {
      const page=syncDeltaPageSchema.parse(await api.fetchSnapshotDelta({...request,
        ...(first?{token:first.token}:{}),offset:inserted.length}));
      first??=page;
      if (page.offset!==inserted.length || page.baseChecksum!==request.baseChecksum
        || page.token!==first.token || page.prefix!==first.prefix || page.remove!==first.remove
        || page.insertLength!==first.insertLength || JSON.stringify(page.target)!==JSON.stringify(first.target)
        || page.target.libraryId!==request.libraryId || page.target.syncEpoch!==request.syncEpoch
        || page.target.snapshotFormatVersion!==capabilities.snapshotFormatVersion
        || page.target.snapshotSeq<=base.snapshot.header.snapshotSeq
        || page.target.changeSeq===undefined || page.target.changeSeq<request.baseChangeSeq
        || page.prefix+page.remove>text.length || (!page.done && page.chunk.length===0)) throw new Error('Invalid frozen delta page');
      inserted+=page.chunk;
      if (inserted.length>page.insertLength || inserted.length>48*1024*1024) throw new Error('Delta exceeds bound');
      if (page.done) {
        if (inserted.length!==page.insertLength) throw new Error('Incomplete delta');
        const candidate=text.slice(0,page.prefix)+inserted+text.slice(page.prefix+page.remove);
        if (candidate.length>48*1024*1024) throw new Error('Snapshot exceeds bound');
        const snapshot=syncSnapshotSchema.parse(JSON.parse(candidate) as unknown);
        if (JSON.stringify(snapshot.header)!==JSON.stringify(page.target)
          || !(await verifyChecksum(snapshot,page.target.checksum))) throw new Error('Delta target checksum mismatch');
        return {snapshot,acknowledgement:{libraryId:request.libraryId,syncEpoch:request.syncEpoch,
          protocolVersion:1,clientId,cursorSeq:page.target.changeSeq}};
      }
    }
    throw new Error('Too many delta pages');
  } catch (cause) {
    // Only explicit transport/protocol absence permits a full fallback. Corrupt
    // pages and identity/offset conflicts must not be hidden by publishing full data.
    if (cause instanceof Error && 'status' in cause
      && (cause.status === 404 || cause.status === 501
        || (cause.status === 409 && /(?:baseline unavailable|session unavailable|cache exhausted|exceeds bound)/iu.test(cause.message)))) {
      return {snapshot:await api.fetchSyncSnapshot({media})};
    }
    throw cause;
  }
}
/** Retry only the immutable tuple committed in the activation transaction. */
export async function retryPendingSnapshotAck(api:SnapshotDeltaApi,store:SnapshotStore,
  capabilities?:SyncCapabilities,clientId?:string):Promise<void> {
  const raw=await store.readMeta(PENDING_SNAPSHOT_ACK_KEY);
  if (raw===null) return;
  if (!api.ackSnapshotDelta || !store.compareSnapshotMeta) throw new Error('Pending snapshot acknowledgement requires a compatible transport and atomic store');
  const parsed=JSON.parse(raw) as {generationId:number;snapshot:string;body:unknown;revision?:string};
  const body=syncAckRequestSchema.parse(parsed.body);
  const snapshot=syncSnapshotSchema.parse(JSON.parse(parsed.snapshot) as unknown);
  if (!Number.isSafeInteger(parsed.generationId) || parsed.generationId<1
    || body.libraryId!==snapshot.header.libraryId || body.syncEpoch!==snapshot.header.syncEpoch
    || body.cursorSeq!==snapshot.header.changeSeq) throw new Error('Invalid install-bound acknowledgement');
  const active=await readActiveSnapshot(store);
  const invalidScope=(capabilities!==undefined && (body.libraryId!==capabilities.libraryId || body.syncEpoch!==capabilities.syncEpoch))
    || (clientId!==undefined && body.clientId!==clientId);
  if (invalidScope || !active || (parsed.revision ?? '0') !== (active.revision ?? '0') || active.generationId!==parsed.generationId || JSON.stringify(active.snapshot)!==parsed.snapshot) {
    // A Clear, peer replacement or epoch rotation invalidates the old install.
    // Compare against the replacement too: never delete a newer peer's pending tuple.
    if (!await store.compareSnapshotMeta(active,PENDING_SNAPSHOT_ACK_KEY,raw,null)) throw new Error('Snapshot changed while disposing an obsolete acknowledgement');
    return;
  }
  if (!await verifyChecksum(active.snapshot,active.snapshot.header.checksum)) throw new Error('Installed snapshot checksum mismatch');
  // Digest work yields: revalidate pointer, exact bytes AND tuple atomically afterwards.
  if (!await store.compareSnapshotMeta(active,PENDING_SNAPSHOT_ACK_KEY,raw,raw,body.clientId)) throw new Error('Installed snapshot or device changed before acknowledgement');
  const response=await api.ackSnapshotDelta(body);
  if (!Number.isSafeInteger(response.ackSeq) || response.ackSeq<body.cursorSeq) throw new Error('Snapshot acknowledgement was rejected');
  await store.compareSnapshotMeta(active,PENDING_SNAPSHOT_ACK_KEY,raw,null,body.clientId);
}
/** Read back the committed candidate. Loss keeps the pending tuple and fails this Update. */
export async function acknowledgeSnapshotCandidate(api:SnapshotDeltaApi,store:SnapshotStore,
  candidate:SnapshotCandidate,generationId:number,revision?:string):Promise<void> {
  if (!candidate.acknowledgement || !api.ackSnapshotDelta) return;
  const active=await readActiveSnapshot(store);
  if (!active || (revision !== undefined && active.revision !== revision) || active.generationId!==generationId
    || JSON.stringify(active.snapshot)!==JSON.stringify(candidate.snapshot)
    || !(await verifyChecksum(active.snapshot,active.snapshot.header.checksum))) throw new Error('Activated snapshot changed before acknowledgement');
  const raw=await store.readMeta(PENDING_SNAPSHOT_ACK_KEY);
  if (raw===null) throw new Error('Snapshot acknowledgement was not durably installed');
  const pending=JSON.parse(raw) as {generationId:number;body:unknown};
  if (pending.generationId!==generationId || JSON.stringify(pending.body)!==JSON.stringify(candidate.acknowledgement)) throw new Error('Snapshot acknowledgement tuple changed');
  await retryPendingSnapshotAck(api,store);
}
