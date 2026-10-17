import { syncReplayRequestSchema, type SyncSnapshot } from '@t3/shared';
import { operationFingerprint, validatePendingParent, type PendingSyncOperation } from './outbox-store.js';
import { referencedEntityKeys } from './sync-mutation-plan.js';
import type { StagedMediaUpload } from './media-outbox-store.js';

export const LOCAL_FINAL_STATE_KEY = 'localFinalState.v1';
export interface LocalMediaItem { key:string; ref:string|null; uploadId?:string }
export interface LocalMediaIntent {
  entryUid:string; libraryId:string; syncEpoch:string; clientId:string; revision:string;
  baselineRefs:string[]; baselineVersion:number; items:LocalMediaItem[]; desired:string[];
  baselineCoverRef?:string|null;baselinePreviewRefs?:string[];
  compiled?:{opId:string; revision:string; refs:Array<{key:string;ref:string}>; uploaded:string[]};
}
export interface LocalDeleteIntent {entryUid:string;libraryId:string;syncEpoch:string;clientId:string;revision:string;compiledOpId?:string}
export interface LocalFinalState {
  version:1; drafts:string[]; mediaDrafts:string[]; mediaOrder:string[]; deferredMedia:string[];derived:string[];
  media:LocalMediaIntent[]; deleted:LocalDeleteIntent[];
}
export interface LocalEditCapture {
  snapshot:string|null; generationId:number; revision:string;clientId:string;
  operations:PendingSyncOperation[];media:StagedMediaUpload[];local:LocalFinalState;
}
export type LocalChange =
  | {kind:'operation';operation:PendingSyncOperation;editable:boolean}
  | {kind:'create';operation:PendingSyncOperation;media:StagedMediaUpload[]}
  | {kind:'media';intent:LocalMediaIntent;upload?:StagedMediaUpload;deferred?:boolean;expectedRevision?:string|null}
  | {kind:'delete';intent:LocalDeleteIntent}
  | {kind:'compile-media';entryUid:string;revision:string;operation:PendingSyncOperation;refs:Array<{key:string;ref:string}>;uploaded:string[]}
  | {kind:'compile-delete';entryUid:string;revision:string;operation:PendingSyncOperation}
  | {kind:'ack';opId:string;serverVersion:number}
  | {kind:'settle-media';entryUid:string;revision:string}
  | {kind:'prepare-media';uploads:StagedMediaUpload[]};
export interface LocalFinalStateStore {
  editLocalFinalState(change:LocalChange,rebase?:(snapshot:SyncSnapshot|null,operations:PendingSyncOperation[],media:StagedMediaUpload[],local:LocalFinalState)=>PendingSyncOperation[]):Promise<void>;
  captureLocalFinalState(freeze?:boolean):Promise<LocalEditCapture>;
}

