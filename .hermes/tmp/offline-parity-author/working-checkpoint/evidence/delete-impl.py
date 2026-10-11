from guard import *
# Collect sequential edits and preflight the whole candidate before touching source.
changes=[]
def add(f,a,b):changes.append((f,a,b))
f='packages/shared/src/schemas/sync.ts'
add(f,'const syncProducerReplayBaseShape = {',"""const syncProducerDeleteOperationSchema = z.strictObject({
  ...syncReplayBaseShape, entityKind:z.literal('producer'), operationKind:z.literal('producer.delete'),
  baseVersion:z.number().int().positive(),baseValues:z.strictObject({}),payload:z.strictObject({}),
});

const syncProducerReplayBaseShape = {""")
add(f,'  syncProducerCreateOperationSchema,','  syncProducerDeleteOperationSchema,\n  syncProducerCreateOperationSchema,')
f='packages/shared/src/schemas/native-mutation-contract.ts'
add(f,'  "producer.create": {','  "producer.delete": { "entityKind": "producer", "flags": ["offlineMutations", "offlineAuthorDelete"] },\n  "producer.create": {')
f='apps/server/src/sync/sync-service.ts'
add(f,'      offlineStandaloneAuthorCreate: sqliteSchemaVersion >= 33,','      offlineStandaloneAuthorCreate: sqliteSchemaVersion >= 33,\n      offlineAuthorDelete: sqliteSchemaVersion >= 33,')
f='apps/server/src/sync/replay-service.ts'
s=(ROOT/f).read_text();a=s.index("    if (operation.operationKind === 'entry.delete') {");b=s.index("    if (operation.operationKind === 'producer.create')",a)
block=s[a:b].replace('entry.delete','producer.delete').replace('FROM entries','FROM producers').replace('DELETE FROM entries','DELETE FROM producers').replace("entity_kind = 'entry'","entity_kind = 'producer'").replace('Entry','Author').replace('shared Author/vocabulary rows remain stored','works and shared vocabulary rows remain stored')
add(f,"    if (operation.operationKind === 'producer.create')",block+"    if (operation.operationKind === 'producer.create')")
f='apps/web/src/api/gallery.ts'
add(f,'  getEntrySyncIdentity?(entryId: number): Promise<SyncEntryIdentity>;','  getEntrySyncIdentity?(entryId: number): Promise<SyncEntryIdentity>;\n  getAuthorSyncIdentity?(authorId: number): Promise<SyncEntryIdentity>;')
add(f,'    async getEntrySyncIdentity(entryId) {',"""    async getAuthorSyncIdentity(authorId) {
      return syncEntryIdentitySchema.parse(await client.request(`producers/${authorId}/sync-identity`));
    },
    async getEntrySyncIdentity(entryId) {""")
f='apps/server/src/http/app.ts'
add(f,"  app.get('/api/entries/:entryId/sync-identity', (context) => {", """  app.get('/api/producers/:producerId/sync-identity', (context) => {
    const { producerId } = producerIdParamsSchema.parse({ producerId: context.req.param('producerId') });
    const row = database.prepare('SELECT id, sync_uid AS syncUid, sync_version AS syncVersion FROM producers WHERE id = ?').get(producerId);
    if (!row) return context.json(errorPayload('NOT_FOUND', 'Author not found'), 404);
    return context.json(syncEntryIdentitySchema.parse({ ...getSyncIdentity(database), ...row }));
  });

  app.get('/api/entries/:entryId/sync-identity', (context) => {""")
