from pathlib import Path
r=Path('D:/Project/TagTraceTrove');p=r/'apps/web/tests/offline-collection-delete.integration.test.ts';b=p.read_bytes();s=b.decode();e='\r\n' if '\r\n' in s else '\n';s=s.replace('\r\n','\n')
changes=[('async function fixture() {','async function fixture(install=true) {'),('    async offline() {','    async offline() {'),("  return { db, section", "  if (install) {await store.writeGeneration(1,JSON.stringify(await online.fetchSyncSnapshot()));await store.writeMeta('activeGeneration','1');}\n  await api.getSyncCapabilities({replay:false});\n  return { db, section")]
for a,z in changes:
 assert s.count(a)==1;(s:=s.replace(a,z,1))
s=s.replace("import { originalMutationEnvelope }", "import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';\nimport { preparePendingWork } from '../src/offline/pending-work-restore.js';\nimport { syncReplayRequestSchema, pendingWorkFileSchema } from '@t3/shared';\nimport { originalMutationEnvelope }")
s+='''
it.each(['no-copy','old-copy'] as const)('connected %s bounded identity deletes a new folder without snapshot prefetch or numeric DELETE',async mode=>{
 const f=await fixture(mode==='old-copy');try{
  const folder=await f.online.createCollection({kind:'entry',title:'New after copy',galleryType:'Comic'});f.calls.length=0;
  await f.api.deleteCollection(folder.id);
  expect(f.calls[0]).toBe(`GET /api/collections/${folder.id}/sync-identity`);
  expect(f.calls).not.toContain(`DELETE /api/collections/${folder.id}`);
  expect(f.calls.indexOf('POST /api/sync/replay')).toBeGreaterThan(0);
  const snapshot=f.calls.indexOf('GET /api/sync/snapshot');expect(snapshot===-1 || snapshot>f.calls.indexOf('POST /api/sync/replay')).toBe(true);
  expect(f.db.prepare('SELECT id FROM collections WHERE id=?').get(folder.id)).toBeUndefined();expect(await f.store.list()).toEqual([]);
 }finally{f.close();}
});
it.each(['child','author','empty'] as const)('finite %s deletion preserves peers and subject rows',async kind=>{
 const f=await fixture();try{
  let id=f.child.id;
  if(kind!=='child') {const folder=await f.online.createCollection({kind:kind==='author'?'producer':'entry',title:kind,galleryType:kind==='author'?undefined:'Comic'});id=folder.id;if(kind==='author')await f.online.addCollectionProducer(id,f.author.id);}
  await f.offline();await f.api.deleteCollection(id);const cold=f.cold();await cold.preferOfflineSnapshot!();
  const records=await cold.listCollections(kind==='author'?'producer':'entry',true);expect(records.some(row=>row.id===id || row.children.some(child=>child.id===id))).toBe(false);
  f.connect();await cold.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT id FROM collections WHERE id=?').get(f.parent.id)).toBeDefined();expect(f.db.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(3);expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(1);
 }finally{f.close();}
});
it.each(['add','edit'] as const)('frozen direct-child scope rejects concurrent child %s and keeps the original queue',async kind=>{
 const f=await fixture();try{await f.offline();await f.api.deleteCollection(f.parent.id);const originals=(await f.store.list()).map(originalMutationEnvelope);
 if(kind==='add'){const {createCollection}=await serverModule('repositories/collection-repository');createCollection(f.db,{kind:'entry',title:'Concurrent',parentId:f.parent.id});}else f.db.prepare('UPDATE collections SET title=? WHERE id=?').run('Concurrent edit',f.child.id);
 f.connect();await f.api.flushOfflineOutbox!();expect(f.db.prepare('SELECT id FROM collections WHERE id=?').get(f.parent.id)).toBeDefined();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);expect((await f.store.list())[0]?.status).toBe('conflict');
 }finally{f.close();}
});
it('held child membership blocks root deletion while an independent Entry progresses, then exact originals settle',async()=>{
 const f=await fixture();try{await f.offline();await f.api.removeCollectionEntry(f.child.id,f.other.id);const predecessor=(await f.store.list())[0]!;await f.store.update(predecessor.opId,{status:'conflict'});
 await f.api.deleteCollection(f.parent.id);await f.api.updateEntry(f.work.id,{title:'Independent'});const originals=(await f.store.list()).map(originalMutationEnvelope);f.connect();await f.api.flushOfflineOutbox!();
 expect(f.db.prepare('SELECT id FROM collections WHERE id=?').get(f.parent.id)).toBeDefined();expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.work.id)).toBe('Independent');
 await f.store.update(predecessor.opId,{status:'pending'});f.loseAck();await f.api.flushOfflineOutbox!();const final=f.cold();await final.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
 for(const op of originals){const bodies=f.bodies.filter(body=>JSON.parse(body).opId===op.opId);expect(bodies.length).toBeGreaterThan(0);expect(new Set(bodies).size).toBe(1);}
 }finally{f.close();}
});
it.each(['offlineMutations','offlineCollectionManagement','offlineCollectionDelete'])('capability %s false and absent fail closed cold with unchanged original work',async flag=>{
 for(const absent of [false,true]){const f=await fixture();try{await f.offline();await f.api.updateEntry(f.work.id,{title:'Retained'});const before=JSON.stringify(await f.store.list());
 if(absent){const req=(f.store as unknown as {unused?:number});void req; // meta key is actually removed, not null-valued.
 const factory=(f as unknown as {removeMeta?:(key:string)=>Promise<void>});await factory.removeMeta!('capability.'+flag);
 }else await f.store.writeMeta('capability.'+flag,'0');
 const cold=f.cold();await cold.preferOfflineSnapshot!();f.calls.length=0;await expect(cold.deleteCollection(f.parent.id)).rejects.toThrow('not available under offline');expect(JSON.stringify(await f.store.list())).toBe(before);expect(f.calls).toEqual([]);
 }finally{f.close();}}
});
it('unknown legacy child identity is not a default empty scope and retains originals',async()=>{
 const f=await fixture();try{await f.offline();const snapshot=await f.online.fetchSyncSnapshot().catch(()=>undefined);void snapshot;
 const raw=await f.store.readGeneration(1);const value=JSON.parse(raw!);delete value.payload.collections.find((row:{id:number})=>row.id===f.child.id).syncUid;
 // A valid legacy snapshot must be checksummed with the real shared checksum helper.
 const {computeSnapshotChecksum}=await import('../src/offline/snapshot-store.js');value.header.checksum=await computeSnapshotChecksum(value);
 await f.store.writeGeneration(2,JSON.stringify(value));await f.store.writeMeta('activeGeneration','2');const cold=f.cold();await cold.preferOfflineSnapshot!();f.calls.length=0;
 await expect(cold.deleteCollection(f.parent.id)).rejects.toThrow('unknown child identity/scope');expect(await f.store.list()).toEqual([]);expect(f.calls).toEqual([]);
 }finally{f.close();}
});
it('attempted delete export/atomic restore retains metadata and rejects structurally valid later same-child writes',async()=>{
 const f=await fixture();try{await f.offline();await f.api.deleteCollection(f.parent.id);f.connect();f.loseReplay();await f.api.flushOfflineOutbox!();const saved=await f.store.list();expect(saved[0]?.lastAttemptAt).not.toBeNull();
 const text=JSON.stringify(await buildPendingWorkExport(f.store));await preparePendingWork(text);await f.store.removeMany(saved.map(row=>row.opId));const cold=f.cold();await cold.restorePendingWork!(text);expect(await f.store.list()).toEqual(saved);
 const value=JSON.parse(text);const original=value.operations[0];const later={...original,opId:randomUUID(),entityUid:original.baseValues.children[0].syncUid,operationKind:'collection.update',baseVersion:original.baseValues.children[0].syncVersion+1,clientCreatedAt:new Date(Date.parse(original.clientCreatedAt)+1000).toISOString(),baseValues:{title:'Child shelf'},payload:{title:'Invalid later write'},status:'pending',lastAttemptAt:null,lastError:null};
 const {status,lastAttemptAt,lastError,...envelope}=later;void status;void lastAttemptAt;void lastError;expect(syncReplayRequestSchema.safeParse(envelope).success).toBe(true);value.operations.push(later);expect(pendingWorkFileSchema.safeParse(value).success).toBe(true);await preparePendingWork(JSON.stringify(value));const before=JSON.stringify(await f.store.list());await expect(cold.restorePendingWork!(JSON.stringify(value))).rejects.toThrow('deleted Collection child');expect(JSON.stringify(await f.store.list())).toBe(before);
 f.loseAck();await cold.flushOfflineOutbox!();const final=f.cold();await final.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);expect(new Set(f.bodies).size).toBe(1);
 }finally{f.close();}
});
it.each(['fingerprint','foreign-child'] as const)('corrupt %s foreground proof after actual ACK loss cannot authorize cleanup',async corrupt=>{
 const f=await fixture();try{await f.offline();await f.api.deleteCollection(f.parent.id);const original=(await f.store.list())[0]!;f.connect();f.loseAck();await f.api.flushOfflineOutbox!();expect((await f.store.list()).length).toBe(1);
 const key='collectionDeleteProof.'+original.opId;const proof=JSON.parse((await f.store.readMeta(key))!);if(corrupt==='fingerprint')proof.fingerprint='foreign';else proof.receipt.collectionDeleteJournal[1].id=f.peer.id;await f.store.writeMeta(key,JSON.stringify(proof));
 const cold=f.cold();const remove=vi.spyOn(f.store,'removeMany');await cold.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual([originalMutationEnvelope(original)]);expect(remove).not.toHaveBeenCalled();expect(f.calls.some(call=>call==='GET /api/sync/changes')).toBe(true);remove.mockRestore();
 }finally{f.close();}
});
'''
# Add actual IDB meta removal into fixture (do not simulate absent with null).
a='    connect(){disconnected=false;},';z="""    async removeMeta(key:string){const req=indexedDB.open(databaseName);const db=await new Promise<IDBDatabase>((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}finally{db.close();}},
    connect(){disconnected=false;},""";assert s.count(a)==1;s=s.replace(a,z)
assert p.read_bytes()==b;p.write_bytes(s.replace('\n',e).encode());print('Added bounded delete matrix cells')
