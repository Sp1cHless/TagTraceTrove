from pathlib import Path
import hashlib,json
root=Path('.'); start=root/'.hermes/tmp/offline-parity-author/directory-seed-start'; changes=[]
def edit(p,old,new):
 path=root/p; existing=next((c for c in changes if c[0]==path),None);b=existing[2] if existing else path.read_bytes();o=old.encode();n=new.encode()
 if b.count(o)!=1:
  o=old.replace('\n','\r\n').encode();n=new.replace('\n','\r\n').encode()
 assert b.count(o)==1,(p,old[:80],b.count(o))
 if existing: changes.remove(existing)
 changes.append((path,existing[1] if existing else b,b.replace(o,n)))
def new(p,s):
 path=root/p;assert not path.exists();changes.append((path,None,s.encode()))
sync='packages/shared/src/schemas/sync.ts'
edit(sync,'artworkRef: z.string().nullable(), content: z.string().nullable() }),','artworkRef: z.string().nullable(), content: z.string().nullable(), directorySetUid: syncUidSchema.optional() }),')
edit(sync,'payload: z.strictObject({ directories: syncProducerDirectoryListSchema }),','payload: z.strictObject({ directories: syncProducerDirectoryListSchema, producerCreates: z.array(z.strictObject({producerUid: syncUidSchema, createOpId: syncUidSchema})).length(1).optional() }),')
# Preserve scope identity by supplying it at the original INSERT, never UPDATE an immutable set.
migration='''-- New standalone creates may pre-supply an independent Directory-set identity.
ALTER TABLE producers ADD COLUMN directory_set_seed_uid TEXT;
CREATE TRIGGER producers_directory_seed_immutable
BEFORE UPDATE OF directory_set_seed_uid ON producers
WHEN NEW.directory_set_seed_uid IS NOT OLD.directory_set_seed_uid
BEGIN SELECT RAISE(ABORT, 'Directory seed is immutable'); END;
DROP TRIGGER producers_directory_set_insert;
CREATE TRIGGER producers_directory_set_insert
AFTER INSERT ON producers
BEGIN
 INSERT INTO author_directory_sets (producer_id, sync_uid, sync_version)
 VALUES (NEW.id, COALESCE(NEW.directory_set_seed_uid,
 lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
 substr(lower(hex(randomblob(2))), 2) || '-' ||
 substr('89ab', 1 + abs(random()) % 4, 1) ||
 substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))), 1);
END;
CREATE TRIGGER author_directory_sets_sync_insert
AFTER INSERT ON author_directory_sets
BEGIN
 INSERT INTO sync_changes (entity_kind,entity_uid,change_kind,resource_version,record_json)
 VALUES ('author_directory_set',NEW.sync_uid,'create',NEW.sync_version,
 json_object('id',NEW.id,'producerId',NEW.producer_id,'syncUid',NEW.sync_uid,'syncVersion',NEW.sync_version));
END;
'''
new('apps/server/src/database/migrations/042_standalone_author_directory_seed.sql',migration)
edit('apps/server/src/sync/sync-service.ts','offlineStandaloneAuthorCreate: sqliteSchemaVersion >= 33,','offlineStandaloneAuthorCreate: sqliteSchemaVersion >= 33,\n      offlineStandaloneAuthorDirectorySeed: sqliteSchemaVersion >= 42,')
p='apps/server/src/sync/replay-service.ts'
edit(p,"const id = Number(database.prepare('INSERT INTO producers (name, occupation, artwork_ref, content, sync_uid) VALUES (?, ?, ?, ?, ?)')\n        .run(operation.payload.name, operation.payload.occupation, operation.payload.artworkRef, operation.payload.content, operation.entityUid).lastInsertRowid);", """if (operation.payload.directorySetUid !== undefined && (operation.payload.directorySetUid === operation.entityUid || database.prepare('SELECT 1 FROM author_directory_sets WHERE sync_uid = ? COLLATE NOCASE').get(operation.payload.directorySetUid))) {
        return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'failed',errorCode:'entity-already-exists',detail:'Directory-set UUID is already owned or is not independent'});
      }
      const id = Number(database.prepare('INSERT INTO producers (name, occupation, artwork_ref, content, sync_uid, directory_set_seed_uid) VALUES (?, ?, ?, ?, ?, ?)')
        .run(operation.payload.name, operation.payload.occupation, operation.payload.artworkRef, operation.payload.content, operation.entityUid, operation.payload.directorySetUid ?? null).lastInsertRowid);""")