export function emptyLocalFinalState():LocalFinalState {
  return {version:1,drafts:[],mediaDrafts:[],mediaOrder:[],deferredMedia:[],derived:[],media:[],deleted:[]};
}
export function readLocalFinalState(raw:unknown):LocalFinalState {
  if(raw===undefined || raw===null)return emptyLocalFinalState();
  const value=JSON.parse(String(raw)) as LocalFinalState;
  if(value.version!==1 || !['drafts','mediaDrafts','mediaOrder','deferredMedia','media','deleted'].every(key=>Array.isArray(value[key as keyof LocalFinalState])))throw new Error('Local edits cannot be read; original work is retained');
  value.derived??=[];return value;
}
export function orderLocalMedia(rows:StagedMediaUpload[],state:LocalFinalState):StagedMediaUpload[] {
  const rank=new Map(state.mediaOrder.map((id,index)=>[id,index]));
  return [...rows].sort((a,b)=>(rank.get(a.uploadId)??-1)-(rank.get(b.uploadId)??-1)
    || a.entryUid.localeCompare(b.entryUid) || Number(a.kind!=='cover')-Number(b.kind!=='cover') || a.ordinal-b.ordinal);
}
export function mergeImportedLocalFinalState(raw:unknown,imported:LocalFinalState|undefined,snapshot:SyncSnapshot,clientId:string,operations:PendingSyncOperation[],media:StagedMediaUpload[]):LocalFinalState {
  const local=readLocalFinalState(raw);
  if(!imported)return local;
  for(const intent of [...imported.media,...imported.deleted]){
    if(intent.clientId!==clientId || intent.libraryId!==snapshot.header.libraryId || intent.syncEpoch!==snapshot.header.syncEpoch)throw new Error('Local result belongs to another library or device');
    const known=snapshot.payload.entries.some(row=>row.syncUid===intent.entryUid) || operations.some(row=>row.operationKind==='entry.create' && row.entityUid===intent.entryUid);
    if(!known)throw new Error('Local result owner is unavailable');
  }
  for(const intent of imported.media){
    if(new Set(intent.items.map(row=>row.key)).size!==intent.items.length || new Set(intent.desired).size!==intent.desired.length || intent.desired.some(key=>!intent.items.some(row=>row.key===key)))throw new Error('Invalid local image selection');
    if(intent.compiled && !operations.some(row=>row.opId===intent.compiled!.opId && row.entityUid===intent.entryUid && row.operationKind==='entry.media.set'))throw new Error('Local image submission is missing');
    const existing=local.media.find(row=>row.entryUid===intent.entryUid);
    if(existing && JSON.stringify(existing)!==JSON.stringify(intent))throw new Error('Newer local image choices exist; nothing was restored');
    if(!existing)local.media.push(structuredClone(intent));
  }
  for(const intent of imported.deleted){
    if(intent.compiledOpId && !operations.some(row=>row.opId===intent.compiledOpId && row.operationKind==='entry.delete' && row.entityUid===intent.entryUid))throw new Error('Local deletion submission is missing');
    const existing=local.deleted.find(row=>row.entryUid===intent.entryUid);
    if(existing && JSON.stringify(existing)!==JSON.stringify(intent))throw new Error('Newer local deletion exists; nothing was restored');
    if(!existing)local.deleted.push(structuredClone(intent));
  }
  for(const id of imported.deferredMedia){if(!media.some(row=>row.uploadId===id))throw new Error('Deferred image bytes are missing');if(!local.deferredMedia.includes(id))local.deferredMedia.push(id);if(!local.mediaDrafts.includes(id))local.mediaDrafts.push(id);}
  for(const id of imported.mediaOrder)if(media.some(row=>row.uploadId===id) && !local.mediaOrder.includes(id))local.mediaOrder.push(id);
  // Restored envelopes are originals, even when their export was once a draft.
  // Only deferred image copies with freshly allocated UUIDs remain mutable.
  return local;
}
export function validateLocalMediaReceipts(receipts:Array<{uploadId:string;entryUid:string;entityId:number;relativeRef:string}>,local:LocalFinalState,snapshot:SyncSnapshot):void {
  for(const receipt of receipts){
    const intent=local.media.find(row=>row.entryUid===receipt.entryUid && row.items.some(item=>item.uploadId===receipt.uploadId));
    const entry=snapshot.payload.entries.find(row=>row.syncUid===receipt.entryUid);
    if(!intent || entry && entry.id!==receipt.entityId || !receipt.relativeRef.startsWith(`/api/assets/entries/${receipt.entityId}/`))throw new Error('Restored image mapping belongs to another work');
  }
}
const wire=(row:PendingSyncOperation)=>{const {status,lastAttemptAt,lastError,...body}=row;void status;void lastAttemptAt;void lastError;return body;};
const scope=(a:PendingSyncOperation,b:PendingSyncOperation)=>a.clientId===b.clientId && a.libraryId===b.libraryId && a.syncEpoch===b.syncEpoch;
const key=(row:PendingSyncOperation)=>`${row.entityKind}:${row.entityUid.toLowerCase()}`;
const json=(value:unknown)=>JSON.stringify(value) ?? '';
const stateKinds=new Set(['entry.update','producer.update','collection.update','entry.tags.set','entry.authors.set','entry.contents.set','producer.tags.set','author.directories.set','entry.view-later.set','producer.view-later.set','entry.rating.set','producer.rating.set','collection.entry.set','collection.producer.set','gallery.order.set','collection.order.set','rating-layout.slots.set','gallery.partition.set','entry.tag-layout.set','entry.media.set']);
const patchKinds=new Set(['entry.update','producer.update','collection.update']);

