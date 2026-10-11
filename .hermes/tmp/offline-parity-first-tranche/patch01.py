from safe_edit import edit
edit('packages/shared/src/schemas/sync.ts',"const syncEntryUpdateOperationSchema = z.strictObject({", """const syncEntryDeleteOperationSchema = z.strictObject({
  ...syncEntryReplayBaseShape,
  operationKind: z.literal('entry.delete'),
  baseVersion: z.number().int().positive(),
  baseValues: z.strictObject({}),
  payload: z.strictObject({}),
});

const syncEntryUpdateOperationSchema = z.strictObject({""")
edit('packages/shared/src/schemas/sync.ts','  syncEntryUpdateOperationSchema,','  syncEntryUpdateOperationSchema,\n  syncEntryDeleteOperationSchema,')
edit('packages/shared/src/schemas/native-mutation-contract.ts','  "entry.update": {','  "entry.delete": { "entityKind": "entry", "flags": ["offlineMutations", "offlineEntryDelete"] },\n  "entry.update": {')
edit('apps/server/src/sync/sync-service.ts','      offlineEntryUpdate: true,','      offlineEntryUpdate: true,\n      offlineEntryDelete: sqliteSchemaVersion >= 16,')
edit('apps/server/src/sync/replay-service.ts','import { createEntry, updateEntry, type UpdateEntryInput }','import { createEntry, updateEntry, deleteEntry, type UpdateEntryInput }')
edit('apps/server/src/sync/replay-service.ts',"    if (operation.operationKind === 'producer.view-later.set') {", """    if (operation.operationKind === 'entry.delete') {
      const owner = database.prepare('SELECT id, sync_version AS syncVersion FROM entries WHERE sync_uid = ? COLLATE NOCASE')
        .get(operation.entityUid) as {id:number; syncVersion:number} | undefined;
      if (!owner) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'failed', errorCode: 'entity-not-found', detail: 'Entry is absent; only an exact original receipt proves this deletion',
      });
      if (owner.syncVersion !== operation.baseVersion) return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'conflict', currentVersion: owner.syncVersion, currentValues: {}, serverSeq: maxServerSeq(database),
      });
      deleteEntry(database, owner.id);
      const tombstone = database.prepare("SELECT deleted_version AS version, change_seq AS seq FROM sync_tombstones WHERE entity_kind = 'entry' AND entity_uid = ? COLLATE NOCASE")
        .get(operation.entityUid) as {version:number;seq:number} | undefined;
      if (!tombstone) throw new Error('Entry deletion did not produce a durable tombstone');
      return saveReceipt(database, operation, requestHash, {
        opId: operation.opId, status: 'applied', entityId: owner.id, resourceVersion: tombstone.version, serverSeq: tombstone.seq,
      });
    }

    if (operation.operationKind === 'producer.view-later.set') {""")
edit('apps/server/src/http/app.ts',"    return context.json(syncReplayResultSchema.parse(replaySyncOperation(database, operation)));", """    const result = syncReplayResultSchema.parse(replaySyncOperation(database, operation));
    // Commit/receipt is authoritative even if post-commit file cleanup fails.
    // An exact retry may safely repeat cleanup; a conflict/collision must not.
    if (operation.operationKind === 'entry.delete' && result.status === 'applied' && result.entityId && options.assetRoot) {
      try { await deleteEntryMedia(options.assetRoot, result.entityId); } catch { /* Retain the applied receipt; retry cleanup on exact replay. */ }
    }
    return context.json(result);""")
edit('apps/web/src/offline/offline-api.ts',"  const parsed = parsedEntryOperations(operations);\n  const entryOperations = parsed.filter(isEntryUpdateOperation);", """  const parsed = parsedEntryOperations(operations);
  const deletedIds = new Set(snapshot.payload.entries.filter(row => parsed.some(op => op.operationKind === 'entry.delete' && op.entityUid === row.syncUid)).map(row => row.id));
  const entryOperations = parsed.filter(isEntryUpdateOperation);""")
