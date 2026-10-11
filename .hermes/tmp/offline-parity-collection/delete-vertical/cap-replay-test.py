from pathlib import Path
r=Path('D:/Project/TagTraceTrove');p=r/'apps/web/tests/offline-collection-delete.integration.test.ts';b=p.read_bytes();e=b'\r\n' if b'\r\n' in b else b'\n'
text='''
it.each(['offlineMutations','offlineCollectionManagement','offlineCollectionDelete'])('original queued Collection delete requires explicit current %s after a cold downgrade',async flag=>{
 for(const absent of [false,true]){const f=await fixture();try{await f.offline();await f.api.deleteCollection(f.parent.id);const originals=(await f.store.list()).map(originalMutationEnvelope);if(absent)await f.removeMeta('capability.'+flag);else await f.store.writeMeta('capability.'+flag,'0');const cold=f.cold();f.connect();await cold.flushOfflineOutbox!();expect(f.bodies).toEqual([]);expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);expect(f.db.prepare('SELECT id FROM collections WHERE id=?').get(f.parent.id)).toBeDefined();}finally{f.close();}}
});
it('canonical scope is strict and only the exact UUID receipt proves an absent Collection',async()=>{
 const f=await fixture();try{await f.offline();await f.api.deleteCollection(f.parent.id);const original=originalMutationEnvelope((await f.store.list())[0]!);expect(syncReplayRequestSchema.safeParse({...original,baseValues:{kind:'entry',parentUid:null}}).success).toBe(false);
 if(original.operationKind!=='collection.delete')throw new Error('fixture');expect(syncReplayRequestSchema.safeParse({...original,baseValues:{...original.baseValues,children:[...original.baseValues.children,...original.baseValues.children]}}).success).toBe(false);
 f.connect();const applied=await f.online.replaySyncOperation(original);expect(applied.status).toBe('applied');expect(await f.online.replaySyncOperation(original)).toEqual(applied);expect(await f.online.replaySyncOperation({...original,opId:randomUUID()})).toMatchObject({status:'failed',errorCode:'entity-not-found'});expect(await f.online.replaySyncOperation({...original,baseVersion:original.baseVersion+1})).toMatchObject({status:'failed',errorCode:'operation-id-collision'});
 }finally{f.close();}
});
'''
assert p.read_bytes()==b;p.write_bytes(b+text.encode().replace(b'\n',e));print('Added required-capability replay cold and strict schema/immutable receipt coverage within existing cells')
