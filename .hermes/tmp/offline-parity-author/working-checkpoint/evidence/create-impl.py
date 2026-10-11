from guard import *
f='packages/shared/src/schemas/sync.ts'
edit(f,"const syncProducerReplayBaseShape = {","""const syncProducerCreateOperationSchema = z.strictObject({
  ...syncReplayBaseShape, entityKind: z.literal('producer'), operationKind: z.literal('producer.create'),
  baseVersion: z.literal(0), baseValues: z.strictObject({}),
  payload: z.strictObject({ name: z.string().trim().min(1), occupation: z.string().nullable(),
    artworkRef: z.string().nullable(), content: z.string().nullable() }),
});

const syncProducerReplayBaseShape = {""")
edit(f,'  syncProducerUpdateOperationSchema,','  syncProducerCreateOperationSchema,\n  syncProducerUpdateOperationSchema,')
f='packages/shared/src/schemas/native-mutation-contract.ts'
edit(f,'  "producer.update": {','  "producer.create": { "entityKind": "producer", "flags": ["offlineMutations", "offlineStandaloneAuthorCreate"] },\n  "producer.update": {')
f='apps/server/src/sync/sync-service.ts'
edit(f,'      offlineAuthorCreate: sqliteSchemaVersion >= 29,','      offlineAuthorCreate: sqliteSchemaVersion >= 29,\n      offlineStandaloneAuthorCreate: sqliteSchemaVersion >= 33,')
f='apps/server/src/sync/replay-service.ts'
edit(f,"    if (operation.operationKind === 'producer.view-later.set') {","""    if (operation.operationKind === 'producer.create') {
      if (database.prepare('SELECT id FROM producers WHERE sync_uid = ? COLLATE NOCASE').get(operation.entityUid)) {
        return saveReceipt(database, operation, requestHash, {opId:operation.opId,status:'failed',errorCode:'entity-already-exists',detail:'Author UUID is already owned'});
      }
      const id = Number(database.prepare('INSERT INTO producers (name, occupation, artwork_ref, content, sync_uid) VALUES (?, ?, ?, ?, ?)')
        .run(operation.payload.name, operation.payload.occupation, operation.payload.artworkRef, operation.payload.content, operation.entityUid).lastInsertRowid);
      database.prepare('INSERT INTO sync_offline_created_producers (producer_uid, producer_id, create_op_id, client_id, library_id, sync_epoch) VALUES (?, ?, ?, ?, ?, ?)')
        .run(operation.entityUid,id,operation.opId,operation.clientId,operation.libraryId,operation.syncEpoch);
      return saveReceipt(database,operation,requestHash,{opId:operation.opId,status:'applied',entityId:id,resourceVersion:1,serverSeq:maxServerSeq(database)});
    }

    if (operation.operationKind === 'producer.view-later.set') {""")
f='apps/web/src/offline/offline-api.ts'
edit(f,'  const producers = snapshot.payload.producers.map((producer) => {',"""  const producerCreates = parsed.filter((row): row is Extract<SyncReplayRequest,{operationKind:'producer.create'}> => row.operationKind === 'producer.create');
  const producerRows = [...snapshot.payload.producers];
  for (const row of producerCreates) {
    if (producerRows.some(owner => owner.syncUid === row.entityUid)) continue;
    const id = localCollectionId(row.entityUid);
    if (producerRows.some(owner => owner.id === id)) throw new Error('Local Author ID collision');
    producerRows.push({id,syncUid:row.entityUid,syncVersion:1,...row.payload,galleryAnchor:null});
  }
  const producers = producerRows.map((producer) => {""")
edit(f,'  if (deletedIds.size === 0 && entryOperations.length === 0',"  if (!parsed.some(row => row.operationKind === 'producer.create') && deletedIds.size === 0 && entryOperations.length === 0")
# A new standalone author has a real projected initial revision, unlike pending Entry-origin children.
edit(f,"    const active = await readActiveSnapshot(store);\n    const original = active?.snapshot.payload.producers.find((producer) => producer.id === authorId);\n    if (active === null || original?.syncUid === undefined || original.syncVersion === undefined) {\n      throw transportError ?? new Error('Author is unavailable in the offline copy or is missing stable identity/version');\n    }", """    const active = await readActiveSnapshot(store);
    const existingRows = hasOutbox(store) ? await store.list() : [];
    const original = active === null ? undefined : snapshotWithOverlays(active.snapshot, existingRows.filter(row => row.operationKind === 'producer.create')).payload.producers.find((producer) => producer.id === authorId);
    if (active === null || original?.syncUid === undefined || original.syncVersion === undefined) {
      throw transportError ?? new Error('Author is unavailable in the offline copy or is missing stable identity/version');
    }""")
