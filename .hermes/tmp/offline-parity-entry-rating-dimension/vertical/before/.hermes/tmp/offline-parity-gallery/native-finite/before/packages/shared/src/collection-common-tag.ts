import { Converter } from 'opencc-js';
import { normalizeTag } from './normalize/tag.js';
import { syncCollectionCommonTagContextSchema, type SyncCollectionCommonTagContext, type SyncSnapshot, type SyncReplayRequest } from './schemas/sync.js';
const simplify=Converter({from:'t',to:'cn'});
export function cleanCommonTagName(name:string):string {return simplify(name.normalize('NFKC').trim().replace(/\s+/gu,' '));}
export type CollectionCommonTagOperation=Extract<SyncReplayRequest,{operationKind:'collection.common-tag.add'}>;
export function commonTagTargets(base:CollectionCommonTagOperation['baseValues']) {
  return base.members.filter(row=>!row.present && base.types.some(type=>type.entryType===row.entryType && type.facetUid!==null));
}
export function commonTagCounts(base:CollectionCommonTagOperation['baseValues']) {
  const entriesAffected=commonTagTargets(base).length;const alreadyPresent=base.members.filter(row=>row.present).length;
  return {entriesAffected,alreadyPresent,skipped:base.members.length-entriesAffected-alreadyPresent};
}
/** Same DISTINCT one-level membership, global per-type aggregate and numeric tie-break as production. */
export function snapshotCommonTagContext(snapshot:SyncSnapshot,id:number,name:string):SyncCollectionCommonTagContext {
 const p=snapshot.payload;const owner=p.collections.find(row=>row.id===id);if(!owner || owner.kind!=='entry')throw new Error('Missing Entry Collection');
 const children=p.collections.filter(row=>row.parentId===id);const folders=new Set([id,...children.map(row=>row.id)]);
 const ids=new Set(p.collectionMembers.flatMap(row=>folders.has(row.collectionId) && 'entryId' in row?[row.entryId]:[]));
 const normalized=normalizeTag(name);const tag=p.tags.find(row=>row.normalizedName===normalized);const canonicalTag=p.tags.find(row=>row.normalizedName===normalizeTag(cleanCommonTagName(name)));
 const members=p.entries.filter(row=>ids.has(row.id)).map(row=>({syncUid:row.syncUid,syncVersion:row.syncVersion,entryType:row.type.trim(),present:!!tag && p.entryTags.some(value=>value.entryId===row.id && value.tagId===tag.id)})).sort((a,b)=>(a.syncUid??'').localeCompare(b.syncUid??''));
 const types=[...new Set(members.map(row=>row.entryType))].sort().map(entryType=>{
  const layout=p.entryTagLayouts?.find(row=>row.entryType===entryType);const counts=new Map<number,number>();
  if(tag)for(const row of p.entryTags)if(row.tagId===tag.id && p.entries.some(entry=>entry.id===row.entryId && entry.type===entryType) && p.tagGroups.some(facet=>facet.id===row.facetId && facet.groupKind==='facet' && p.tagGroups.some(section=>section.id===facet.parentId)))counts.set(row.facetId,(counts.get(row.facetId)??0)+1);
  const placements=[...counts].map(([facetId,count])=>({facetId,count})).sort((a,b)=>b.count-a.count || a.facetId-b.facetId);
  const facet=placements.length?p.tagGroups.find(row=>row.id===placements[0]!.facetId):p.tagGroups.filter(row=>row.entryType===entryType && row.groupKind==='facet' && row.name==='').sort((a,b)=>a.id-b.id)[0];
  const section=facet?p.tagGroups.find(row=>row.id===facet.parentId && row.groupKind==='section' && row.entryType===entryType):undefined;
  if(facet && (!facet.syncUid || !section?.syncUid || !layout))throw new Error('Unknown stable common-tag layout context');
  return {entryType,layoutUid:layout?.syncUid??null,layoutVersion:layout?.syncVersion??null,facetId:facet?.id??null,facetUid:facet?.syncUid??null,sectionUid:section?.syncUid??null,placements};
 });
 return syncCollectionCommonTagContextSchema.parse({libraryId:snapshot.header.libraryId,syncEpoch:snapshot.header.syncEpoch,syncUid:owner.syncUid,syncVersion:owner.syncVersion,baseValues:{scope:{kind:owner.kind,parentUid:owner.parentId===null?null:p.collections.find(row=>row.id===owner.parentId)?.syncUid,children:children.map(row=>({syncUid:row.syncUid,syncVersion:row.syncVersion})).sort((a,b)=>(a.syncUid??'').localeCompare(b.syncUid??''))},members,types,tag:canonicalTag?{syncUid:canonicalTag.syncUid,name:canonicalTag.name,normalizedName:canonicalTag.normalizedName}:null}});
}
