import type { SyncSnapshot, SyncReplayRequest, SyncReplayResult } from '@t3/shared';
export type ConversionOperation = Extract<SyncReplayRequest,{operationKind:'entry.authors.convert-to-multi'}>;
type Applied = Extract<SyncReplayResult,{status:'applied'}>;
export function conversionCascadeOwners(snapshot:SyncSnapshot,uids:string[]):NonNullable<ConversionOperation['baseValues']['cascadeOwners']> {
  const ids=new Set(snapshot.payload.producers.filter(row=>row.syncUid && uids.includes(row.syncUid)).map(row=>row.id));
  if(!snapshot.payload.authorDirectorySets)throw new Error('Conversion needs trusted Directory owner context');
  const collectionIds=new Set(snapshot.payload.collectionMembers.flatMap(row=>'producerId' in row && ids.has(row.producerId)?[row.collectionId]:[]));
  return [...snapshot.payload.authorDirectorySets.filter(row=>ids.has(row.producerId)).map(row=>({entityKind:'author_directory_set' as const,entityUid:row.syncUid,version:row.syncVersion})),
    ...snapshot.payload.collections.filter(row=>collectionIds.has(row.id)).map(row=>{
      if(!row.syncUid || !row.syncVersion)throw new Error('Conversion needs trusted Collection owner context');
      return {entityKind:'collection' as const,entityUid:row.syncUid,version:row.syncVersion};
    })];
}
/** Pure affected-only Online unlink/prune semantics; no persisted snapshot writes. */
export function projectConversion(snapshot:SyncSnapshot,op:ConversionOperation,targetId:number):SyncSnapshot {
  const result=structuredClone(snapshot),p=result.payload;
  const entry=p.entries.find(row=>row.syncUid===op.entityUid);
  if(!entry)throw new Error('Conversion owner missing');
  let target=p.producers.find(row=>row.syncUid===op.payload.targetUid);
  if(!target){
    if(p.producers.some(row=>row.id===targetId))throw new Error('Conversion target ID collision');
    target={id:targetId,syncUid:op.payload.targetUid,syncVersion:1,name:'multiple author',occupation:null,artworkRef:null,content:null,galleryAnchor:null};p.producers.push(target);
  }
  const affected=new Set(op.baseValues.authors.filter(row=>row.producerUid!==op.payload.targetUid).flatMap(author=>p.producers.filter(row=>row.syncUid===author.producerUid).map(row=>row.id)));
  p.entryProducers=p.entryProducers.filter(row=>row.entryId!==entry.id);
  p.entryProducers.push({entryId:entry.id,producerId:target.id});
  const pruned=new Set([...affected].filter(id=>!p.entryProducers.some(row=>row.producerId===id)));
  const heldTags=new Set(p.producerTagAssignments.filter(row=>affected.has(row.producerId)).map(row=>row.tagId));
  const deletedDirs=new Set(p.authorDirectories.filter(row=>pruned.has(row.producerId)).map(row=>row.id));
  p.producers=p.producers.filter(row=>!pruned.has(row.id));
  p.producerTagAssignments=p.producerTagAssignments.filter(row=>!pruned.has(row.producerId));
  p.producerTags=p.producerTags.filter(row=>!heldTags.has(row.id)||p.producerTagAssignments.some(a=>a.tagId===row.id));
  p.producerRatingValues=p.producerRatingValues.filter(row=>!pruned.has(row.producerId));
  p.viewLaterProducers=p.viewLaterProducers.filter(row=>!pruned.has(row.subjectId));
  p.authorDirectories=p.authorDirectories.filter(row=>!pruned.has(row.producerId));
  p.authorDirectorySets=p.authorDirectorySets?.filter(row=>!pruned.has(row.producerId));
  p.authorDirectoryEntries=p.authorDirectoryEntries.filter(row=>!deletedDirs.has(row.directoryId)&&!pruned.has(row.producerId)&&!(affected.has(row.producerId)&&row.entryId===entry.id));
  p.collectionMembers=p.collectionMembers.filter(row=>!('producerId' in row && pruned.has(row.producerId)));
  return result;
}
export function verifyConversionSnapshot(snapshot:SyncSnapshot,op:ConversionOperation,receipt:Applied):void {
  const fail=()=>{throw new Error('Conversion snapshot lacks exact owned identity/revision/cascade proof');};
  const p=snapshot.payload,dto=receipt.conversion,journal=receipt.conversionJournal;
  if(receipt.opId!==op.opId || !dto || dto.entryId!==receipt.entityId || !journal?.length || journal.at(-1)?.seq!==receipt.serverSeq || snapshot.header.libraryId!==op.libraryId || snapshot.header.syncEpoch!==op.syncEpoch || (snapshot.header.changeSeq??-1)<receipt.serverSeq)fail();
  if(!dto || !journal)return;
  const entry=p.entries.find(row=>row.syncUid===op.entityUid),target=p.producers.find(row=>row.syncUid===op.payload.targetUid);
  if(!entry || entry.id!==dto.entryId || entry.syncVersion!==receipt.resourceVersion || !target || target.id!==dto.multiAuthorId || target.name.replace(/[A-Z]/g,c=>c.toLowerCase())!=='multiple author')fail();
  if(!entry || !target)return;
  if(p.entryProducers.filter(row=>row.entryId===entry.id).length!==1 || !p.entryProducers.some(row=>row.entryId===entry.id&&row.producerId===target.id))fail();
  if(!journal.some(row=>row.entityKind==='entry' && row.entityUid===op.entityUid && row.resourceVersion===receipt.resourceVersion && row.changeKind==='update'))fail();
  for(const author of op.baseValues.authors){
    if(author.producerUid===op.payload.targetUid)continue;
    const remaining=author.workUids.filter(uid=>uid!==op.entityUid).sort(),owner=p.producers.find(row=>row.syncUid===author.producerUid);
    const converted=dto.convertedAuthors.find(row=>row.name===author.name);
    if(!converted)fail();
    if(!remaining.length){
      if(owner || !journal.some(row=>row.entityKind==='producer'&&row.entityUid===author.producerUid&&row.changeKind==='delete'))fail();
      const id=converted!.id;
      if(p.producerRatingValues.some(row=>row.producerId===id)||p.producerTagAssignments.some(row=>row.producerId===id)||p.viewLaterProducers.some(row=>row.subjectId===id)||p.authorDirectories.some(row=>row.producerId===id)||p.authorDirectorySets?.some(row=>row.producerId===id)||p.authorDirectoryEntries.some(row=>row.producerId===id)||p.collectionMembers.some(row=>'producerId' in row&&row.producerId===id))fail();
    }else{
      const latest=journal.filter(row=>row.entityKind==='producer'&&row.entityUid===author.producerUid).at(-1);
      if(!owner || owner.id!==converted!.id || owner.syncVersion!==(latest?.resourceVersion??author.version))fail();
      if(owner){const actual=p.entryProducers.filter(row=>row.producerId===owner.id).map(row=>p.entries.find(e=>e.id===row.entryId)?.syncUid).sort();if(JSON.stringify(actual)!==JSON.stringify(remaining))fail();}
    }
  }
  for(const context of op.baseValues.cascadeOwners??[]){
    const latest=journal.filter(row=>row.entityKind===context.entityKind&&row.entityUid===context.entityUid).at(-1);
    const owner=context.entityKind==='collection'?p.collections.find(row=>row.syncUid===context.entityUid):p.authorDirectorySets?.find(row=>row.syncUid===context.entityUid);
    if(latest?.changeKind==='delete'){if(owner)fail();}
    else if(!owner || owner.syncVersion!==(latest?.resourceVersion??context.version))fail();
  }
}
