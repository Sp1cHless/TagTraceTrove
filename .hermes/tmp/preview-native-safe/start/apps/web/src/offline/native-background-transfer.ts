import { nativeMutationContract } from '@t3/shared';
import { mutationQueuePlan, originalMutationEnvelope } from './sync-mutation-plan.js';
import type { PendingSyncOperation } from './outbox-store.js';
import { mediaQueueIdentity, type StagedMediaUpload } from './media-outbox-store.js';
export interface NativeTransferCapture { snapshot: string | null; revision: string; clientId: string; operations: PendingSyncOperation[]; media: StagedMediaUpload[] }
export interface NativeTransferPlugin { call(method: string, args: Record<string, unknown>): Promise<unknown> }
function envelope(row: PendingSyncOperation) {
  return JSON.stringify(originalMutationEnvelope(row));
}
/** Bounded chunks; never encode a whole image in JS or log operation/media bytes. */
export function createNativeTransfers(store: {captureNativeTransfers(): Promise<NativeTransferCapture>}, plugin: NativeTransferPlugin) {
  let running: Promise<void> | null = null;
  const foregroundReason = 'Native mutation protocol unavailable; use foreground Update';
  async function supported(): Promise<boolean> {
    try {
      const status = await plugin.call('status', {}) as {protocolVersion?:unknown;planVersion?:unknown;operationKinds?:unknown};
      return status?.protocolVersion === 1 && status.planVersion === 1 && Array.isArray(status.operationKinds)
        && Object.keys(nativeMutationContract).every(kind => status.operationKinds instanceof Array && status.operationKinds.includes(kind));
    } catch { return false; }
  }
  const pause = async (opIds?: string[]) => {
    const capture=await store.captureNativeTransfers();
    await plugin.call('pause', { ...(opIds ? {opIds} : {}),captureOpIds:capture.operations.filter(row=>!opIds || opIds.includes(row.opId)).map(row=>row.opId),captureUploadIds:capture.media.filter(image=>!opIds || capture.operations.some(row=>opIds.includes(row.opId) && row.entityUid.toLowerCase()===image.entryUid.toLowerCase())).map(image=>image.uploadId) });
  };
  async function handoffNow(allowed?:Set<string>, allowedMedia?:Set<string>) {
    if (!await supported()) return;
    const capture = await store.captureNativeTransfers();
    if (!capture.snapshot) return;
    const header = (JSON.parse(capture.snapshot) as {header:{libraryId:string;syncEpoch:string}}).header;
    const snapshot = JSON.parse(capture.snapshot) as {payload:{entries:Array<{id:number;syncUid:string}>}};
    const standalone = capture.media.filter(image => (!allowedMedia || allowedMedia.has(image.uploadId)) && image.existingEntry && !capture.operations.some(row => row.entityUid.toLowerCase() === image.entryUid.toLowerCase()))
      .sort((a,b)=>a.entryUid.localeCompare(b.entryUid) || Number(a.kind!=='cover')-Number(b.kind!=='cover') || a.ordinal-b.ordinal);
    const blocked = new Set<string>();
    for (const image of standalone) {
      if (blocked.has(image.entryUid)) continue;
      if (image.status !== 'pending' || image.libraryId !== header.libraryId || image.syncEpoch !== header.syncEpoch
        || image.blob.size !== image.byteLength || image.byteLength > 20*1024*1024
        || !snapshot.payload.entries.some(row => row.id > 0 && row.syncUid?.toLowerCase() === image.entryUid.toLowerCase())) {
        blocked.add(image.entryUid); continue;
      }
      const {blob,status,lastAttemptAt,lastError,uploadId,...metadata} = image;
      void status; void lastAttemptAt; void lastError;
      const original = JSON.stringify(metadata);
      const requiredFlags = ['offlineMediaUpload','existingEntryMedia',...(image.ordinal > 0 ? ['offlineMediaMultiplePreviews'] : [])];
      const staged = await plugin.call('stageStandaloneMedia',{uploadId,metadata:original,revision:capture.revision,clientId:capture.clientId,requiredFlags}) as {stageId:string};
      for (let offset=0; offset<blob.size; offset+=262144) {
        const bytes=new Uint8Array(await blob.slice(offset,offset+262144).arrayBuffer());
        let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
        await plugin.call('chunk',{stageId:staged.stageId,offset,body:btoa(binary)});
      }
      await plugin.call('seal',{stageId:staged.stageId});
      const latest=await store.captureNativeTransfers();
      const live=latest.media.find(value=>value.uploadId===uploadId);
      if(latest.snapshot!==capture.snapshot || latest.revision!==capture.revision || latest.clientId!==capture.clientId
        || !live || live.status!=='pending' || mediaQueueIdentity(latest.media)!==mediaQueueIdentity(capture.media)) {
        await plugin.call('pauseStandaloneMedia',{uploadIds:[uploadId]});blocked.add(image.entryUid);continue;
      }
      await plugin.call('activateStandaloneMedia',{uploadId,revision:capture.revision});
    }
    const plans=mutationQueuePlan(capture.operations);
    for (const row of capture.operations) {
      const plan=plans.get(row.opId)!;
      if ((allowed && !allowed.has(row.opId)) || !plan.eligible || row.status !== 'pending' || row.clientId !== capture.clientId
        || row.libraryId !== header.libraryId || row.syncEpoch !== header.syncEpoch) continue;
      const media = capture.media.filter(image => row.operationKind === 'entry.create' && image.entryUid.toLowerCase() === row.entityUid.toLowerCase())
        .sort((a,b)=>Number(a.kind!=='cover')-Number(b.kind!=='cover') || a.ordinal-b.ordinal);
      // Unsupported shapes are held unchanged for the existing foreground scheduler.
      if (media.length === 0) {
        const body = envelope(row);
        const requiredFlags = plan.requiredFlags;
        await plugin.call('stageOperation', {body, revision:capture.revision, requiredFlags, plan});
        const latest = await store.captureNativeTransfers();
        const live = latest.operations.find(value => value.opId === row.opId);
        if (latest.snapshot !== capture.snapshot || latest.revision !== capture.revision || latest.clientId !== capture.clientId
          || !live || live.status !== 'pending' || envelope(live) !== body
          || (row.operationKind === 'entry.create' && latest.media.some(value => value.entryUid.toLowerCase() === row.entityUid.toLowerCase()))
          || JSON.stringify(mutationQueuePlan(latest.operations).get(row.opId))!==JSON.stringify(plan)) {
          await pause([row.opId]); continue;
        }
        await plugin.call('activate', {opId:row.opId, revision:capture.revision});
        continue;
      }
      if (media.some(image => image.status !== 'pending' || image.libraryId !== row.libraryId || image.syncEpoch !== row.syncEpoch
        || image.blob.size !== image.byteLength || image.byteLength > 20*1024*1024)) continue;
      const body = envelope(row);
      for (const image of media) {
        const {blob,status,lastAttemptAt,lastError,uploadId,...metadata} = image;
        void status; void lastAttemptAt; void lastError;
        const requiredFlags = ['offlineMutations','offlineEntryCreate','offlineMediaUpload'];
        if (row.payload.contents !== undefined) requiredFlags.push('offlineEntryInitialContents');
        if (Array.isArray(row.payload.ratings) && row.payload.ratings.some(value => typeof value === 'object' && value !== null && 'slotUid' in value)) requiredFlags.push('offlineRatingSlotLayout');
        if (image.ordinal > 0) requiredFlags.push('offlineMediaMultiplePreviews');
        const staged = await plugin.call('stage', {opId:row.opId, body, uploadId, metadata:JSON.stringify(metadata), revision:capture.revision, requiredFlags, plan}) as {stageId:string};
        for (let offset=0; offset<blob.size; offset+=262144) {
          const bytes = new Uint8Array(await blob.slice(offset,offset+262144).arrayBuffer());
          let binary=''; for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
          await plugin.call('chunk',{stageId:staged.stageId,offset,body:btoa(binary)});
        }
        await plugin.call('seal',{stageId:staged.stageId});
      }
      const latest = await store.captureNativeTransfers();
      const live = latest.operations.find(value=>value.opId===row.opId);
      const latestMedia=latest.media.filter(value=>value.entryUid.toLowerCase()===row.entityUid.toLowerCase());
      if (latest.snapshot !== capture.snapshot || latest.revision !== capture.revision || latest.clientId !== capture.clientId
        || !live || live.status !== 'pending' || envelope(live)!==body || latestMedia.length!==media.length
        || media.some(image => !latestMedia.some(value => value.uploadId===image.uploadId && value.status==='pending'
          && value.sha256===image.sha256 && value.byteLength===image.byteLength && value.kind===image.kind && value.ordinal===image.ordinal
          && value.libraryId===image.libraryId && value.syncEpoch===image.syncEpoch && value.mimeType===image.mimeType))) {
        await pause([row.opId]); continue;
      }
      await plugin.call('activate',{opId:row.opId, revision:capture.revision});
    }
  }
  return { handoff() { return running ??= handoffNow().finally(()=>{running=null;}); }, pause,
    // Results are intentionally NOT imported as canonical receipts. Foreground re-sends
    // immutable originals to the typed server receipt + verified snapshot/ACK flow.
    async reconcile() {
      const capture=await store.captureNativeTransfers();
      return await plugin.call('reconcile',{liveOpIds:capture.operations.map(row=>row.opId),liveUploadIds:capture.media.map(row=>row.uploadId)}) as {active:number;completed:number;held:number;dependencyHeld?:number};
    },
    async resume() {
      const initial=await store.captureNativeTransfers();
      if (!await supported()) return {active:0,completed:0,held:0,remainingOperations:initial.operations.length,standaloneMedia:initial.media.filter(row=>row.existingEntry).length,foregroundMedia:initial.media.length,foregroundReason};
      if(!initial.snapshot)return {active:0,completed:0,held:0,remainingOperations:initial.operations.length,foregroundMedia:initial.media.length};
      const caps=await plugin.call('preflight',{}) as {libraryId:string;syncEpoch:string;featureFlags:Record<string,unknown>};
      const scope=(value:{libraryId:string;syncEpoch:string})=>caps.libraryId===value.libraryId && caps.syncEpoch===value.syncEpoch;
      const initialPlans=mutationQueuePlan(initial.operations);
      const allowed=new Set(initial.operations.filter(row=>row.clientId===initial.clientId && scope(row) && initialPlans.get(row.opId)?.eligible && initialPlans.get(row.opId)!.requiredFlags.every(flag=>caps.featureFlags?.[flag]===true)
        && initial.media.filter(image=>!image.existingEntry && image.entryUid.toLowerCase()===row.entityUid.toLowerCase()).every(image=>image.byteLength<=20*1024*1024 && caps.featureFlags?.offlineMediaUpload===true && (image.ordinal===0 || caps.featureFlags?.offlineMediaMultiplePreviews===true))).map(row=>row.opId));
      // Capability-held parents propagate through the same causal plan.
      for(const row of initial.operations)if(initialPlans.get(row.opId)?.dependencies.some(id=>!allowed.has(id)))allowed.delete(row.opId);
      const allowedMedia=new Set(initial.media.filter(row=>row.existingEntry && scope(row) && row.status==='pending' && row.byteLength<=20*1024*1024 && caps.featureFlags?.offlineMediaUpload===true && caps.featureFlags?.existingEntryMedia===true && (row.ordinal===0 || caps.featureFlags?.offlineMediaMultiplePreviews===true)).map(row=>row.uploadId));
      const capabilityHeld=initial.operations.filter(row=>row.status==='pending' && (!scope(row) || initialPlans.get(row.opId)!.requiredFlags.some(flag=>caps.featureFlags?.[flag]!==true))).length;
      const dependencyHeld=initial.operations.filter(row=>row.status==='pending' && !allowed.has(row.opId) && initialPlans.get(row.opId)!.dependencies.length>0 && scope(row) && initialPlans.get(row.opId)!.requiredFlags.every(flag=>caps.featureFlags?.[flag]===true)).length;
      if(allowed.size===0 && allowedMedia.size===0){
        const status=await this.reconcile();
        return {active:status.active,completed:status.completed,held:status.held,dependencyHeld:(status.dependencyHeld ?? 0)+dependencyHeld,remainingOperations:initial.operations.length,capabilityHeld,standaloneMedia:initial.media.filter(row=>row.existingEntry).length,foregroundMedia:initial.media.filter(row=>row.byteLength>20*1024*1024).length,foregroundReason:capabilityHeld ? 'Current required capability unavailable; original work retained' : dependencyHeld ? 'Dependencies are held; original work retained' : 'Use foreground Update to verify unsupported or oversized originals'};
      }
      if(running)await running;
      await handoffNow(allowed,allowedMedia);const latest=await store.captureNativeTransfers();
      const plans=mutationQueuePlan(latest.operations);
      const resumed=await plugin.call('resumeOperations',{operations:latest.operations.filter(row=>allowed.has(row.opId) && row.status==='pending' && row.clientId===latest.clientId && plans.get(row.opId)?.eligible).map(row=>({body:envelope(row),revision:latest.revision,plan:plans.get(row.opId)}))}) as {capabilityHeld?:number;reason?:string};
      await plugin.call('resumeStandaloneMedia',{uploads:latest.media.filter(row=>allowedMedia.has(row.uploadId) && row.existingEntry && row.status==='pending' && row.byteLength<=20*1024*1024).map(image=>{
        const {blob,status,lastAttemptAt,lastError,uploadId,...metadata}=image;void blob;void status;void lastAttemptAt;void lastError;
        return {uploadId,metadata:JSON.stringify(metadata),revision:latest.revision};
      })});
      const status=await this.reconcile();const capture=await store.captureNativeTransfers();
      return {...status,dependencyHeld:(status.dependencyHeld ?? 0)+dependencyHeld,remainingOperations:capture.operations.filter(row=>!allowed.has(row.opId)).length,capabilityHeld:capabilityHeld+(resumed?.capabilityHeld ?? 0),...(resumed?.reason ? {foregroundReason:resumed.reason} : {}),standaloneMedia:capture.media.filter(row=>row.existingEntry).length,foregroundMedia:capture.media.filter(row=>row.byteLength>20*1024*1024).length};
    } };
}
export function nativeTransferPlugin(): NativeTransferPlugin | null {
  const runtime = (globalThis as typeof globalThis & {Capacitor?:{nativePromise?:(plugin:string,method:string,args:Record<string,unknown>)=>Promise<unknown>}}).Capacitor;
  return runtime?.nativePromise ? {call:(method,args)=>runtime.nativePromise!('T3BackgroundTransfer',method,args)} : null;
}
