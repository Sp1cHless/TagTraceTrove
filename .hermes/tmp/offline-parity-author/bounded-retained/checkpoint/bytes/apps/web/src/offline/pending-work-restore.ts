import { normalizeTag, pendingWorkFileSchema, syncReplayRequestSchema, syncSnapshotSchema, type SyncSnapshot, type SyncReplayRequest } from '@t3/shared';
import { operationFingerprint, type PendingSyncOperation } from './outbox-store.js';
import type { StagedMediaUpload } from './media-outbox-store.js';

export const MAX_RESTORE_FILE_BYTES = 96 * 1024 * 1024;
const MAX_BINARY_BYTES = 64 * 1024 * 1024;
export const RESTORE_CLIENT_KEY = 'pendingWork.clientId';
export interface PreparedPendingWork { operations: PendingSyncOperation[]; media: StagedMediaUpload[]; expectedSnapshot?: string }
export interface PendingWorkRestorePreview {
  operationCount: number; mediaCount: number; binaryBytes: number;
  addedOperations: number; addedMedia: number; identicalOperations: number; identicalMedia: number;
  scope: string; snapshotIdentity: string;
}
export interface AtomicPendingWorkStore {
  bindPendingWorkClient(clientId: string): Promise<void>;
  restorePendingWork(work: PreparedPendingWork, clientId: string, commit: boolean): Promise<PendingWorkRestorePreview>;
}


