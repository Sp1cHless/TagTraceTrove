import { syncReplayRequestSchema, nativeMutationContract as contract, type SyncReplayOperation, type SyncReplayRequest } from '@t3/shared';
import type { PendingSyncOperation } from './outbox-store.js';
const exhaustive: Record<SyncReplayOperation['operationKind'], {entityKind:string;flags:readonly string[]}> = contract;
export function requiredMutationCapabilities(operation: SyncReplayRequest): string[] {
 const flags=operation.operationKind==='entry.media.set' ? ['offlineMutations','offlineEntryMediaOrder'] : [...exhaustive[operation.operationKind].flags];
 const p=operation.payload as Record<string,unknown>;
 const pending=typeof p.parentCreateOpId==='string';
 const add=(flag:string)=>{if(!flags.includes(flag))flags.push(flag);};
 if((operation.operationKind==='entry.update' || operation.operationKind==='entry.create') && Object.hasOwn(p,'durationSeconds'))add('offlineEntryDuration');
 if(p.subjectKind==='author_self' || Object.hasOwn(p,'galleryAnchor'))add('offlineAuthorSelfRatings');
 if(Object.hasOwn(p,'deletedSlotUids'))add('offlineRatingSlotDelete');
 if(operation.operationKind==='entry.create') {
  if(p.contents!==undefined)add('offlineEntryInitialContents');
  if(operation.payload.ratings.some(row=>row.slotUid!==undefined))add('offlineRatingSlotLayout');
 }
 if(pending) {
  const extras:Partial<Record<SyncReplayRequest['operationKind'],string>>={'entry.update':'offlinePendingEntryMetadata','entry.contents.set':'offlinePendingEntryContents','entry.authors.set':'offlinePendingEntryAuthors','entry.author.create-and-link':'offlinePendingEntryAuthorCreate','entry.tags.set':'offlinePendingEntryTags'};
  const extra=extras[operation.operationKind];if(extra)add(extra);
 }
 if(operation.operationKind==='entry.authors.set' && operation.payload.producerCreates?.length)add('offlineCrossEntryPendingAuthors');
 if(operation.operationKind==='entry.tags.set') {
  if(operation.payload.tagCreates?.length){add('offlineEntryTagVocabulary');if(pending)add('offlinePendingEntryTagCreation');}
  if(operation.payload.facetCreates?.length)add('offlineEntryFacetCreate');
 }
 return flags;
}
export function referencedEntityKeys(operation: SyncReplayRequest): string[] {
 if(operation.operationKind==='collection.create')return operation.payload.parentUid===null?[]:[`collection:${operation.payload.parentUid}`];
 if(operation.operationKind==='collection.entry.set')return [`entry:${operation.payload.entryUid}`];
 if(operation.operationKind==='collection.producer.set')return [`producer:${operation.payload.producerUid}`];
 if(operation.operationKind==='collection.order.set')return [...new Set([...operation.baseValues.collections.map(row=>row.syncUid),...operation.payload.orderedCollectionUids])].map(uid=>`collection:${uid}`);
 return [];
}
export function newlyCreatedRatingSlotUids(operation: SyncReplayRequest):string[] {
 if(operation.operationKind!=='rating-layout.slots.set')return [];
 const base=new Set(operation.baseValues.slots.map(row=>row.syncUid));return operation.payload.slots.filter(row=>!base.has(row.syncUid)).map(row=>row.syncUid);
}
export function referencedRatingSlotUids(operation:SyncReplayRequest):string[] {
 if(operation.operationKind==='producer.rating.set' || operation.operationKind==='entry.rating.set')return [operation.payload.slotUid];
 if(operation.operationKind==='entry.create')return operation.payload.ratings.flatMap(row=>row.slotUid===undefined?[]:[row.slotUid]);return [];
}
/** Legacy foreground metadata predates the global/update keys. An explicit
 * downgrade is always authoritative; absence only preserves those old keys.
 * Empty initial Contents historically do not require the extension on foreground. */
