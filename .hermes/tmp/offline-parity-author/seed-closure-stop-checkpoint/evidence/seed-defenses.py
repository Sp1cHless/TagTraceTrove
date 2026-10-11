from pathlib import Path
import hashlib
p=Path('apps/web/tests/offline-author-parity.integration.test.ts');b=p.read_bytes();q=Path('.hermes/tmp/offline-parity-author/seed-defenses-before');q.mkdir(exist_ok=False);(q/'test.bytes').write_bytes(b)
s='''
it('standalone Directory seed gates preserve legacy absence and original bytes',async()=>{
 const f=await fixture();try{
  const {requiredMutationCapabilities}=await import('../src/offline/sync-mutation-plan.js');
  for(const value of ['0',null]){
   await f.store.writeMeta('capability.offlineStandaloneAuthorDirectorySeed',value ?? '0');const author=await f.current.createAuthor({name:'Legacy '+value});const row=(await f.store.list()).at(-1)!;expect(Object.hasOwn(row.payload,'directorySetUid')).toBe(false);expect(requiredMutationCapabilities(originalMutationEnvelope(row))).not.toContain('offlineStandaloneAuthorDirectorySeed');
   await expect(f.current.createAuthorDirectory(author.id,{title:'Unavailable'})).rejects.toThrow(/Directory|offline/);expect(f.business).toEqual([]);
  }
  await f.store.writeMeta('capability.offlineStandaloneAuthorDirectorySeed','1');const author=await f.current.createAuthor({name:'Seed gate'});const create=(await f.store.list()).at(-1)!;await f.current.linkEntryAuthor(f.entry.id,author.id);await f.current.createAuthorDirectory(author.id,{title:'Gate',entryIds:[f.entry.id]});const originals=(await f.store.list()).map(originalMutationEnvelope);expect(requiredMutationCapabilities(originalMutationEnvelope(create))).toContain('offlineStandaloneAuthorDirectorySeed');
  await f.store.writeMeta('capability.offlineStandaloneAuthorDirectorySeed','0');await expect(f.current.updateAuthorDirectory((await f.current.getAuthor(author.id)).directories[0]!.id,{title:'Refused'})).rejects.toThrow(/not available under offline/);
  f.connect();await f.current.flushOfflineOutbox!();expect(f.bodies.map(body=>JSON.parse(body).opId)).not.toContain(create.opId);expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals.filter(row=>row.opId===create.opId || row.operationKind==='entry.authors.set' || row.operationKind==='author.directories.set'));
 }finally{f.close();}
});
it('Directory seed collision and foreign Producer origin fail without consuming original queue',async()=>{
 const f=await fixture();try{
  const author=await f.current.createAuthor({name:'Collision'});const row=(await f.store.list())[0]!;const foreign=f.db.prepare('SELECT sync_uid FROM author_directory_sets WHERE producer_id=?').pluck().get(f.author.id) as string;
  const body=originalMutationEnvelope(row);const collision={...body,opId:randomUUID(),payload:{...body.payload,directorySetUid:foreign}};const receipt=await f.online.replaySyncOperation(collision as typeof body);expect(receipt.status).toBe('failed');expect(f.db.prepare("SELECT count(*) FROM producers WHERE name='Collision'").pluck().get()).toBe(0);expect(originalMutationEnvelope((await f.store.list())[0]!)).toEqual(body);
  await f.current.linkEntryAuthor(f.entry.id,author.id);await f.current.createAuthorDirectory(author.id,{title:'Own',entryIds:[f.entry.id]});f.connect();await f.current.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  const op={...originalMutationEnvelope(row),opId:randomUUID(),entityKind:'author_directory_set',entityUid:foreign,operationKind:'author.directories.set',baseVersion:Number(f.db.prepare('SELECT sync_version FROM author_directory_sets WHERE sync_uid=?').pluck().get(foreign)),baseValues:{directories:[]},payload:{directories:[],producerCreates:[{producerUid:row.entityUid,createOpId:row.opId}]}};
  expect((await f.online.replaySyncOperation(op as never)).status).toBe('failed');
 }finally{f.close();}
});
it('Directory seed doctor and isolated database probe require new migration invariants',async()=>{
 const {inspectDatabase}=await serverModule('database/doctor');const {runDatabaseProbe}=await serverModule('database/probe');const f=await fixture();try{
  expect(runDatabaseProbe().ok).toBe(true);f.db.exec('DROP TRIGGER producers_directory_seed_immutable');expect(inspectDatabase(f.db).ok).toBe(false);
 }finally{f.close();}
});
'''
p.write_bytes(b+s.encode());print('defenses added')