f='apps/web/src/offline/offline-api.ts';s=(ROOT/f).read_text()
add(f,'  const entryOperations = parsed.filter(isEntryUpdateOperation);', "  const deletedProducerIds = new Set(snapshot.payload.producers.filter(row=>parsed.some(op=>op.operationKind==='producer.delete' && op.entityUid===row.syncUid)).map(row=>row.id));\n  const deletedDirectoryIds = new Set(snapshot.payload.authorDirectories.filter(row=>deletedProducerIds.has(row.producerId)).map(row=>row.id));\n  const entryOperations = parsed.filter(isEntryUpdateOperation);")
add(f,"if (!parsed.some(row => row.operationKind === 'producer.create') && deletedIds.size === 0", "if (deletedProducerIds.size === 0 && !parsed.some(row => row.operationKind === 'producer.create') && deletedIds.size === 0")
# Exact payload-return region only, not unrelated declarations.
a=s.index('      entries: entries.filter');b=s.index('\n    },\n  };',a);old=s[a:b];new=old.replace('      producers,','      producers:producers.filter(row=>!deletedProducerIds.has(row.id)),').replace('!deletedIds.has(row.entryId)),\n      tags,','!deletedIds.has(row.entryId) && !deletedProducerIds.has(row.producerId)),\n      tags,').replace('      producerTagAssignments,','      producerTagAssignments:producerTagAssignments.filter(row=>!deletedProducerIds.has(row.producerId)),').replace("!('entryId' in row) || !deletedIds.has(row.entryId)","('entryId' in row ? !deletedIds.has(row.entryId) : !deletedProducerIds.has(row.producerId))").replace('      authorDirectories,','      authorDirectories:authorDirectories.filter(row=>!deletedProducerIds.has(row.producerId)),').replace('      authorDirectorySets,','      authorDirectorySets:authorDirectorySets?.filter(row=>!deletedProducerIds.has(row.producerId)),').replace('authorDirectoryEntries.filter(row => !deletedIds.has(row.entryId))','authorDirectoryEntries.filter(row => !deletedIds.has(row.entryId) && !deletedDirectoryIds.has(row.directoryId))').replace('      viewLaterProducers,','      viewLaterProducers:viewLaterProducers.filter(row=>!deletedProducerIds.has(row.subjectId)),').replace('      producerRatingValues,','      producerRatingValues:producerRatingValues.filter(row=>!deletedProducerIds.has(row.producerId)),')
add(f,old,new)
add(f,"    if (operation.entityKind === 'entry' && (await store.list()).some(row => row.operationKind === 'entry.delete' && row.entityUid === operation.entityUid))", "    if ((operation.entityKind === 'entry' || operation.entityKind === 'producer') && (await store.list()).some(row => row.operationKind === `${operation.entityKind}.delete` && row.entityUid === operation.entityUid))")
a=s.index('    async deleteEntry(entryId) {');b=s.index('    async uploadEntryMedia',a);block=s[a:b]
block=block.replace('async deleteEntry(entryId)','async deleteAuthor(entryId)').replace('Entry','Author').replace("['entries']","['producers']").replace('.payload.entries','.payload.producers').replace('getAuthorSyncIdentity','getAuthorSyncIdentity').replace('getEntrySyncIdentity','getAuthorSyncIdentity').replace("'entry.create'","'producer.create'").replace("'entry.delete'","'producer.delete'").replace("entityKind:'entry'","entityKind:'producer'").replace('offlineAuthorDelete','offlineAuthorDelete').replace('offlineEntryDelete','offlineAuthorDelete').replace("row.entityKind === 'entry'","row.entityKind === 'producer'").replace('entryVersionDelta','producerVersionDelta')
block=block.replace("const media = hasMediaOutbox(store) ? (await store.listMedia()).filter(row => row.entryUid === owner.syncUid) : [];","const media: never[] = [];").replace(' + parsedMediaOrderOperations(rows).filter(row => row.entityUid === owner.syncUid).length + media.length','')
add(f,'    async deleteEntry(entryId) {',block+'    async deleteEntry(entryId) {')
add(f,'      const appliedReceipts = new Map', '      const producerDeleteReceipts = new Map<string, {entityId:number; resourceVersion:number; serverSeq:number}>();\n      const appliedReceipts = new Map')
a=s.index("            if (operation.operationKind === 'entry.delete') {");b=s.index("            if (operation.operationKind === 'entry.media.set'",a);block=s[a:b].replace("'entry.delete'","'producer.delete'").replace('.payload.entries','.payload.producers').replace('Entry delete','Author delete').replace('entryDeleteReceipts','producerDeleteReceipts')
add(f,"            if (operation.operationKind === 'entry.delete') {",block+"            if (operation.operationKind === 'entry.delete') {")
a=s.index('          for (const [uid, receipt] of entryDeleteReceipts)');b=s.index('          // Only matching journal',a);block=s[a:b].replace('entryDeleteReceipts','producerDeleteReceipts').replace("'entry.delete'","'producer.delete'").replace('.payload.entries','.payload.producers').replace('Entry deletion','Author deletion').replace('entryDeleteProof.','producerDeleteProof.').replace("row.entityKind === 'entry'","row.entityKind === 'producer'")
add(f,'          // Only matching journal',block+'          // Only matching journal')
f='apps/web/src/offline/pending-work-restore.ts'
add(f,"if (row.entityKind === 'entry' && union.slice(0,index).some(prior => prior.operationKind === 'entry.delete' && uid(prior.entityUid) === uid(row.entityUid)))", "if ((row.entityKind === 'entry' || row.entityKind === 'producer') && union.slice(0,index).some(prior => prior.operationKind === `${row.entityKind}.delete` && uid(prior.entityUid) === uid(row.entityUid)))")
candidates={}
for f,a,c in changes:
 b=candidates.get(f,(ROOT/f).read_bytes());matches=[]
 for nl in [b'\n',b'\r\n']:
  x=a.encode().replace(b'\n',nl);y=c.encode().replace(b'\n',nl)
  if b.count(x)==1:matches.append((x,y))
 assert matches,'Preflight '+f+' '+a[:100]
 x,y=matches[0];candidates[f]=b.replace(x,y,1)
for f,a,c in changes:edit(f,a,c)
print('Delete vertical edits',len(changes))