export async function missingForegroundMutationCapabilities(operation:SyncReplayRequest, read:(key:string)=>Promise<string|null>):Promise<string[]> {
 const missing:string[]=[];
 for(const flag of requiredMutationCapabilities(operation)) {
  // Legacy foreground exact create retries were never gated by the enqueue-only flag.
  if(flag==='offlineEntryCreate')continue;
  if(flag==='offlineMutations' && operation.operationKind==='entry.update' && await read('capability.offlineEntryUpdate')===null)continue;
  if(flag==='offlineEntryInitialContents' && operation.operationKind==='entry.create' && !operation.payload.contents?.length)continue;
  const value=await read(`capability.${flag}`);
  if(value!=='1' && !((flag==='offlineMutations' || flag==='offlineEntryUpdate' || flag==='offlineEntryCreate') && value===null))missing.push(flag);
 }
 return missing;
}
export interface MutationPlan {version:1;opId:string;ownerKey:string;order:number;requiredFlags:string[];dependencies:string[];eligible:boolean}
/** No rewriting: validate an original envelope without using Zod's normalized output. */
export function originalMutationEnvelope(row:PendingSyncOperation):SyncReplayRequest {
 const body={opId:row.opId,clientId:row.clientId,libraryId:row.libraryId,syncEpoch:row.syncEpoch,entityUid:row.entityUid,clientCreatedAt:row.clientCreatedAt,entityKind:row.entityKind,operationKind:row.operationKind,baseVersion:row.baseVersion,baseValues:row.baseValues,payload:row.payload};
 if(!syncReplayRequestSchema.safeParse(body).success)throw new Error('Unsupported original envelope');return body as SyncReplayRequest;
}
export function mutationQueuePlan(rows:PendingSyncOperation[]):Map<string,MutationPlan> {
 const result=new Map<string,MutationPlan>();const previous=new Map<string,string>();
 const parsed=new Map<string,SyncReplayRequest>();for(const row of rows){try{parsed.set(row.opId,originalMutationEnvelope(row));}catch{/* Unknown persisted envelopes stay held. */}}
 for(const [order,row] of rows.entries()) {
  const ownerKey=`${row.entityKind}:${row.entityUid.toLowerCase()}`;const operation=parsed.get(row.opId);const deps=new Set<string>();const prior=previous.get(ownerKey);if(prior)deps.add(prior);previous.set(ownerKey,row.opId);
  if(!operation){result.set(row.opId,{version:1,opId:row.opId,ownerKey,order,requiredFlags:[],dependencies:[...deps],eligible:false});continue;}
  const p=operation.payload as Record<string,unknown>;if(typeof p.parentCreateOpId==='string')deps.add(p.parentCreateOpId);
  for(const key of ['producerCreates','tagCreates','facetCreates'])if(Array.isArray(p[key]))for(const dep of p[key])deps.add((dep as {createOpId:string}).createOpId);
  const refs=referencedEntityKeys(operation).map(key=>key.toLowerCase());const slots=referencedRatingSlotUids(operation).map(uid=>uid.toLowerCase());
  for(const source of rows.slice(0,order)) {
   const op=parsed.get(source.opId);if(!op || source.clientId!==row.clientId || source.libraryId!==row.libraryId || source.syncEpoch!==row.syncEpoch)continue;
   if((operation.operationKind==='entry.delete' && referencedEntityKeys(op).map(key=>key.toLowerCase()).includes(ownerKey)) || refs.includes(`${op.entityKind}:${op.entityUid.toLowerCase()}`) || newlyCreatedRatingSlotUids(op).some(uid=>slots.includes(uid.toLowerCase())))deps.add(op.opId);
  }
  // Missing/inactive sources are never invented as applied cache proofs.
  const eligible=operation.operationKind!=='entry.media.set' && row.status==='pending' && [...deps].every(id=>rows.some(source=>source.opId.toLowerCase()===id.toLowerCase() && source.status==='pending' && result.get(source.opId)?.eligible===true && source.clientId===row.clientId && source.libraryId===row.libraryId && source.syncEpoch===row.syncEpoch));
  result.set(row.opId,{version:1,opId:row.opId,ownerKey,order,requiredFlags:requiredMutationCapabilities(operation),dependencies:[...deps],eligible});
 }
 return result;
}