edit(p,'const producerId = directorySet.producerId;\n      const currentDirectories',"""const producerId = directorySet.producerId;
      for (const dependency of operation.payload.producerCreates ?? []) {
        const origin = database.prepare(`SELECT origin.producer_id AS producerId, receipt.result_json AS resultJson
          FROM sync_offline_created_producers AS origin
          JOIN producers AS producer ON producer.id=origin.producer_id AND producer.sync_uid=origin.producer_uid COLLATE NOCASE
          JOIN sync_operation_receipts AS receipt ON receipt.op_id=origin.create_op_id COLLATE NOCASE
          WHERE origin.producer_uid=? COLLATE NOCASE AND origin.create_op_id=? COLLATE NOCASE AND origin.client_id=? AND origin.library_id=? AND origin.sync_epoch=? AND producer.directory_set_seed_uid=? COLLATE NOCASE`)
          .get(dependency.producerUid,dependency.createOpId,operation.clientId,operation.libraryId,operation.syncEpoch,operation.entityUid) as {producerId:number;resultJson:string}|undefined;
        const receipt = origin ? syncReplayResultSchema.parse(JSON.parse(origin.resultJson)) : undefined;
        if (!origin || origin.producerId!==producerId || receipt?.status!=='applied' || receipt.opId.toLowerCase()!==dependency.createOpId.toLowerCase() || receipt.entityId!==producerId) return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'failed',errorCode:'entity-not-found',detail:'Directory creation origin is missing or foreign'});
      }
      const currentDirectories""")
p='apps/web/src/offline/offline-api.ts'
edit(p,"for (const flag of ['offlineAuthorDelete',", "for (const flag of ['offlineStandaloneAuthorDirectorySeed', 'offlineAuthorDelete',")
edit(p,"const payload = {name:input.name.trim(),occupation:input.occupation ?? null,artworkRef:input.artworkRef ?? null,content:input.content ?? null};", "const payload = {name:input.name.trim(),occupation:input.occupation ?? null,artworkRef:input.artworkRef ?? null,content:input.content ?? null,...(await store.readMeta('capability.offlineStandaloneAuthorDirectorySeed') === '1' ? {directorySetUid:randomUUID().toLowerCase()} : {})};")
edit(p,'const authorDirectoryEntries = snapshot.payload.authorDirectoryEntries.map((membership) => ({ ...membership }));',"""for (const create of producerCreates) {
    if (create.payload.directorySetUid === undefined) continue;
    const producer = producers.find(row=>row.syncUid===create.entityUid)!;
    const known = authorDirectorySets.find(row=>row.syncUid===create.payload.directorySetUid || row.producerId===producer.id);
    if (known && (known.syncUid!==create.payload.directorySetUid || known.producerId!==producer.id)) throw new Error('Directory seed identity collision');
    if (!known) authorDirectorySets.push({producerId:producer.id,syncUid:create.payload.directorySetUid,syncVersion:1});
  }
  const authorDirectoryEntries = snapshot.payload.authorDirectoryEntries.map((membership) => ({ ...membership }));""")
edit(p,"const original = active?.snapshot.payload.producers.find((producer) => producer.id === authorId);\n    if (active === null || original === undefined)","const original = active === null ? undefined : snapshotWithOverlays(active.snapshot,(await store.list()).filter(row=>row.operationKind==='producer.create' && row.clientId===clientId && row.libraryId===active.snapshot.header.libraryId && row.syncEpoch===active.snapshot.header.syncEpoch)).payload.producers.find((producer) => producer.id === authorId);\n    if (active === null || original === undefined)")
edit(p,'const baseDirectories = producerDirectoriesFromSnapshot(projected, authorId);',"""const creator = operations.find(row=>row.operationKind==='producer.create' && row.entityUid===original.syncUid && row.payload.directorySetUid===directorySet.syncUid && row.clientId===clientId && row.libraryId===active.snapshot.header.libraryId && row.syncEpoch===active.snapshot.header.syncEpoch);
    if (creator && (creator.status!=='pending' || await store.readMeta('capability.offlineStandaloneAuthorDirectorySeed')!=='1')) throw new Error('Directory editing is not available under offline; refresh metadata or reconcile the original Author create');
    const baseDirectories = producerDirectoriesFromSnapshot(projected, authorId);""")