edit(f,"const dependencies = sources.filter((row): row is EntryAuthorCreateOperation => row.operationKind === 'entry.author.create-and-link' && row.entityUid !== ownerUid.toLowerCase() && uids.map(uid=>uid.toLowerCase()).includes(row.payload.producerUid));", """const dependencies = sources.flatMap(row => {
      const producerUid = row.operationKind === 'producer.create' ? row.entityUid : row.operationKind === 'entry.author.create-and-link' && row.entityUid !== ownerUid.toLowerCase() ? row.payload.producerUid : undefined;
      return producerUid && uids.map(uid=>uid.toLowerCase()).includes(producerUid) ? [{opId:row.opId,producerUid}] : [];
    });""")
edit(f,'dependencies.map(row => ({producerUid:row.payload.producerUid,createOpId:row.opId}))','dependencies.map(row => ({producerUid:row.producerUid,createOpId:row.opId}))')
edit(f,"for (const flag of ['offlineEntryDelete', 'offlineEntryDuration', 'offlineAuthorSelfRatings', 'offlineRatingSlotDelete'])", "for (const flag of ['offlineStandaloneAuthorCreate', 'offlineEntryDelete', 'offlineEntryDuration', 'offlineAuthorSelfRatings', 'offlineRatingSlotDelete'])")
edit(f,'    async updateAuthor(authorId, input) {',"""    async createAuthor(input) {
      if (!hasOutbox(store)) throw new Error('Author creation is not available under offline: durable storage missing');
      if (await store.readMeta('capability.offlineStandaloneAuthorCreate') !== '1') {
        if (isOnlineMode()) return online.createAuthor(input);
        throw new Error('Author creation is not available under offline; refresh metadata while connected');
      }
      const active = await readActiveSnapshot(store);
      const identity = isOnlineMode() ? await online.getSyncCapabilities() : active?.snapshot.header;
      if (!identity) throw new Error('Author creation is not available under offline: saved identity missing');
      const payload = {name:input.name.trim(),occupation:input.occupation ?? null,artworkRef:input.artworkRef ?? null,content:input.content ?? null};
      if (!payload.name) throw new Error('Author name cannot be empty');
      const entityUid = randomUUID().toLowerCase();
      const operation = createPendingSyncOperation({clientId,libraryId:identity.libraryId,syncEpoch:identity.syncEpoch,
        entityKind:'producer',entityUid,operationKind:'producer.create',baseVersion:0,baseValues:{},payload},{randomUUID});
      await enqueueDurably(operation);invalidateOfflineLibrary();await setReplayStateFromStore();
      if (isOnlineMode()) await replayPendingOperations();
      const refreshed = await readActiveSnapshot(store);
      const owner = refreshed?.snapshot.payload.producers.find(row => row.syncUid === entityUid);
      return producerRecordFromSnapshot(owner ?? {id:localCollectionId(entityUid),syncUid:entityUid,syncVersion:1,...payload});
    },
    async updateAuthor(authorId, input) {""")
# Final profile folds create and later writes; never clear on cursor alone.
edit(f,'          const durations = new Map<string, number | null>();',"""          const profiles = new Map<string,Record<string,unknown>>();
          for (const op of appliedOperations) if (op.operationKind === 'producer.create' || op.operationKind === 'producer.update') {
            profiles.set(op.entityUid,{...profiles.get(op.entityUid),...op.payload});
          }
          for (const [uid,desired] of profiles) {
            const owner = snapshot.payload.producers.find(row => row.syncUid === uid);
            const create = appliedOperations.find(row => row.operationKind === 'producer.create' && row.entityUid === uid);
            if (!owner || (create && owner.id !== appliedReceipts.get(create.opId)?.entityId)
              || Object.entries(desired).some(([key,value]) => Reflect.get(owner,key) !== value)) throw new Error('Snapshot refresh failed: standalone Author profile/identity is missing');
          }
          const durations = new Map<string, number | null>();""")
f='apps/web/src/offline/pending-work-restore.ts'
edit(f,"!['entry.create','entry.tag.create','entry.facet.create','collection.create','collection.order.set'].includes(row.operationKind)","!['producer.create','entry.create','entry.tag.create','entry.facet.create','collection.create','collection.order.set'].includes(row.operationKind)")
edit(f,"['entry.create','entry.tag.create','entry.facet.create','collection.create'].includes(row.operationKind)","['producer.create','entry.create','entry.tag.create','entry.facet.create','collection.create'].includes(row.operationKind)")
edit(f,"const producer = (value:string) => payload.producers.some(row=>same(row.syncUid,value)) || prior.some(row=>row.operationKind==='entry.author.create-and-link' && typeof row.payload.producerUid==='string' && same(row.payload.producerUid,value));", "const producer = (value:string) => payload.producers.some(row=>same(row.syncUid,value)) || prior.some(row=>row.operationKind==='producer.create' ? same(row.entityUid,value) : row.operationKind==='entry.author.create-and-link' && typeof row.payload.producerUid==='string' && same(row.payload.producerUid,value));")
edit(f,"parent.row.operationKind!==dependency.kind", "(parent.row.operationKind!==dependency.kind && !(dependency.kind==='entry.author.create-and-link' && parent.row.operationKind==='producer.create'))")
