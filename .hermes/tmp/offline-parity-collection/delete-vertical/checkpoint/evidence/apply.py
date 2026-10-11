from pathlib import Path
import json,hashlib
r=Path('D:/Project/TagTraceTrove');out=r/'.hermes/tmp/offline-parity-collection/delete-vertical'
baseline=json.loads((out/'before-manifest.json').read_text()); candidates={}; anchors=[]
def edit(f,old,new):
 b=candidates.get(f,(r/f).read_bytes());a=old.encode();z=new.encode();count=b.count(a)
 if count!=1:
  a=old.replace('\n','\r\n').encode();z=new.replace('\n','\r\n').encode();count=b.count(a)
 assert count==1,(f,old[:100],count)
 candidates[f]=b.replace(a,z,1);anchors.append({'path':f,'anchor':old[:100],'count':count})
sync='packages/shared/src/schemas/sync.ts'
edit(sync,'export type SyncEntryIdentity = z.infer<typeof syncEntryIdentitySchema>;','''export type SyncEntryIdentity = z.infer<typeof syncEntryIdentitySchema>;
const collectionDeleteChildSchema = z.strictObject({syncUid:syncUidSchema,syncVersion:z.number().int().positive()});
export const syncCollectionDeleteScopeSchema = z.strictObject({
  kind:z.enum(['entry','producer']),parentUid:syncUidSchema.nullable(),children:z.array(collectionDeleteChildSchema).max(200),
}).superRefine((scope,context)=>{
  if (new Set(scope.children.map(row=>row.syncUid.toLowerCase())).size !== scope.children.length
    || ((scope.kind === 'producer' || scope.parentUid !== null) && scope.children.length)) context.addIssue({code:'custom',message:'Invalid one-level Collection delete scope'});
});
export const syncCollectionIdentitySchema = syncEntryIdentitySchema.extend({scope:syncCollectionDeleteScopeSchema});
export type SyncCollectionIdentity = z.infer<typeof syncCollectionIdentitySchema>;
export const syncCollectionDeleteJournalSchema = z.strictObject({id:apiIdSchema,syncUid:syncUidSchema,resourceVersion:z.number().int().positive(),serverSeq:z.number().int().positive()});''')
edit(sync,'const syncCollectionUpdateOperationSchema = z.strictObject({','''const syncCollectionDeleteOperationSchema = z.strictObject({
  ...syncCollectionReplayBaseShape,operationKind:z.literal('collection.delete'),baseVersion:z.number().int().positive(),
  baseValues:syncCollectionDeleteScopeSchema,payload:z.strictObject({}),
}).superRefine((operation,context)=>{
  if (operation.baseValues.children.some(row=>row.syncUid.toLowerCase()===operation.entityUid.toLowerCase())) context.addIssue({code:'custom',message:'Collection cannot own itself'});
});

const syncCollectionUpdateOperationSchema = z.strictObject({''')
edit(sync,'  syncCollectionCreateOperationSchema,\n  syncCollectionEntryMembershipOperationSchema,','  syncCollectionCreateOperationSchema,\n  syncCollectionDeleteOperationSchema,\n  syncCollectionEntryMembershipOperationSchema,')
edit(sync,"    entityId: apiIdSchema.optional(),\n  }),", "    entityId: apiIdSchema.optional(),\n    collectionDeleteJournal:z.array(syncCollectionDeleteJournalSchema).min(1).max(201).optional(),\n  }),")
edit('packages/shared/src/schemas/native-mutation-contract.ts','  "collection.update": {','  "collection.delete": {"entityKind":"collection","flags":["offlineMutations","offlineCollectionManagement","offlineCollectionDelete"]},\n  "collection.update": {')
edit('apps/server/src/sync/sync-service.ts','      offlineCollectionManagement: true,','      offlineCollectionManagement: true,\n      offlineCollectionDelete: sqliteSchemaVersion >= 37,')
# Shared bounded scope resolver, used by preflight and canonical SQL inside existing receipt transaction.
f='apps/server/src/sync/collection-delete.ts'
new_server='''import { syncCollectionIdentitySchema, type SyncCollectionIdentity } from '@t3/shared';
import type { T3Database } from '../database/database.js';
import { getSyncIdentity } from './sync-service.js';
export function collectionDeleteIdentity(database:T3Database,id:number):SyncCollectionIdentity|undefined {
  const owner=database.prepare(`SELECT id,sync_uid AS syncUid,sync_version AS syncVersion,kind,parent_id AS parentId FROM collections WHERE id=?`).get(id) as {id:number;syncUid:string;syncVersion:number;kind:string;parentId:number|null}|undefined;
  if (!owner) return undefined;
  const parentUid=owner.parentId===null?null:database.prepare('SELECT sync_uid FROM collections WHERE id=?').pluck().get(owner.parentId);
  // Never truncate a destructive scope: >200 is unavailable, not a partial cascade.
  const children=database.prepare('SELECT sync_uid AS syncUid,sync_version AS syncVersion FROM collections WHERE parent_id=? ORDER BY sync_uid COLLATE NOCASE LIMIT 201').all(id);
  return syncCollectionIdentitySchema.parse({...getSyncIdentity(database),id:owner.id,syncUid:owner.syncUid,syncVersion:owner.syncVersion,scope:{kind:owner.kind,parentUid,children}});
}
'''
# Discover actual database type import from existing replay service instead of guessing module.
text=(r/'apps/server/src/sync/replay-service.ts').read_text(encoding='utf-8');import re
m=re.search(r"import type \{ T3Database \} from '([^']+)';",text);assert m
new_server=new_server.replace('../database/database.js',m.group(1));assert not (r/f).exists();candidates[f]=new_server.encode()
edit('apps/server/src/sync/replay-service.ts',"import {", "import {") if False else None
# unique prefix insertion without broad import matching
b=(r/'apps/server/src/sync/replay-service.ts').read_bytes(); candidates['apps/server/src/sync/replay-service.ts']=b"import { collectionDeleteIdentity } from './collection-delete.js';\n"+b
edit('apps/server/src/sync/replay-service.ts',"    if (operation.operationKind === 'collection.update') {",'''    if (operation.operationKind === 'collection.delete') {
      const id=database.prepare('SELECT id FROM collections WHERE sync_uid=? COLLATE NOCASE').pluck().get(operation.entityUid) as number|undefined;
      if (id===undefined) return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'failed',errorCode:'entity-not-found',detail:'Collection is absent; only the original immutable receipt proves deletion'});
      const identity=collectionDeleteIdentity(database,id)!;
      const normalized=(scope:typeof identity.scope)=>({...scope,parentUid:scope.parentUid?.toLowerCase()??null,children:scope.children.map(row=>({...row,syncUid:row.syncUid.toLowerCase()})).sort((a,b)=>a.syncUid.localeCompare(b.syncUid))});
      if (identity.syncVersion!==operation.baseVersion || JSON.stringify(normalized(identity.scope))!==JSON.stringify(normalized(operation.baseValues))) return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'conflict',currentVersion:identity.syncVersion,currentValues:{},serverSeq:maxServerSeq(database)});
      const owners=[identity,...identity.scope.children.map(child=>({id:Number(database.prepare('SELECT id FROM collections WHERE sync_uid=? COLLATE NOCASE').pluck().get(child.syncUid)),syncUid:child.syncUid,syncVersion:child.syncVersion}))];
      database.prepare('DELETE FROM collections WHERE id=?').run(id);
      const collectionDeleteJournal=owners.map(owner=>{
        const row=database.prepare("SELECT deleted_version AS resourceVersion,change_seq AS serverSeq FROM sync_tombstones WHERE entity_kind='collection' AND entity_uid=? COLLATE NOCASE").get(owner.syncUid) as {resourceVersion:number;serverSeq:number}|undefined;
        if (!row || row.resourceVersion!==owner.syncVersion+1) throw new Error('Collection cascade missing its own immutable delete journal');
        return {id:owner.id,syncUid:owner.syncUid,...row};
      });
      return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'applied',entityId:id,resourceVersion:collectionDeleteJournal[0]!.resourceVersion,serverSeq:Math.max(...collectionDeleteJournal.map(row=>row.serverSeq)),collectionDeleteJournal});
    }

    if (operation.operationKind === 'collection.update') {''')