edit('apps/web/src/offline/offline-api.ts',"  if (entryOperations.length === 0\n    && entryCreateOperations.length === 0", "  if (deletedIds.size === 0 && entryOperations.length === 0\n    && entryCreateOperations.length === 0")
edit('apps/web/src/offline/offline-api.ts',"      galleryOrder,\n      entries,\n      producers,\n      entryProducers,", """      galleryOrder,
      entries: entries.filter(row => !deletedIds.has(row.id)),
      producers,
      entryProducers: entryProducers.filter(row => !deletedIds.has(row.entryId)),""")
for name in ['entryTags','entryContents','authorDirectoryEntries','entryRatingValues']:
 edit('apps/web/src/offline/offline-api.ts',f'      {name},',f'      {name}: {name}.filter(row => !deletedIds.has(row.entryId)),')
edit('apps/web/src/offline/offline-api.ts','      collectionMembers,',"      collectionMembers: collectionMembers.filter(row => !('entryId' in row) || !deletedIds.has(row.entryId)),")
edit('apps/web/src/offline/offline-api.ts','      entryUsage: [...usageByEntryId.values()].sort((left, right) => left.entryId - right.entryId),','      entryUsage: [...usageByEntryId.values()].filter(row => !deletedIds.has(row.entryId)).sort((left, right) => left.entryId - right.entryId),')
edit('apps/web/src/offline/offline-api.ts','      viewLaterEntries,','      viewLaterEntries: viewLaterEntries.filter(row => !deletedIds.has(row.subjectId)),')
edit('apps/web/src/offline/offline-api.ts',"         for (const flag of ['offlineEntryDuration', 'offlineAuthorSelfRatings', 'offlineRatingSlotDelete'])", "         for (const flag of ['offlineEntryDelete', 'offlineEntryDuration', 'offlineAuthorSelfRatings', 'offlineRatingSlotDelete'])")
edit('apps/web/src/offline/offline-api.ts',"    ...online,\n    async uploadEntryMedia", """    ...online,
    async deleteEntry(entryId) {
      if (!hasOutbox(store) || entryId <= 0) throw new Error('Use the pending Entry discard action, not ordinary deletion');
      const active = await readActiveSnapshot(store);
      const owner = active?.snapshot.payload.entries.find(row => row.id === entryId);
      if (!active || !owner?.syncUid || !owner.syncVersion) throw new Error('Entry deletion needs a saved stable identity; refresh this offline copy');
      if (await store.readMeta('capability.offlineMutations') !== '1' || await store.readMeta('capability.offlineEntryDelete') !== '1') throw new Error('Refresh this offline copy to enable Entry deletion');
      const rows = await store.list();
      if (rows.some(row => row.operationKind === 'entry.delete' && row.entityUid === owner.syncUid)) return;
      const prior = parsedEntryOperations(rows).filter(row => row.entityKind === 'entry' && row.entityUid === owner.syncUid);
      const media = hasMediaOutbox(store) ? (await store.listMedia()).filter(row => row.entryUid === owner.syncUid) : [];
      const op = createPendingSyncOperation({clientId, libraryId:active.snapshot.header.libraryId, syncEpoch:active.snapshot.header.syncEpoch,
        entityKind:'entry',entityUid:owner.syncUid,operationKind:'entry.delete',
        baseVersion:owner.syncVersion + prior.reduce((n,row) => n + entryVersionDelta(row),0) + parsedMediaOrderOperations(rows).filter(row => row.entityUid === owner.syncUid).length + media.length,
        baseValues:{},payload:{}}, {randomUUID});
      // Always persist before attempting transport: uncertain online deletion retries
      // the original UUID/body through receipts, never numeric DELETE or new identity.
      await enqueueDurably(op); invalidateOfflineLibrary(); await setReplayStateFromStore();
      if (isOnlineMode()) await replayPendingOperations();
    },
    async uploadEntryMedia""")