edit(p,'payload: { directories: desiredDirectories },','payload: { directories: desiredDirectories, ...(creator ? {producerCreates:[{producerUid:creator.entityUid,createOpId:creator.opId}]} : {}) },')
# For replay use only scoped original creates as trusted scope supplier, not arbitrary raw payloads.
edit(p,'const active = activeBeforeReplay?.snapshot;\n        const set = active?.payload.authorDirectorySets?',"const baseline = activeBeforeReplay?.snapshot;\n        const active = baseline ? snapshotWithOverlays(baseline,operations.filter(source=>source.operationKind==='producer.create' && source.clientId===row.clientId && source.libraryId===row.libraryId && source.syncEpoch===row.syncEpoch)) : undefined;\n        const set = active?.payload.authorDirectorySets?")
edit(p,'profiles.set(op.entityUid,{...profiles.get(op.entityUid),...op.payload});',"const {directorySetUid,...profile} = op.payload as typeof op.payload & {directorySetUid?:string}; void directorySetUid;\n            profiles.set(op.entityUid,{...profiles.get(op.entityUid),...profile});")
# Reconcile local negative IDs to authoritative numeric identity for Directory receipts.
edit(p,'if (!set || set.producerId !== scope.producerId || set.syncVersion < receipt.resourceVersion',"const scopeOwner = snapshot.payload.producers.find(row=>row.syncUid===scope.producerUid);\n              if (!set || set.producerId !== scopeOwner?.id || set.syncVersion < receipt.resourceVersion")
edit(p,'producerDirectoriesFromSnapshot(snapshot,scope.producerId)','producerDirectoriesFromSnapshot(snapshot,set.producerId)')
# Verify supplied seed separately from profile fields at snapshot barrier.
edit(p,"const durations = new Map<string, number | null>();", """for (const op of appliedOperations) if (op.operationKind==='producer.create' && op.payload.directorySetUid!==undefined && !settledBeforeProducerDelete(op)) {
            const owner=snapshot.payload.producers.find(row=>row.syncUid===op.entityUid);
            if (!owner || !snapshot.payload.authorDirectorySets?.some(set=>set.producerId===owner.id && set.syncUid===op.payload.directorySetUid)) throw new Error('Snapshot refresh failed: independent Directory seed identity is missing');
          }
          const durations = new Map<string, number | null>();""")
# Conditional requirements remain field-presence based, never change legacy base flags.
p='packages/shared/src/schemas/native-mutation-contract.ts'
edit(p,'"producer.create": { "entityKind": "producer", "flags": ["offlineMutations", "offlineStandaloneAuthorCreate"] }','"producer.create": { "entityKind": "producer", "flags": ["offlineMutations", "offlineStandaloneAuthorCreate"], "fieldFlags": {"directorySetUid":"offlineStandaloneAuthorDirectorySeed"} }')
edit('apps/web/src/offline/sync-mutation-plan.ts',"if((operation.operationKind==='entry.update'", "if(operation.operationKind==='producer.create' && Object.hasOwn(p,'directorySetUid'))add('offlineStandaloneAuthorDirectorySeed');\n if(operation.operationKind==='author.directories.set' && Object.hasOwn(p,'producerCreates'))add('offlineStandaloneAuthorDirectorySeed');\n if((operation.operationKind==='entry.update'")
p='spikes/001-android-webview-shell/android/app/src/main/java/com/speechless666/t3/spike/NativeMutationPlan.java'
edit(p,'if((kind.equals("entry.update")', 'if(kind.equals("producer.create") && p.has("directorySetUid"))add(result,"offlineStandaloneAuthorDirectorySeed");\n  if(kind.equals("author.directories.set") && p.has("producerCreates"))add(result,"offlineStandaloneAuthorDirectorySeed");\n  if((kind.equals("entry.update")')
p='apps/web/src/offline/pending-work-restore.ts'
edit(p,"['author_directory_set', new Set(payload.authorDirectorySets?.map(row=>uid(row.syncUid)) ?? [])]", "['author_directory_set', new Set([...(payload.authorDirectorySets?.map(row=>uid(row.syncUid)) ?? []),...union.flatMap(row=>row.operationKind==='producer.create' && typeof row.payload.directorySetUid==='string' ? [uid(row.payload.directorySetUid)] : [])])]")
edit(p,'requireRef(!!set && payload.producers.some(row=>row.id===set.producerId));',"""const creator = prior.find(row=>row.operationKind==='producer.create' && typeof row.payload.directorySetUid==='string' && same(row.payload.directorySetUid,op.entityUid));
    requireRef((!!set && payload.producers.some(row=>row.id===set.producerId)) || !!creator);
    if (creator) requireRef(op.payload.producerCreates?.some(dep=>same(creator.entityUid,dep.producerUid) && same(creator.opId,dep.createOpId))===true);""")
edit(p,'requireRef(!!owner && payload.entryProducers.some(row=>row.entryId===owner.id && row.producerId===set?.producerId));',"requireRef(!!owner && (payload.entryProducers.some(row=>row.entryId===owner.id && row.producerId===set?.producerId) || !!creator && prior.some(row=>row.operationKind==='entry.authors.set' && same(row.entityUid,member.syncUid) && Array.isArray(row.payload.producerUids) && row.payload.producerUids.includes(creator.entityUid))));")
# Preflight all before ANY write; backup full bytes for new ledger additions too.
for path,b,n in changes:
 assert (path.read_bytes() if path.exists() else None)==b,path
 q=start/path
 if b is not None and not q.exists():q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b)
for path,b,n in changes:path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(n)
(root/'.hermes/tmp/offline-parity-author/seed-edit-ledger.json').write_text(json.dumps({str(p):{'before':hashlib.sha256(b).hexdigest() if b is not None else None,'after':hashlib.sha256(n).hexdigest()} for p,b,n in changes},indent=2))
print('applied',len(changes),'targeted edits')