function canObserve(row:PendingSyncOperation,owner:string):boolean {
  if(key(row)===owner)return true;
  if(['entry.tag-layout.set','entry.layout-template.apply','entry.tag-layout.apply','collection.common-tag.add'].includes(row.operationKind))return true;
  const parsed=syncReplayRequestSchema.safeParse(wire(row));
  return !parsed.success || referencedEntityKeys(parsed.data).some(ref=>ref.toLowerCase()===owner);
}
function noOp(row:PendingSyncOperation):boolean {
  const payload={...row.payload};
  for(const field of ['parentCreateOpId','producerCreates','tagCreates','facetCreates','slotUid','entryUid','producerUid','subjectKind'])delete payload[field];
  return Object.keys(payload).every(field=>json(payload[field])===json(row.baseValues[field]));
}

/** Only explicitly marked local drafts can change. Imported/legacy requests and
 * attempted or mirrored originals never become editable by inference. */
function reduceOperation(rows:PendingSyncOperation[],state:LocalFinalState,incoming:PendingSyncOperation,editable:boolean):PendingSyncOperation[] {
  if(!syncReplayRequestSchema.safeParse(wire(incoming)).success)throw new Error('Invalid local edit');
  const duplicate=rows.find(row=>row.opId===incoming.opId);
  if(duplicate){if(operationFingerprint(duplicate)!==operationFingerprint(incoming))throw new Error('An original request cannot be overwritten');return rows;}
  const layoutSlotUids = incoming.operationKind === 'rating-layout.slots.set'
    ? [...(Array.isArray(incoming.baseValues.slots) ? incoming.baseValues.slots : []),
      ...(Array.isArray(incoming.payload.slots) ? incoming.payload.slots : [])]
      .flatMap(slot => slot && typeof slot === 'object' && !Array.isArray(slot) && typeof slot.syncUid === 'string' ? [slot.syncUid] : [])
    : [];
  let previousIndex=-1;
  if(editable && stateKinds.has(incoming.operationKind)) {
    for(let index=rows.length-1;index>=0;index--) {
      const row=rows[index]!;
      // A rating observes its slot even though its revision owner is an Entry or Author.
      // Keep the layout creator before that observer instead of merging it into a later edit.
      if (key(row) !== key(incoming) && layoutSlotUids.some(uid => json([row.baseValues, row.payload]).includes(uid))) break;
      // Facet creation observes its Section and advances the containing layout.
      // Keep earlier layout edits before it, with later edits on the new version.
      if (incoming.operationKind === 'entry.tag-layout.set' && row.operationKind === 'entry.facet.create'
        && ((typeof incoming.payload.entryType === 'string' && incoming.payload.entryType === row.payload.entryType)
          || (typeof row.payload.sectionUid === 'string' && json([incoming.baseValues.groups, incoming.payload.groups]).includes(row.payload.sectionUid)))) break;
      if(!canObserve(row,key(incoming)))continue;
      const draft=key(row)===key(incoming) && scope(row,incoming) && state.drafts.includes(row.opId) && row.status==='pending' && row.lastAttemptAt===null;
      if(draft && row.operationKind===incoming.operationKind && row.payload.slotUid===incoming.payload.slotUid && row.payload.entryUid===incoming.payload.entryUid && row.payload.producerUid===incoming.payload.producerUid){previousIndex=index;break;}
      if(draft && row.entityKind==='entry' && stateKinds.has(row.operationKind) && !['entry.tag-layout.set','entry.media.set','rating-layout.slots.set'].includes(row.operationKind))continue;
      if(draft && row.operationKind==='entry.create'){previousIndex=index;break;}
      break;
    }
  }
  const previous=rows[previousIndex];
  const compatible=previous && previous.operationKind===incoming.operationKind
    && previous.payload.parentCreateOpId===incoming.payload.parentCreateOpId
    && previous.payload.slotUid===incoming.payload.slotUid
    && previous.payload.entryUid===incoming.payload.entryUid && previous.payload.producerUid===incoming.payload.producerUid;
  let result=[...rows],next=incoming;
  if(compatible && !rows.some(row=>row.opId!==previous.opId && json(row.payload).includes(previous.opId))) {
    const base={...incoming.baseValues,...previous.baseValues};
    let payload={...incoming.payload};
    if(incoming.operationKind==='entry.tag-layout.set' && previous.payload.entryType!==undefined)payload.entryType=previous.payload.entryType;
    if(patchKinds.has(incoming.operationKind)) {
      payload={...previous.payload,...payload};
      for(const field of Object.keys(base))if(json(payload[field])===json(base[field])){delete payload[field];delete base[field];}
    } else {
      // The earliest baseline and the latest desired set may both need a local
      // creator. Preserve their declarations; unused intermediates need none.
      for(const field of ['producerCreates','tagCreates','facetCreates']) {
        const dependencies=[...(Array.isArray(previous.payload[field])?previous.payload[field]:[]),...(Array.isArray(payload[field])?payload[field]:[])];
        const referenced=json([base,payload.tags,payload.producerUids]);
        if(dependencies.length)payload[field]=dependencies.filter((value,index)=>dependencies.findIndex(other=>json(other)===json(value))===index
          && value!==null && typeof value==='object' && !Array.isArray(value)
          && ['tagUid','facetUid','producerUid'].some(uid=>typeof value[uid]==='string' && referenced.includes(String(value[uid]))));
      }
    }
    next={...incoming,opId:previous.opId,clientCreatedAt:previous.clientCreatedAt,baseVersion:previous.baseVersion,baseValues:base,payload};
    const body=syncReplayRequestSchema.safeParse(wire(next));
    if(body.success || noOp(next)) {
      result.splice(previousIndex,1);state.drafts=state.drafts.filter(id=>id!==previous.opId);
      if(noOp(next))return result;
    } else next=incoming;
  }
  // A fresh Entry's initial scalar values can be edited directly until the
  // first dependent command freezes an observable intermediate state.
  if(editable && previous?.operationKind==='entry.create' && incoming.operationKind==='entry.update'
    && incoming.payload.parentCreateOpId===previous.opId && state.drafts.includes(previous.opId)) {
    const payload={...previous.payload,...incoming.payload};delete payload.parentCreateOpId;
    const create={...previous,payload};
    if(syncReplayRequestSchema.safeParse(wire(create)).success){result[previousIndex]=create;return result;}
  }
  validatePendingParent(next,result);
  result.push(next);if(editable)state.drafts.push(next.opId);
  return result;
}

