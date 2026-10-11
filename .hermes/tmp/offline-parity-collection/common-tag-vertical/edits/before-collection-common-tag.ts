import { commonTagCounts, commonTagTargets, cleanCommonTagName, normalizeTag, type CollectionCommonTagOperation, type SyncSnapshot, type SyncReplayResult } from '@t3/shared';
import type { GalleryApi } from '../api/gallery.js';
export function bulkTouchesEntry(op:{entityUid:string;operationKind:string;baseValues:unknown},uid:string|undefined):boolean {
 return op.entityUid===uid || op.operationKind==='collection.common-tag.add' && commonTagTargets(op.baseValues).some(row=>row.syncUid===uid);
}
export function applyCommonTagProjection(snapshot:SyncSnapshot,op:CollectionCommonTagOperation):SyncSnapshot {
 const p=snapshot.payload;const targets=commonTagTargets(op.baseValues);const tags=[...p.tags];
 let tag=tags.find(row=>row.syncUid?.toLowerCase()===op.payload.tagUid.toLowerCase());
 if(targets.length && !tag){
  let id=-1;while(tags.some(row=>row.id===id))id--;
  tag={id,syncUid:op.payload.tagUid,name:cleanCommonTagName(op.payload.name),normalizedName:normalizeTag(cleanCommonTagName(op.payload.name))};tags.push(tag);
 }
 const entryTags=[...p.entryTags];
 for(const row of targets){
  const entry=p.entries.find(entry=>entry.syncUid?.toLowerCase()===row.syncUid.toLowerCase());const type=op.baseValues.types.find(type=>type.entryType===row.entryType)!;
  const facet=p.tagGroups.find(facet=>facet.syncUid?.toLowerCase()===type.facetUid?.toLowerCase());
  if(!entry || !tag || !facet)throw new Error('Unknown projected common-tag identity');
  if(!entryTags.some(value=>value.entryId===entry.id && value.tagId===tag!.id))entryTags.push({entryId:entry.id,tagId:tag.id,facetId:facet.id});
 }
 return {...snapshot,payload:{...p,tags,entryTags,entries:p.entries.map(row=>({...row,...(targets.some(member=>member.syncUid===row.syncUid)?{syncVersion:op.baseValues.members.find(member=>member.syncUid===row.syncUid)!.syncVersion+1}:{})})),collections:p.collections.map(row=>({...row,...(row.syncUid===op.entityUid?{syncVersion:op.baseVersion+1}:{})}))}};
}
export function validateCommonTagReceipt(op:CollectionCommonTagOperation,receipt:Extract<SyncReplayResult,{status:'applied'}>):void {
 const proof=receipt.collectionCommonTag;const counts=commonTagCounts(op.baseValues);const expected=[{entityKind:'collection',syncUid:op.entityUid,syncVersion:op.baseVersion},...commonTagTargets(op.baseValues).map(row=>({entityKind:'entry',...row}))];
 const root=proof?.journal.find(row=>row.entityKind==='collection');
 if(receipt.opId!==op.opId || !proof || receipt.resourceVersion!==op.baseVersion+1 || root?.id!==receipt.entityId || proof.entriesAffected!==counts.entriesAffected || proof.alreadyPresent!==counts.alreadyPresent || proof.skipped!==counts.skipped || (proof.tagId===null)!==(proof.tagUid===null) || proof.tagUid!==null && proof.tagUid.toLowerCase()!==op.payload.tagUid.toLowerCase() || counts.entriesAffected>0 && proof.tagId===null || proof.journal.length!==expected.length || new Set(proof.journal.map(row=>row.entityKind+':'+row.syncUid.toLowerCase())).size!==expected.length || expected.some(owner=>!proof.journal.some(row=>row.entityKind===owner.entityKind && row.syncUid.toLowerCase()===owner.syncUid.toLowerCase() && row.resourceVersion===owner.syncVersion+1)) || receipt.serverSeq!==Math.max(...proof.journal.map(row=>row.serverSeq)))throw new Error('Invalid owned common-tag receipt/counts');
}
export async function verifyCommonTagJournal(api:GalleryApi,op:CollectionCommonTagOperation,receipt:Extract<SyncReplayResult,{status:'applied'}>,snapshot:SyncSnapshot,protocolVersion:number,clientId:string):Promise<void>{
 validateCommonTagReceipt(op,receipt);
 if(!api.fetchSyncChanges || snapshot.header.libraryId!==op.libraryId || snapshot.header.syncEpoch!==op.syncEpoch || (snapshot.header.changeSeq??-1)<receipt.serverSeq)throw new Error('Missing common-tag journal/cursor authority');
 const proof=receipt.collectionCommonTag!;const tag=snapshot.payload.tags.find(row=>row.id===proof.tagId && row.syncUid?.toLowerCase()===proof.tagUid?.toLowerCase());
 if(proof.tagId!==null && !tag)throw new Error('Missing canonical common Tag identity');
 for(const owner of proof.journal){
  const row=(owner.entityKind==='entry'?snapshot.payload.entries:snapshot.payload.collections).find(row=>row.id===owner.id && row.syncUid?.toLowerCase()===owner.syncUid.toLowerCase());
  if(!row || (row.syncVersion??0)<owner.resourceVersion)throw new Error('Missing owned common-tag snapshot revision');
  if(owner.entityKind==='entry'){
   const member=op.baseValues.members.find(member=>member.syncUid===owner.syncUid)!;const facet=op.baseValues.types.find(type=>type.entryType===member.entryType)!;
   if(!snapshot.payload.entryTags.some(value=>value.entryId===owner.id && value.tagId===proof.tagId && snapshot.payload.tagGroups.some(group=>group.id===value.facetId && group.syncUid===facet.facetUid)))throw new Error('Missing applied common-tag assignment');
  }
  const feed=await api.fetchSyncChanges({libraryId:op.libraryId,syncEpoch:op.syncEpoch,protocolVersion,clientId,afterSeq:owner.serverSeq-1,limit:1});
  if(!feed.changes.some(change=>change.seq===owner.serverSeq && change.entityKind===owner.entityKind && change.entityUid.toLowerCase()===owner.syncUid.toLowerCase() && change.resourceVersion===owner.resourceVersion && change.changeKind==='update' && change.record!==null))throw new Error('Missing specific common-tag journal');
 }
}