edit('apps/server/src/http/app.ts','  syncEntryIdentitySchema,','  syncEntryIdentitySchema,\n  syncCollectionIdentitySchema,')
# import using unique registration anchor, avoiding System content
b=candidates['apps/server/src/http/app.ts'];candidates['apps/server/src/http/app.ts']=b"import { collectionDeleteIdentity } from '../sync/collection-delete.js';\n"+b
edit('apps/server/src/http/app.ts',"  app.delete('/api/collections/:collectionId', (context) => {",'''  app.get('/api/collections/:collectionId/sync-identity', (context) => {
    const {collectionId}=collectionIdParamsSchema.parse({collectionId:context.req.param('collectionId')});
    const identity=collectionDeleteIdentity(database,collectionId);
    if (!identity) return context.json(errorPayload('NOT_FOUND','Collection not found'),404);
    return context.json(syncCollectionIdentitySchema.parse(identity));
  });

  app.delete('/api/collections/:collectionId', (context) => {''')
edit('apps/web/src/api/gallery.ts','  syncEntryIdentitySchema,','  syncEntryIdentitySchema,\n  syncCollectionIdentitySchema,')
edit('apps/web/src/api/gallery.ts','  getAuthorSyncIdentity?(authorId: number): Promise<SyncEntryIdentity>;','  getAuthorSyncIdentity?(authorId: number): Promise<SyncEntryIdentity>;\n  getCollectionSyncIdentity?(collectionId:number):Promise<import(\'@t3/shared\').SyncCollectionIdentity>;')
edit('apps/web/src/api/gallery.ts','    async getAuthorSyncIdentity(authorId) {','    async getCollectionSyncIdentity(collectionId) {\n      return syncCollectionIdentitySchema.parse(await client.request(`collections/${collectionId}/sync-identity`));\n    },\n    async getAuthorSyncIdentity(authorId) {')
# facade scope via helper strict validation and journal proof
f='apps/web/src/offline/collection-delete.ts';assert not (r/f).exists()
candidates[f]='''import { syncCollectionIdentitySchema, type SyncSnapshot, type SyncCollectionIdentity, type SyncReplayRequest, type SyncReplayResult } from '@t3/shared';
import type { GalleryApi } from '../api/gallery.js';
export function snapshotCollectionIdentity(snapshot:SyncSnapshot,id:number):SyncCollectionIdentity {
  const owner=snapshot.payload.collections.find(row=>row.id===id);
  if (!owner) throw new Error('Collection deletion is not available under offline: missing saved owner');
  const parent=owner.parentId===null?null:snapshot.payload.collections.find(row=>row.id===owner.parentId)?.syncUid;
  const parsed=syncCollectionIdentitySchema.safeParse({...snapshot.header,id:owner.id,syncUid:owner.syncUid,syncVersion:owner.syncVersion,scope:{kind:owner.kind,parentUid:parent,children:snapshot.payload.collections.filter(row=>row.parentId===id).map(row=>({syncUid:row.syncUid,syncVersion:row.syncVersion})).sort((a,b)=>(a.syncUid??'').localeCompare(b.syncUid??''))}});
  // Strict identity is intentionally assembled; header contains unrelated keys.
  const result=syncCollectionIdentitySchema.safeParse({libraryId:snapshot.header.libraryId,syncEpoch:snapshot.header.syncEpoch,id:owner.id,syncUid:owner.syncUid,syncVersion:owner.syncVersion,scope:{kind:owner.kind,parentUid:parent,children:snapshot.payload.collections.filter(row=>row.parentId===id).map(row=>({syncUid:row.syncUid,syncVersion:row.syncVersion})).sort((a,b)=>(a.syncUid??'').localeCompare(b.syncUid??''))}});
  void parsed;
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
'''.encode()
f='apps/web/src/offline/offline-api.ts';b=(r/f).read_bytes();candidates[f]=b"import { snapshotCollectionIdentity, validateCollectionDeleteReceipt, verifyCollectionDeleteJournal, type CollectionDeleteOperation, type CollectionDeleteReceipt } from './collection-delete.js';\n"+b
edit(f,"    || operation.operationKind === 'collection.update'", "    || operation.operationKind === 'collection.delete'\n    || operation.operationKind === 'collection.update'")
edit(f,"  const parsed = parsedEntryOperations(operations);\n  const deletedIds =", "  const parsed = parsedEntryOperations(operations);\n  const collectionDeletes=parsed.filter((row):row is CollectionDeleteOperation=>row.operationKind==='collection.delete');\n  const deletedIds =")
edit(f,'  if (deletedProducerIds.size === 0', '  if (collectionDeletes.length === 0 && deletedProducerIds.size === 0')
edit(f,'  return {\n    ...snapshot,\n    payload: {', '''  const deletedCollectionUids=new Set(collectionDeletes.flatMap(op=>[op.entityUid,...op.baseValues.children.map(row=>row.syncUid)]).map(uid=>uid.toLowerCase()));
  const deletedCollectionIds=new Set(collections.filter(row=>row.syncUid && deletedCollectionUids.has(row.syncUid.toLowerCase())).map(row=>row.id));
  return {
    ...snapshot,
    payload: {''')