function referencesUpload(row:PendingSyncOperation|StagedMediaUpload,id:string):boolean {return json('payload' in row?row.payload:row.existingEntry).includes(id);}

export function planLocalFinalState(snapshot:SyncSnapshot|null,operations:PendingSyncOperation[],media:StagedMediaUpload[],raw:unknown,change:LocalChange) {
  const local=structuredClone(readLocalFinalState(raw));
  let rows=structuredClone(operations),images=media.map(row=>({...row}));
  const identity='operation' in change?change.operation:'intent' in change?change.intent:undefined;
  if(snapshot && identity && (identity.libraryId!==snapshot.header.libraryId || identity.syncEpoch!==snapshot.header.syncEpoch))throw new Error('Local edit belongs to another library');
  if (change.kind === 'operation' || change.kind === 'media') {
    const owner = change.kind === 'operation' ? change.operation : change.intent;
    const keys = change.kind === 'operation'
      ? [key(change.operation), ...referencedEntityKeys(syncReplayRequestSchema.parse(wire(change.operation))).map(value => value.toLowerCase())]
      : [`entry:${change.intent.entryUid.toLowerCase()}`];
    if (local.deleted.some(intent => intent.clientId === owner.clientId && intent.libraryId === owner.libraryId
      && intent.syncEpoch === owner.syncEpoch && keys.includes(`entry:${intent.entryUid.toLowerCase()}`))) {
      throw new Error('This work is marked for deletion; let its original work sync before editing');
    }
  }
  local.drafts=local.drafts.filter(id=>rows.some(row=>row.opId===id && row.status==='pending' && row.lastAttemptAt===null));
  local.mediaDrafts=local.mediaDrafts.filter(id=>images.some(row=>row.uploadId===id && row.status==='pending' && row.lastAttemptAt===null));
  if(change.kind==='operation')rows=reduceOperation(rows,local,change.operation,change.editable);
  if(change.kind==='create') {
    rows=reduceOperation(rows,local,change.operation,true);
    for(const image of change.media){if(images.some(row=>row.uploadId===image.uploadId))throw new Error('Duplicate image identity');images.push(image);local.mediaDrafts.push(image.uploadId);local.mediaOrder.push(image.uploadId);}
  }
  if(change.kind==='media') {
    const old=local.media.find(row=>row.entryUid===change.intent.entryUid);
    if(change.expectedRevision!==undefined && (old?.revision??null)!==change.expectedRevision)throw new Error('Local images changed; retry this edit');
    if(change.intent.compiled && change.intent.compiled.opId!==old?.compiled?.opId)throw new Error('Local media submission changed');
    if(change.upload){if(images.some(row=>row.uploadId===change.upload!.uploadId))throw new Error('Duplicate image identity');images.push(change.upload);local.mediaDrafts.push(change.upload.uploadId);local.mediaOrder.push(change.upload.uploadId);if(change.deferred)local.deferredMedia.push(change.upload.uploadId);}
    const intent=structuredClone(change.intent);
    if(old?.compiled)intent.compiled=old.compiled;
    local.media=local.media.filter(row=>row.entryUid!==intent.entryUid);local.media.push(intent);
    const selected=new Set(intent.desired.flatMap(value=>intent.items.find(item=>item.key===value)?.uploadId??[]));
    images=images.filter(image=>image.entryUid!==intent.entryUid || selected.has(image.uploadId) || !local.mediaDrafts.includes(image.uploadId)
      || images.some(other=>other.uploadId!==image.uploadId && !local.mediaDrafts.includes(other.uploadId) && referencesUpload(other,image.uploadId))
      || rows.some(row=>!local.drafts.includes(row.opId) && referencesUpload(row,image.uploadId)));
    // Unsent media preconditions follow the remaining transport list, not the
    // user's provisional visual order. The final order is compiled afterwards.
    const entry=snapshot?.payload.entries.find(row=>row.syncUid?.toLowerCase()===intent.entryUid.toLowerCase());
    let cover=entry?.coverRef??null;const previews=[...(entry?.previewRefs??[])];let pendingPreview=0;
    const extensions:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/avif':'avif'};
    images=orderLocalMedia(images,local).map(image=>{
      if(image.entryUid!==intent.entryUid)return image;
      let next=image;
      if(!entry && local.mediaDrafts.includes(image.uploadId) && !local.deferredMedia.includes(image.uploadId))next={...image,ordinal:image.kind==='cover'?0:pendingPreview};
      if(entry && local.mediaDrafts.includes(image.uploadId) && !local.deferredMedia.includes(image.uploadId))next={...image,ordinal:image.kind==='cover'?0:previews.length,existingEntry:{expectedCoverRef:cover,expectedPreviewRefs:[...previews]},...(image.kind==='cover' && cover!==null?{replace:true}: {replace:undefined})};
      const ref=entry?`/api/assets/entries/${entry.id}/${next.kind==='cover'?'cover':next.ordinal===0?'preview':`preview-${next.ordinal+1}`}.${next.uploadId}.${extensions[next.mimeType]}`:null;
      if(next.kind==='cover')cover=ref;else if(ref)previews.push(ref);
      if(next.kind==='preview')pendingPreview+=1;
      return next;
    });
  }
  if(change.kind==='delete') {
    const owner=`entry:${change.intent.entryUid.toLowerCase()}`;
    const own=rows.filter(row=>key(row)===owner);
    const ownMedia=images.filter(row=>row.entryUid.toLowerCase()===change.intent.entryUid.toLowerCase());
    const createdAuthors=own.filter(row=>row.operationKind==='entry.author.create-and-link').map(row=>String(row.payload.producerUid).toLowerCase());
    const outside=rows.filter(row=>key(row)!==owner);
    const observed=outside.some(row=>{
      const parsed=syncReplayRequestSchema.safeParse(wire(row));
      return !parsed.success || referencedEntityKeys(parsed.data).some(ref=>ref.toLowerCase()===owner || createdAuthors.some(uid=>ref.toLowerCase()===`producer:${uid}`))
        || row.entityKind==='producer' && createdAuthors.includes(row.entityUid.toLowerCase())
        || json(row.payload).includes(change.intent.entryUid) || own.some(original=>json(row.payload).includes(original.opId));
    });
    if(own.every(row=>local.drafts.includes(row.opId)) && ownMedia.every(row=>local.mediaDrafts.includes(row.uploadId)) && !observed) {
      rows=rows.filter(row=>key(row)!==owner);images=images.filter(row=>row.entryUid.toLowerCase()!==change.intent.entryUid.toLowerCase());
      local.media=local.media.filter(row=>row.entryUid!==change.intent.entryUid);
      if(!own.some(row=>row.operationKind==='entry.create')){local.deleted=local.deleted.filter(row=>row.entryUid!==change.intent.entryUid);local.deleted.push(change.intent);}
    } else {local.deleted=local.deleted.filter(row=>row.entryUid!==change.intent.entryUid);local.deleted.push(change.intent);}
  }
  if(change.kind==='compile-media' || change.kind==='compile-delete') {
    const intent=(change.kind==='compile-media'?local.media:local.deleted).find(row=>row.entryUid===change.entryUid);
    if(!intent || intent.revision!==change.revision || ('compiled' in intent && intent.compiled) || ('compiledOpId' in intent && intent.compiledOpId))throw new Error('Local result changed before submission');
    rows=reduceOperation(rows,local,change.operation,false);
    if(change.kind==='compile-media')(intent as LocalMediaIntent).compiled={opId:change.operation.opId,revision:change.revision,refs:change.refs,uploaded:change.uploaded};
    else (intent as LocalDeleteIntent).compiledOpId=change.operation.opId;
  }
  if(change.kind==='ack') {
    for(const intent of local.media)if(intent.compiled?.opId===change.opId){
      const mapping=new Map(intent.compiled.refs.map(row=>[row.key,row.ref]));
      intent.items=intent.items.map(item=>mapping.has(item.key)?{key:item.key,ref:mapping.get(item.key)!}
        : item.uploadId && intent.compiled!.uploaded.includes(item.uploadId)?{key:item.key,ref:null}:item);
      intent.baselineRefs=intent.compiled.refs.map(row=>row.ref);intent.baselineVersion=change.serverVersion;
      intent.baselineCoverRef=intent.baselineRefs[0]??null;intent.baselinePreviewRefs=intent.baselineRefs.slice(1);
      if(intent.compiled.revision===intent.revision)local.media=local.media.filter(row=>row!==intent);
      else delete intent.compiled;
    }
    const gone=local.deleted.filter(row=>row.compiledOpId===change.opId).map(row=>row.entryUid);
    local.deleted=local.deleted.filter(row=>row.compiledOpId!==change.opId);
    local.media=local.media.filter(row=>!gone.includes(row.entryUid));
  }
  if(change.kind==='settle-media')local.media=local.media.filter(row=>row.entryUid!==change.entryUid || row.revision!==change.revision || row.compiled);
  if(change.kind==='prepare-media')for(const upload of change.uploads){
    const index=images.findIndex(row=>row.uploadId===upload.uploadId);
    if(index<0 || !local.mediaDrafts.includes(upload.uploadId) || !local.deferredMedia.includes(upload.uploadId))throw new Error('Deferred image submission changed');
    images[index]=upload;local.deferredMedia=local.deferredMedia.filter(id=>id!==upload.uploadId);
  }
  for(const creator of [...rows]){
    if(creator.operationKind!=='entry.tag.create' || !local.drafts.includes(creator.opId))continue;
    const used=rows.some(row=>row.opId!==creator.opId && (json([row.baseValues,row.payload]).includes(creator.entityUid) || json(row.payload).includes(creator.opId)));
    if(used && !local.derived.includes(creator.opId))local.derived.push(creator.opId);
    if(!used && local.derived.includes(creator.opId))rows=rows.filter(row=>row.opId!==creator.opId);
  }
  local.drafts=[...new Set(local.drafts)].filter(id=>rows.some(row=>row.opId===id));
  local.mediaDrafts=[...new Set(local.mediaDrafts)].filter(id=>images.some(row=>row.uploadId===id));
  local.mediaOrder=[...new Set(local.mediaOrder)].filter(id=>images.some(row=>row.uploadId===id));
  local.deferredMedia=local.deferredMedia.filter(id=>images.some(row=>row.uploadId===id));
  local.derived=local.derived.filter(id=>rows.some(row=>row.opId===id));
  return {operations:rows,media:orderLocalMedia(images,local),local};
}