/** Parse/check bytes before opening the transaction. Never log file contents. */
export async function preparePendingWork(text: string): Promise<PreparedPendingWork> {
  if (text.length > MAX_RESTORE_FILE_BYTES || new TextEncoder().encode(text).byteLength > MAX_RESTORE_FILE_BYTES) {
    throw new Error('Pending-work file exceeds the safe 96 MiB limit');
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid pending-work file'); }
  const result = pendingWorkFileSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid or unsupported pending-work file fields');
  // Validation only: never publish Zod-transformed envelopes as replacement retries.
  const source = value as {operations:PendingSyncOperation[]};
  for (const operation of source.operations) {
    const {status,lastAttemptAt,lastError,...envelope} = operation;
    void status; void lastAttemptAt; void lastError;
    if (!syncReplayRequestSchema.safeParse(envelope).success) throw new Error('Invalid or unsupported pending edit envelope');
  }
  const total = result.data.media.reduce((sum,row)=>sum+row.byteLength,0);
  if (total > MAX_BINARY_BYTES) throw new Error('Pending images exceed the safe 64 MiB limit');
  const media: StagedMediaUpload[] = [];
  for (const {base64,...metadata} of result.data.media) {
    if (base64.length !== Math.ceil(metadata.byteLength / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) {
      throw new Error('Invalid staged image encoding or byte length');
    }
    const binary = atob(base64);
    if (binary.length !== metadata.byteLength || btoa(binary) !== base64) throw new Error('Invalid staged image byte length or encoding');
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (!globalThis.crypto?.subtle) throw new Error('Image verification is unavailable on this device');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
    if (hash !== metadata.sha256) throw new Error('Staged image checksum does not match');
    const blob = new Blob([bytes], {type:metadata.mimeType});
    media.push({...metadata,blob});
  }
  return {operations:structuredClone(source.operations),media};
}

export function mediaFingerprint(media: StagedMediaUpload): string {
  return JSON.stringify([media.uploadId,media.libraryId,media.syncEpoch,media.entryUid,media.kind,media.ordinal,
    media.mimeType,media.byteLength,media.sha256,media.existingEntry]);
}
const uid = (value:string) => value.toLowerCase();

/** Pure latest-state validation, called synchronously INSIDE the storage transaction. */
export function planPendingWorkRestore(work: PreparedPendingWork, clientId: string, boundClient: unknown,
  rawSnapshot: unknown, existing: PendingSyncOperation[], existingMedia: StagedMediaUpload[], generation?: unknown,
): {operations:PendingSyncOperation[];media:StagedMediaUpload[];preview:PendingWorkRestorePreview} {
  if (boundClient !== clientId) throw new Error('Pending-work restore belongs to a different device');
  let snapshot: SyncSnapshot;
  try { snapshot = syncSnapshotSchema.parse(JSON.parse(String(rawSnapshot))); }
  catch { throw new Error('Download a valid offline copy before restoring pending work'); }
  const identity = snapshot.header;
  const snapshotIdentity = JSON.stringify([generation ?? null,identity]);
  if (work.expectedSnapshot!==undefined && work.expectedSnapshot!==snapshotIdentity) {
    throw new Error('Offline copy changed after preview; preview the file again. Nothing was restored');
  }
  const allSource = [...existing,...work.operations];
  if (allSource.some(row=>row.clientId!==clientId || row.libraryId!==identity.libraryId || row.syncEpoch!==identity.syncEpoch)
    || [...existingMedia,...work.media].some(row=>row.libraryId!==identity.libraryId || row.syncEpoch!==identity.syncEpoch)) {
    throw new Error('Pending work does not match this device, library, or current recovery version');
  }
  const operations: PendingSyncOperation[] = [];
  const rows = new Map(existing.map(row=>[uid(row.opId),row]));
  const seen = new Set<string>();
  for (const row of work.operations) {
    if (seen.has(uid(row.opId))) throw new Error('Duplicate edit identity in pending-work file');
    seen.add(uid(row.opId));
    const live = rows.get(uid(row.opId));
    if (live && operationFingerprint(live)!==operationFingerprint(row)) throw new Error('An existing edit has newer or different contents; nothing was restored');
    if (!live) { operations.push(row); rows.set(uid(row.opId),row); }
  }
  const union = [...existing,...operations];
  // Existing same-owner work must never be reordered behind older restored work.
  for (const row of operations) {
    if (existing.some(live=>live.entityKind===row.entityKind && uid(live.entityUid)===uid(row.entityUid)
      && (live.clientCreatedAt > row.clientCreatedAt || live.baseVersion > row.baseVersion))) {
      throw new Error('Newer local edits already exist for this item; nothing was restored');
    }
  }
  for (const [index,row] of union.entries()) {
    if ((row.entityKind === 'entry' || row.entityKind === 'producer') && union.slice(0,index).some(prior => prior.operationKind === `${row.entityKind}.delete` && uid(prior.entityUid) === uid(row.entityUid))) {
      throw new Error('A deleted Entry cannot accept later restored edits; nothing was restored');
    }
    if (union.slice(0,index).some(prior=>prior.entityKind===row.entityKind && uid(prior.entityUid)===uid(row.entityUid)
      && (prior.clientCreatedAt > row.clientCreatedAt || prior.baseVersion > row.baseVersion))) {
      throw new Error('Pending same-owner edits are out of causal order; nothing was restored');
    }
  }
  const payload = snapshot.payload;
  const owners = new Map<string, Set<string>>([
    ['entry', new Set(payload.entries.flatMap(row=>row.syncUid ? [uid(row.syncUid)] : []))],
    ['producer', new Set(payload.producers.flatMap(row=>row.syncUid ? [uid(row.syncUid)] : []))],
    ['collection', new Set(payload.collections.flatMap(row=>row.syncUid ? [uid(row.syncUid)] : []))],
    ['gallery_order', new Set(payload.galleryOrder ? [uid(payload.galleryOrder.syncUid)] : [])],
    ['rating_layout', new Set(payload.ratingLayouts?.map(row=>uid(row.syncUid)) ?? [])],
    ['author_directory_set', new Set([...(payload.authorDirectorySets?.map(row=>uid(row.syncUid)) ?? []),...union.flatMap(row=>row.operationKind==='producer.create' && typeof row.payload.directorySetUid==='string' ? [uid(row.payload.directorySetUid)] : [])])],
  ]);
  for (const row of union) {
    const {status,lastAttemptAt,lastError,...envelope} = row;
    void status; void lastAttemptAt; void lastError;
    if (!syncReplayRequestSchema.safeParse(envelope).success) throw new Error('An existing pending edit has an unsupported envelope');
    if (!['producer.create','entry.create','entry.tag.create','entry.facet.create','collection.create','collection.order.set'].includes(row.operationKind)
      && !owners.get(row.entityKind)?.has(uid(row.entityUid))
      && !union.some(parent=>parent.operationKind===`${row.entityKind}.create` && uid(parent.entityUid)===uid(row.entityUid))) {
      throw new Error('Pending edit owner is not in this library or its pending creates');
    }
    if (row.operationKind==='entry.create' && !payload.entries.some(entry=>entry.type===row.payload.type)) throw new Error('Pending Entry Gallery is not in this offline copy');
    if (row.operationKind==='entry.facet.create') {
      const section = payload.tagGroups.find(group=>group.syncUid && uid(group.syncUid)===uid(String(row.payload.sectionUid)));
      if (!section || section.groupKind!=='section' || section.entryType!==row.payload.entryType) throw new Error('Pending Facet Section is not in this Gallery');
    }
  }
  for (const [index,row] of union.entries()) validateReferences(syncReplayRequestSchema.parse({opId:row.opId,clientId:row.clientId,libraryId:row.libraryId,syncEpoch:row.syncEpoch,entityKind:row.entityKind,entityUid:row.entityUid,operationKind:row.operationKind,baseVersion:row.baseVersion,baseValues:row.baseValues,payload:row.payload,clientCreatedAt:row.clientCreatedAt}), snapshot, union, index);
  const byId = new Map(union.map((row,index)=>[uid(row.opId),{row,index}]));
  const producerCreates = new Set<string>();
  for (const row of union) if (row.operationKind==='entry.author.create-and-link' && typeof row.payload.producerUid==='string') {
    const key = uid(row.payload.producerUid);
    const canonical = payload.producers.find(producer=>producer.syncUid && uid(producer.syncUid)===key);
    if (producerCreates.has(key) || (canonical && normalizeTag(canonical.name)!==normalizeTag(String(row.payload.name)))) {
      throw new Error('Created Author identity collides with another Author');
    }
    producerCreates.add(key);
  }
  const contentCreates = new Set<string>();
  for (const row of union) {
    const values = row.operationKind==='entry.create' ? row.payload.contents
      : row.operationKind==='entry.content.append' ? [row.payload.content] : [];
    if (!Array.isArray(values)) continue;
    for (const content of values) {
      if (!content || typeof content!=='object' || Array.isArray(content) || typeof content.syncUid!=='string') continue;
      const key = uid(content.syncUid);
      const canonical = payload.entryContents.find(value=>value.syncUid && uid(value.syncUid)===key);
      const owner = payload.entries.find(value=>value.syncUid && uid(value.syncUid)===uid(row.entityUid));
      if (contentCreates.has(key) || (canonical && (canonical.entryId!==owner?.id
        || canonical.contentType!==content.contentType || canonical.content!==content.content))) {
        throw new Error('Created Content identity collides with another row');
      }
      contentCreates.add(key);
    }
  }
  const creates = new Map<string,string>();
  for (const row of union) {
    if (['producer.create','entry.create','entry.tag.create','entry.facet.create','collection.create'].includes(row.operationKind)) {
      const key = `${row.entityKind}:${uid(row.entityUid)}`;
      if (creates.has(key) && creates.get(key)!==row.opId) throw new Error('Duplicate created item identity');
      creates.set(key,row.opId);
    }
  }
  for (const [index,row] of union.entries()) {
    const dependencies: Array<{id:string;kind:string;owner:string}> = [];
    if (typeof row.payload.parentCreateOpId==='string') dependencies.push({id:row.payload.parentCreateOpId,kind:'entry.create',owner:row.entityUid});
    for (const [key,kind,ownerKey] of [['producerCreates','entry.author.create-and-link','producerUid'],['tagCreates','entry.tag.create','tagUid'],['facetCreates','entry.facet.create','facetUid']] as const) {
      const refs = row.payload[key];
      if (Array.isArray(refs)) for (const ref of refs) {
        if (!ref || typeof ref!=='object' || Array.isArray(ref) || typeof ref.createOpId!=='string' || typeof ref[ownerKey]!=='string') throw new Error('Invalid creation dependency');
        dependencies.push({id:ref.createOpId,kind,owner:ref[ownerKey] as string});
      }
    }
    for (const dependency of dependencies) {
      const parent = byId.get(uid(dependency.id));
      const owner = parent?.row.operationKind==='entry.author.create-and-link' ? parent.row.payload.producerUid : parent?.row.entityUid;
      if (!parent || parent.index>=index || (parent.row.operationKind!==dependency.kind && !(dependency.kind==='entry.author.create-and-link' && parent.row.operationKind==='producer.create')) || typeof owner!=='string' || uid(owner)!==uid(dependency.owner)) {
        throw new Error('A pending edit has a missing, foreign, or out-of-order parent. Restore a complete export containing the original parent edit before its children; cached item IDs cannot verify its server receipt. Nothing was restored');
      }
    }
  }
  const seededScopes=new Map<string,string>();
  for (const row of union) if (row.operationKind==='producer.create' && typeof row.payload.directorySetUid==='string') {
    const scope=uid(row.payload.directorySetUid);const producer=uid(row.entityUid);
    if (scope===producer || seededScopes.has(scope) && seededScopes.get(scope)!==producer) throw new Error('Directory seed identity collision');
    const known=payload.authorDirectorySets?.find(set=>uid(set.syncUid)===scope);
    const owner=payload.producers.find(owner=>owner.id===known?.producerId);
    if (known && owner?.syncUid?.toLowerCase()!==producer) throw new Error('Directory seed belongs to a foreign Producer');
    seededScopes.set(scope,producer);
  }
  const media: StagedMediaUpload[] = [];
  const liveUploads = new Map(existingMedia.map(row=>[uid(row.uploadId),row]));
  seen.clear();
  for (const row of work.media) {
    if (seen.has(uid(row.uploadId))) throw new Error('Duplicate staged image identity');
    seen.add(uid(row.uploadId));
    const live = liveUploads.get(uid(row.uploadId));
    if (live && mediaFingerprint(live)!==mediaFingerprint(row)) throw new Error('An existing image has different contents; nothing was restored');
    if (!live) { media.push(row); liveUploads.set(uid(row.uploadId),row); }
  }
  const slots = new Set<string>();
  for (const row of liveUploads.values()) {
    if (row.blob.size!==row.byteLength || row.blob.type!==row.mimeType) throw new Error('A staged image is incomplete');
    const key = `${uid(row.entryUid)}:${row.kind}:${row.ordinal}`;
    if (slots.has(key) || (row.kind==='cover' && row.ordinal!==0)) throw new Error('Duplicate or invalid staged image position');
    slots.add(key);
    if (row.existingEntry && row.kind === 'preview') {
      const owner = payload.entries.find(entry=>entry.syncUid && uid(entry.syncUid)===uid(row.entryUid));
      if (row.existingEntry.expectedPreviewRefs.length !== row.ordinal) throw new Error('Invalid existing media position precondition');
      for (let ordinal = owner?.previewRefs.length ?? 0; ordinal < row.ordinal; ordinal++) {
        const earlier = [...liveUploads.values()].find(prior=>uid(prior.entryUid)===uid(row.entryUid) && prior.kind==='preview' && prior.ordinal===ordinal && prior.existingEntry);
        if (!earlier) throw new Error('A staged Preview is missing an earlier predecessor');
      }
    }
    // Keep the original create even if its authoritative Entry is already present.
    if (row.existingEntry ? !payload.entries.some(entry=>entry.syncUid && uid(entry.syncUid)===uid(row.entryUid)) : !union.some(op=>op.operationKind==='entry.create' && uid(op.entityUid)===uid(row.entryUid))) throw new Error('A staged image is missing its original Entry create');
  }
  return {operations,media,preview:{operationCount:work.operations.length,mediaCount:work.media.length,
    binaryBytes:work.media.reduce((sum,row)=>sum+row.byteLength,0),snapshotIdentity,addedOperations:operations.length,addedMedia:media.length,
    identicalOperations:work.operations.length-operations.length,identicalMedia:work.media.length-media.length,
    scope:work.operations.length || work.media.length ? 'This device and current library only' : 'Empty file: no work to restore'}};
}

function validateReferences(op: SyncReplayRequest, snapshot: SyncSnapshot, union: PendingSyncOperation[], index: number): void {
  const payload = snapshot.payload;
  const prior = union.slice(0,index);
  const same = (left:string|undefined,right:string) => left !== undefined && uid(left)===uid(right);
  const entry = (value:string) => payload.entries.some(row=>same(row.syncUid,value)) || prior.some(row=>row.operationKind==='entry.create' && same(row.entityUid,value));
  const producer = (value:string) => payload.producers.some(row=>same(row.syncUid,value)) || prior.some(row=>row.operationKind==='producer.create' ? same(row.entityUid,value) : row.operationKind==='entry.author.create-and-link' && typeof row.payload.producerUid==='string' && same(row.payload.producerUid,value));
  const collection = (value:string) => payload.collections.some(row=>same(row.syncUid,value)) || prior.some(row=>row.operationKind==='collection.create' && same(row.entityUid,value));
  const requireRef = (valid:boolean) => { if (!valid) throw new Error('A related item identity is missing or belongs to another owner'); };
  if (op.operationKind==='rating-layout.slots.set') {
    const layout = payload.ratingLayouts?.find(row=>same(row.syncUid,op.entityUid));
    requireRef(!!layout && layout.subjectKind === (op.payload.subjectKind ?? (layout.subjectKind === 'author_self' ? 'producer' : layout.subjectKind)));
    for (const slot of [...op.baseValues.slots,...op.payload.slots]) {
      const known = payload.ratingSlots.find(row=>same(row.syncUid,slot.syncUid));
      requireRef(!!layout && (!known || (known.subjectKind===layout.subjectKind && known.entryType===layout.entryType)));
    }
  }
  if (op.operationKind==='author.directories.set') {
    const set = payload.authorDirectorySets?.find(row=>same(row.syncUid,op.entityUid));
    const creator = prior.find(row=>row.operationKind==='producer.create' && typeof row.payload.directorySetUid==='string' && same(row.payload.directorySetUid,op.entityUid));
    requireRef((!!set && payload.producers.some(row=>row.id===set.producerId)) || !!creator);
    if (creator) requireRef(op.payload.producerCreates?.some(dep=>same(creator.entityUid,dep.producerUid) && same(creator.opId,dep.createOpId))===true);
    for (const directory of [...op.baseValues.directories,...op.payload.directories]) {
      const known = payload.authorDirectories.find(row=>same(row.syncUid,directory.syncUid));
      requireRef(!known || known.producerId===set?.producerId);
      for (const member of directory.entries) {
        const owner = payload.entries.find(row=>same(row.syncUid,member.syncUid));
        requireRef(!!owner && (payload.entryProducers.some(row=>row.entryId===owner.id && row.producerId===set?.producerId) || !!creator && prior.some(row=>row.operationKind==='entry.authors.set' && same(row.entityUid,member.syncUid) && Array.isArray(row.payload.producerUids) && row.payload.producerUids.includes(creator.entityUid))));
      }
    }
  }
  if (op.operationKind==='entry.authors.set') {
    for (const value of [...op.baseValues.producerUids,...op.payload.producerUids]) {
      if (!producer(value)) throw new Error('Pending Author identity is missing from this library');
    }
  }
  if (op.operationKind==='entry.author.create-and-link') {
    op.baseValues.producerUids.forEach(value=>requireRef(producer(value)));

  }
  if (op.operationKind==='collection.create' && op.payload.parentUid) {
    const parent = payload.collections.find(row=>same(row.syncUid,op.payload.parentUid!));
    const local = prior.find(row=>row.operationKind==='collection.create' && same(row.entityUid,op.payload.parentUid!));
    requireRef(collection(op.payload.parentUid) && (parent?.kind ?? local?.payload.kind)==='entry'
      && (parent ? parent.parentId===null : local?.payload.parentUid===null)
      && (op.payload.galleryType===null || (parent ? parent.galleryType ?? null : local?.payload.galleryType)===op.payload.galleryType));
  }
  if (op.operationKind==='collection.entry.set') {
    const owner = payload.collections.find(row=>same(row.syncUid,op.entityUid));
    const local = prior.find(row=>row.operationKind==='collection.create' && same(row.entityUid,op.entityUid));
    requireRef((owner?.kind ?? local?.payload.kind)==='entry' && entry(op.payload.entryUid));
  }
  if (op.operationKind==='collection.producer.set') {
    const owner = payload.collections.find(row=>same(row.syncUid,op.entityUid));
    const local = prior.find(row=>row.operationKind==='collection.create' && same(row.entityUid,op.entityUid));
    requireRef((owner?.kind ?? local?.payload.kind)==='producer' && producer(op.payload.producerUid));
  }
  if (op.operationKind==='gallery.order.set') {
    const types = new Set(payload.entries.map(row => row.type));
    requireRef(op.baseValues.orderedTypes.length === types.size && op.baseValues.orderedTypes.every(type => types.has(type)));
  }
  if (op.operationKind==='collection.order.set') {
    for (const value of [...op.baseValues.collections.map(row=>row.syncUid),...op.payload.orderedCollectionUids]) {
      const owner = payload.collections.find(row=>same(row.syncUid,value));
      const local = prior.find(row=>row.operationKind==='collection.create' && same(row.entityUid,value));
      requireRef(collection(value) && (owner?.kind ?? local?.payload.kind)===op.payload.kind
        && (owner ? owner.parentId===null : local?.payload.parentUid===null));
    }
  }
  if (op.operationKind==='entry.tags.set') {
    const owner = payload.entries.find(row=>same(row.syncUid,op.entityUid));
    const create = prior.find(row=>row.operationKind==='entry.create' && same(row.entityUid,op.entityUid));
    const type = owner?.type ?? create?.payload.type;
    for (const tag of [...op.baseValues.tags,...op.payload.tags]) {
      const facet = tag.facetUid ? payload.tagGroups.find(row=>same(row.syncUid,tag.facetUid!)) : payload.tagGroups.find(row=>row.id===tag.facetId);
      const staged = tag.facetUid ? prior.find(row=>row.operationKind==='entry.facet.create' && same(row.entityUid,tag.facetUid!)) : undefined;
      requireRef((facet?.groupKind==='facet' && facet.entryType===type) || staged?.payload.entryType===type);
      const canonical = payload.tags.find(row=>normalizeTag(row.name)===normalizeTag(tag.name));
      const stagedTag=prior.find(row=>row.operationKind==='entry.tag.create' && typeof row.payload.name==='string' && normalizeTag(row.payload.name)===normalizeTag(tag.name));
      requireRef(canonical!==undefined || stagedTag!==undefined);
      if(tag.tagUid) requireRef(same(canonical?.syncUid,tag.tagUid) || same(stagedTag?.entityUid,tag.tagUid));
    }
  }
  if (op.operationKind==='entry.rating.set' || op.operationKind==='producer.rating.set') {
    const subjectKind=op.operationKind==='entry.rating.set'?'entry':op.payload.subjectKind ?? 'producer';
    const owner=subjectKind==='entry'?payload.entries.find(row=>same(row.syncUid,op.entityUid)):undefined;
    const author = payload.producers.find(row=>same(row.syncUid,op.entityUid));
    const types = new Map<string,number>();
    if (subjectKind!=='entry') for (const edge of payload.entryProducers.filter(row=>row.producerId===author?.id)) {
      const type = payload.entries.find(row=>row.id===edge.entryId)?.type;
      if (type) types.set(type,(types.get(type) ?? 0)+1);
    }
    const anchor = prior.filter(row=>row.operationKind==='producer.update' && same(row.entityUid,op.entityUid) && Object.hasOwn(row.payload,'galleryAnchor')).at(-1)?.payload.galleryAnchor;
    const type = subjectKind==='entry' ? owner?.type : anchor ?? author?.galleryAnchor ?? [...types].sort(([a,x],[b,y])=>y-x || a.localeCompare(b))[0]?.[0];
    const staged = prior.filter(row => {
      if (row.operationKind !== 'rating-layout.slots.set') return false;
      const layout = payload.ratingLayouts?.find(layout => same(layout.syncUid, row.entityUid));
      return layout?.subjectKind === subjectKind && layout.entryType === type;
    }).at(-1);
    const slots = staged ? (staged.payload.slots as Array<{syncUid:string}>) : payload.ratingSlots.filter(row => row.subjectKind === subjectKind && row.entryType === type);
    requireRef(slots.some(row => same(row.syncUid, op.payload.slotUid)));
  }
  if (op.operationKind==='entry.contents.set') {
    const owner=payload.entries.find(row=>same(row.syncUid,op.entityUid));
    const parent=prior.find(row=>row.operationKind==='entry.create' && same(row.entityUid,op.entityUid));
    const known=new Set(payload.entryContents.filter(row=>row.entryId===owner?.id).flatMap(row=>row.syncUid?[uid(row.syncUid)]:[]));
    if(parent && Array.isArray(parent.payload.contents)) for(const row of parent.payload.contents) if(row && typeof row==='object' && !Array.isArray(row) && typeof row.syncUid==='string') known.add(uid(row.syncUid));
    for(const row of prior) if(row.operationKind==='entry.content.append' && same(row.entityUid,op.entityUid)) {
      const content=row.payload.content; if(content && typeof content==='object' && !Array.isArray(content) && typeof content.syncUid==='string') known.add(uid(content.syncUid));
    }
    for(const row of [...op.baseValues.contents,...op.payload.contents]) requireRef(known.has(uid(row.syncUid)));
  }
}