edit(f,'      collections,\n      collectionMembers: collectionMembers.filter(row => (', '      collections:collections.filter(row=>!deletedCollectionIds.has(row.id)),\n      collectionMembers: collectionMembers.filter(row => !deletedCollectionIds.has(row.collectionId) && (')
edit(f,'      const appliedOperations: SyncReplayRequest[] = [];','      const appliedOperations: SyncReplayRequest[] = [];\n      const collectionDeleteReceipts=new Map<string,CollectionDeleteReceipt>();')
edit(f,"            if (operation.operationKind === 'producer.delete') {", "            if (operation.operationKind === 'collection.delete') {\n              validateCollectionDeleteReceipt(operation,result);collectionDeleteReceipts.set(operation.entityUid,result);\n            }\n            if (operation.operationKind === 'producer.delete') {")
edit(f,'(entryDeleteReceipts.size || producerDeleteReceipts.size)', '(entryDeleteReceipts.size || producerDeleteReceipts.size || collectionDeleteReceipts.size)')
edit(f,'          const snapshot = candidate.snapshot;','''          const snapshot = candidate.snapshot;
          for (const [uid,receipt] of collectionDeleteReceipts) {
            const operation=appliedOperations.find((row):row is CollectionDeleteOperation=>row.operationKind==='collection.delete' && row.entityUid===uid)!;
            if (!candidate.acknowledgement) throw new Error('Collection deletion needs durable ACK support');
            validateCollectionDeleteReceipt(operation,receipt);
            if (snapshot.header.libraryId!==operation.libraryId || snapshot.header.syncEpoch!==operation.syncEpoch || (snapshot.header.changeSeq??-1)<receipt.serverSeq
              || receipt.collectionDeleteJournal!.some(owner=>snapshot.payload.collections.some(row=>row.id===owner.id || row.syncUid?.toLowerCase()===owner.syncUid.toLowerCase()))) throw new Error('Collection deletion needs verified owned absence/cursor');
            const proofKey='collectionDeleteProof.'+operation.opId;
            const proof=JSON.stringify({receipt,fingerprint:operationFingerprint(operations.find(row=>row.opId===operation.opId)!)});
            if (await store.readMeta(proofKey)!==proof) {
              await verifyCollectionDeleteJournal(online,operation,receipt,snapshot,candidate.acknowledgement.protocolVersion,clientId);
              await store.writeMeta(proofKey,proof);
            }
            for (const prior of appliedOperations) {
              if (prior===operation || prior.entityKind!=='collection') continue;
              const owned=receipt.collectionDeleteJournal!.find(row=>row.syncUid.toLowerCase()===prior.entityUid.toLowerCase());
              if (!owned) continue;
              const ownReceipt=appliedReceipts.get(prior.opId);
              if (!ownReceipt || appliedOperations.indexOf(prior)>=appliedOperations.indexOf(operation) || ownReceipt.serverSeq>=owned.serverSeq || ownReceipt.resourceVersion>=owned.resourceVersion) throw new Error('Collection deletion cannot settle a noncausal predecessor');
            }
          }''')
