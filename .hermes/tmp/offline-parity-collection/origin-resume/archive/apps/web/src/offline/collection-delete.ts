import { syncCollectionIdentitySchema, type SyncSnapshot, type SyncCollectionIdentity, type SyncReplayRequest, type SyncReplayResult } from '@t3/shared';
import type { GalleryApi } from '../api/gallery.js';
export function snapshotCollectionIdentity(snapshot:SyncSnapshot,id:number,origins:readonly SyncReplayRequest[]=[],clientId?:string):SyncCollectionIdentity {
  const owner=snapshot.payload.collections.find(row=>row.id===id);
  if (!owner) throw new Error('Collection deletion is not available under offline: missing saved owner');
  const parent=owner.parentId===null?null:snapshot.payload.collections.find(row=>row.id===owner.parentId)?.syncUid;
  // Old missing stable child identity remains unknown, never an empty cascade.
  const result=syncCollectionIdentitySchema.safeParse({libraryId:snapshot.header.libraryId,syncEpoch:snapshot.header.syncEpoch,id:owner.id,syncUid:owner.syncUid,syncVersion:owner.syncVersion,scope:{kind:owner.kind,parentUid:parent,children:snapshot.payload.collections.filter(row=>row.parentId===id).map(row=>({syncUid:row.syncUid,syncVersion:row.syncVersion})).sort((a,b)=>(a.syncUid??'').localeCompare(b.syncUid??''))}});
  const localRows=[owner,...snapshot.payload.collections.filter(row=>row.parentId===id)].filter(row=>row.id<0);
  if (localRows.length && clientId && [owner,...snapshot.payload.collections.filter(row=>row.parentId===id)].every(row=>row.id>0 || origins.some(origin=>origin.operationKind==='collection.create' && origin.clientId===clientId && origin.libraryId===snapshot.header.libraryId && origin.syncEpoch===snapshot.header.syncEpoch && origin.entityUid===row.syncUid && origin.baseVersion===0 && origin.payload.kind===row.kind && origin.payload.parentUid===(row.parentId===null?null:snapshot.payload.collections.find(parent=>parent.id===row.parentId)?.syncUid)))) {
    // The negative number is a local projection key, never a server identity.
    const local=syncCollectionIdentitySchema.omit({id:true}).safeParse({libraryId:snapshot.header.libraryId,syncEpoch:snapshot.header.syncEpoch,syncUid:owner.syncUid,syncVersion:owner.syncVersion,scope:{kind:owner.kind,parentUid:parent,children:snapshot.payload.collections.filter(row=>row.parentId===id).map(row=>({syncUid:row.syncUid,syncVersion:row.syncVersion})).sort((a,b)=>(a.syncUid??'').localeCompare(b.syncUid??''))}});
    if (local.success) return {...local.data,id:owner.id};
  }
  if (localRows.length) throw new Error('Collection deletion needs validated same-device create origins');
  if (!result.success) throw new Error('Collection deletion is not available under offline: unknown child identity/scope');
  return result.data;
}
export type CollectionDeleteOperation=Extract<SyncReplayRequest,{operationKind:'collection.delete'}>;
export type CollectionDeleteReceipt=Extract<SyncReplayResult,{status:'applied'}>;
export function validateCollectionDeleteReceipt(operation:CollectionDeleteOperation,result:CollectionDeleteReceipt):void {
  const journal=result.collectionDeleteJournal;
  const expected=[{syncUid:operation.entityUid,syncVersion:operation.baseVersion},...operation.baseValues.children];
  if (result.opId!==operation.opId || !journal || journal.length!==expected.length || new Set(journal.map(row=>row.syncUid.toLowerCase())).size!==journal.length
    || expected.some(owner=>!journal.some(row=>row.syncUid.toLowerCase()===owner.syncUid.toLowerCase() && row.resourceVersion===owner.syncVersion+1))
    || journal[0]?.id!==result.entityId || journal[0]?.syncUid.toLowerCase()!==operation.entityUid.toLowerCase()
    || result.resourceVersion!==operation.baseVersion+1 || result.serverSeq!==Math.max(...journal.map(row=>row.serverSeq))) throw new Error('Collection deletion receipt has foreign or missing owned scope');
}
export async function verifyCollectionDeleteJournal(online:GalleryApi,operation:CollectionDeleteOperation,receipt:CollectionDeleteReceipt,snapshot:SyncSnapshot,protocolVersion:number,clientId:string):Promise<void> {
  validateCollectionDeleteReceipt(operation,receipt);
  if (snapshot.header.libraryId!==operation.libraryId || snapshot.header.syncEpoch!==operation.syncEpoch || (snapshot.header.changeSeq??-1)<receipt.serverSeq
    || receipt.collectionDeleteJournal!.some(owner=>snapshot.payload.collections.some(row=>row.syncUid?.toLowerCase()===owner.syncUid.toLowerCase() || row.id===owner.id)) || !online.fetchSyncChanges) throw new Error('Collection deletion needs verified absence/cursor and journal authority');
  for (const owner of receipt.collectionDeleteJournal!) {
    const proof=await online.fetchSyncChanges({libraryId:operation.libraryId,syncEpoch:operation.syncEpoch,protocolVersion,clientId,afterSeq:owner.serverSeq-1,limit:1});
    if (!proof.changes.some(row=>row.seq===owner.serverSeq && row.entityKind==='collection' && row.entityUid.toLowerCase()===owner.syncUid.toLowerCase() && row.changeKind==='delete' && row.resourceVersion===owner.resourceVersion && row.record===null)) throw new Error('Collection deletion needs matching owned delete journal');
  }
}
