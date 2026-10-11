import { syncCollectionCommonTagContextSchema, normalizeTag, type SyncCollectionCommonTagContext, type CollectionCommonTagOperation, commonTagTargets, commonTagCounts, cleanCommonTagName } from '@t3/shared';
import type { T3Database } from '../database/connection.js';
import { collectionDeleteIdentity } from './collection-delete.js';
import { assignEntryTag } from '../repositories/entry-tag-repository.js';
export function collectionCommonTagContext(db:T3Database,id:number,name:string):SyncCollectionCommonTagContext {
 return db.transaction(()=>{
  const owner=collectionDeleteIdentity(db,id);if(!owner || owner.scope.kind!=='entry')throw new Error('Missing Entry Collection');
  const tag=db.prepare('SELECT sync_uid AS syncUid,name,normalized_name AS normalizedName FROM tags WHERE normalized_name=?').get(normalizeTag(name)) as SyncCollectionCommonTagContext['baseValues']['tag']|undefined;
  const members=db.prepare(`SELECT DISTINCT e.sync_uid AS syncUid,e.sync_version AS syncVersion,trim(e.type) AS entryType,EXISTS(SELECT 1 FROM entry_tags a JOIN tags t ON t.id=a.tag_id WHERE a.entry_id=e.id AND t.normalized_name=?) AS present FROM entries e JOIN collection_entries m ON m.entry_id=e.id WHERE m.collection_id IN (SELECT id FROM collections WHERE id=? OR parent_id=?) ORDER BY e.sync_uid LIMIT 2001`).all(normalizeTag(name),id,id) as Array<{syncUid:string;syncVersion:number;entryType:string;present:number}>;
  const types=[...new Set(members.map(row=>row.entryType))].sort().map(entryType=>{
   const layout=db.prepare('SELECT sync_uid AS layoutUid,sync_version AS layoutVersion FROM entry_tag_layouts WHERE entry_type=?').get(entryType) as {layoutUid:string;layoutVersion:number}|undefined;
   const placements=db.prepare(`SELECT a.facet_id AS facetId,count(*) AS count FROM entry_tags a JOIN entries e ON e.id=a.entry_id JOIN tags t ON t.id=a.tag_id JOIN tag_groups f ON f.id=a.facet_id JOIN tag_groups s ON s.id=f.parent_id WHERE e.type=? AND t.normalized_name=? GROUP BY a.facet_id ORDER BY count DESC,a.facet_id LIMIT 2001`).all(entryType,normalizeTag(name)) as Array<{facetId:number;count:number}>;
   const facet=placements[0]?db.prepare("SELECT f.id AS facetId,f.sync_uid AS facetUid,s.sync_uid AS sectionUid FROM tag_groups f JOIN tag_groups s ON s.id=f.parent_id WHERE f.id=? AND f.entry_type=? AND s.entry_type=? AND f.group_kind='facet' AND s.group_kind='section'").get(placements[0].facetId,entryType,entryType):db.prepare("SELECT f.id AS facetId,f.sync_uid AS facetUid,s.sync_uid AS sectionUid FROM tag_groups f JOIN tag_groups s ON s.id=f.parent_id WHERE f.entry_type=? AND f.group_kind='facet' AND f.name='' AND s.entry_type=? AND s.group_kind='section' ORDER BY f.id LIMIT 1").get(entryType,entryType);
   if(placements.length && !facet)throw new Error('Invalid majority layout');
   return {entryType,layoutUid:layout?.layoutUid??null,layoutVersion:layout?.layoutVersion??null,facetId:null,facetUid:null,sectionUid:null,...(facet as object??{}),placements};
  });
  return syncCollectionCommonTagContextSchema.parse({libraryId:owner.libraryId,syncEpoch:owner.syncEpoch,syncUid:owner.syncUid,syncVersion:owner.syncVersion,baseValues:{scope:owner.scope,members:members.map(row=>({...row,present:row.present===1})),types,tag:tag??null}});
 })();
}
export function applyCollectionCommonTag(db:T3Database,id:number,op:CollectionCommonTagOperation) {
 const targets=commonTagTargets(op.baseValues);const normalized=normalizeTag(cleanCommonTagName(op.payload.name));
 const existing=db.prepare('SELECT id,sync_uid AS syncUid FROM tags WHERE normalized_name=?').get(normalized) as {id:number;syncUid:string}|undefined;
 // A concurrent canonical spelling/UID collision must not be silently reassigned.
 if(existing && existing.syncUid.toLowerCase()!==op.payload.tagUid.toLowerCase())throw new Error('Canonical Tag UID collision');
 if(!existing && db.prepare('SELECT 1 FROM tags WHERE sync_uid=? COLLATE NOCASE').get(op.payload.tagUid))throw new Error('Foreign Tag UID');
 if(targets.length && !existing)db.prepare('INSERT INTO tags(name,normalized_name,sync_uid) VALUES(?,?,?)').run(cleanCommonTagName(op.payload.name),normalized,op.payload.tagUid);
 const journal=[];
 for(const member of targets){
  const entryId=Number(db.prepare('SELECT id FROM entries WHERE sync_uid=? COLLATE NOCASE').pluck().get(member.syncUid));
  const facet=op.baseValues.types.find(row=>row.entryType===member.entryType)!;
  assignEntryTag(db,{entryId,facetId:facet.facetId!,name:op.payload.name});
  const row=db.prepare("SELECT seq AS serverSeq,resource_version AS resourceVersion FROM sync_changes WHERE entity_kind='entry' AND entity_uid=? COLLATE NOCASE ORDER BY seq DESC LIMIT 1").get(member.syncUid) as {serverSeq:number;resourceVersion:number};
  if(row.resourceVersion!==member.syncVersion+1)throw new Error('Incorrect bulk Entry revision');
  journal.push({entityKind:'entry' as const,id:entryId,syncUid:member.syncUid,...row});
 }
 db.prepare('UPDATE collections SET sync_version=sync_version+1 WHERE id=?').run(id);
 const root=db.prepare("SELECT seq AS serverSeq,resource_version AS resourceVersion FROM sync_changes WHERE entity_kind='collection' AND entity_uid=? COLLATE NOCASE ORDER BY seq DESC LIMIT 1").get(op.entityUid) as {serverSeq:number;resourceVersion:number};
 if(root.resourceVersion!==op.baseVersion+1)throw new Error('Incorrect bulk root revision');
 journal.push({entityKind:'collection' as const,id,syncUid:op.entityUid,...root});
 const tag=db.prepare('SELECT id,sync_uid AS syncUid FROM tags WHERE normalized_name=?').get(normalized) as {id:number;syncUid:string}|undefined;
 return {tagId:tag?.id??null,tagUid:tag?.syncUid??null,...commonTagCounts(op.baseValues),journal};
}