edit(f,"         for (const flag of ['offlineStandaloneAuthorDirectorySeed'", "         for (const flag of ['offlineCollectionDelete', 'offlineStandaloneAuthorDirectorySeed'")
edit(f,'    async deleteAuthor(entryId) {','''    async deleteCollection(collectionId) {
      if (!hasOutbox(store)) throw new Error('Collection deletion needs a durable local queue');
      const active=await readActiveSnapshot(store);const rows=await store.list();
      let identity:import('@t3/shared').SyncCollectionIdentity|undefined;
      if (active) {
        const projected=snapshotWithOverlays(active.snapshot,rows);
        try {identity=snapshotCollectionIdentity(projected,collectionId);} catch(cause) {if (!isOnlineMode()) throw cause;}
      }
      if (!identity) {
        if (!isOnlineMode() || !online.getCollectionSyncIdentity) throw new Error('Collection deletion is not available under offline: missing stable scope');
        await ensureClientIdentity();identity=await online.getCollectionSyncIdentity(collectionId);
        if (active && (active.snapshot.header.libraryId!==identity.libraryId || active.snapshot.header.syncEpoch!==identity.syncEpoch)) throw new Error('Collection deletion belongs to another offline library');
        if (rows.some(row=>row.libraryId!==identity!.libraryId || row.syncEpoch!==identity!.syncEpoch)) throw new Error('Retain existing queued identity');
        // Unknown baseline cannot predict the effect of attempted predecessor SQL.
        if (rows.some(row=>row.entityKind==='collection' && [identity!.syncUid,...identity!.scope.children.map(child=>child.syncUid)].includes(row.entityUid))) throw new Error('Reconcile queued Collection scope before bounded connected deletion');
      }
      if (await store.readMeta('capability.offlineMutations')!=='1' || await store.readMeta(COLLECTION_MANAGEMENT_CAPABILITY_KEY)!=='1' || await store.readMeta('capability.offlineCollectionDelete')!=='1') throw new Error('Collection deletion is not available under offline');
      if (rows.some(row=>row.operationKind==='collection.delete' && row.entityUid===identity!.syncUid)) return;
      const operation=createPendingSyncOperation({clientId,libraryId:identity.libraryId,syncEpoch:identity.syncEpoch,entityKind:'collection',entityUid:identity.syncUid,operationKind:'collection.delete',baseVersion:identity.syncVersion,baseValues:identity.scope,payload:{}},{randomUUID});
      await enqueueDurably(operation);invalidateOfflineLibrary();await setReplayStateFromStore();
      if (isOnlineMode()) await replayPendingOperations();
    },
    async deleteAuthor(entryId) {''')
f='apps/web/src/offline/sync-mutation-plan.ts'
edit(f," if(operation.operationKind==='collection.create')", " if(operation.operationKind==='collection.delete')return operation.baseValues.children.map(row=>`collection:${row.syncUid}`);\n if(operation.operationKind==='collection.create')")
f='apps/web/src/offline/pending-work-restore.ts'
edit(f,"(row.entityKind === 'entry' || row.entityKind === 'producer')", "(row.entityKind === 'entry' || row.entityKind === 'producer' || row.entityKind === 'collection')")
edit(f,"    if (union.slice(0,index).some(prior=>prior.entityKind===row.entityKind", "    if (row.entityKind==='collection' && union.slice(0,index).some(prior=>prior.operationKind==='collection.delete' && Array.isArray(prior.baseValues.children) && prior.baseValues.children.some(child=>child.syncUid?.toLowerCase()===uid(row.entityUid)))) throw new Error('A deleted Collection child cannot accept later restored edits');\n    if (union.slice(0,index).some(prior=>prior.entityKind===row.entityKind")
edit(f,"  if (op.operationKind==='collection.create' && op.payload.parentUid) {", '''  if (op.operationKind==='collection.delete') {
    const owner=payload.collections.find(row=>same(row.syncUid,op.entityUid));
    requireRef(!!owner && owner.kind===op.baseValues.kind);
    const children=payload.collections.filter(row=>row.parentId===owner?.id);
    requireRef(children.length===op.baseValues.children.length && children.every(row=>row.syncUid && row.syncVersion!==undefined && op.baseValues.children.some(child=>same(row.syncUid,child.syncUid))));
  }
  if (op.operationKind==='collection.create' && op.payload.parentUid) {''')
# Entire batch preflight, fresh full-byte CAS; no stale whole-file rewrites.
for record in baseline:
 f=record['path']; assert hashlib.sha256((r/f).read_bytes()).hexdigest()==record['sha256'],('STOP actual source drift, inspect owned region before rebasing',f)
for f,b in candidates.items():
 p=r/f;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b)
(out/'anchor-preflight.json').write_text(json.dumps(anchors,indent=2));print('Applied',len(candidates),'files with',len(anchors),'unique sequential anchors')
