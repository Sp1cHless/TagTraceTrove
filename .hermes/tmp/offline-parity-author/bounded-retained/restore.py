from run import edit,gate
P='apps/web/tests/offline-author-parity.integration.test.ts'
edit(P,'get store(){return store;},','''get store(){return store;},
  async removeMeta(key:string){const request=indexedDB.open(name);const db=await new Promise<IDBDatabase>((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('meta','readwrite');tx.objectStore('meta').delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}finally{db.close();}},''')
edit(P,"await f.store.writeMeta('capability.'+flag,value);","if(value===null)await f.removeMeta('capability.'+flag);else await f.store.writeMeta('capability.'+flag,value);\n  expect(await f.store.readMeta('capability.'+flag)).toBe(value);")
edit(P,"it('mixed Author profile anchor tag rating and viewlater edits settle only behind verified final deletion',async()=>{",'''it('ordinary Author delete export atomic restore retains attempted metadata cold projection and exact replay ACK retry',async()=>{
 const f=await fixture();try{
  await f.current.deleteAuthor(f.author.id);const pending=(await f.store.list())[0]!;
  await f.store.update(pending.opId,{lastAttemptAt:'2026-10-09T00:00:00.000Z',lastError:'Uncertain retained attempt'});
  const saved=await f.store.list();const text=JSON.stringify(await buildPendingWorkExport(f.store));const original=originalMutationEnvelope(saved[0]!);
  await f.store.removeMany([pending.opId]);let cold=f.cold();f.business.length=0;
  await cold.restorePendingWork!(text);expect(await f.store.list()).toEqual(saved);expect(f.business).toEqual([]);
  cold=f.cold();await cold.preferOfflineSnapshot!();expect((await cold.queryProducerPage(producerPageQueryRequestSchema.parse({}))).total).toBe(0);
  expect((await cold.queryEntryPage(entryPageQueryRequestSchema.parse({}))).total).toBe(2);
  f.connect();f.loseReplay();await cold.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual([original]);
  f.loseAck();cold=f.cold();await cold.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual([original]);
  const proof=await f.store.readMeta('producerDeleteProof.'+original.opId);expect(proof).not.toBeNull();
  expect(JSON.parse(String(proof))).toMatchObject({receipt:{entityId:f.author.id,resourceVersion:original.baseVersion+1},fingerprint:expect.any(String)});
  cold=f.cold();expect(await f.store.readMeta('producerDeleteProof.'+original.opId)).toBe(proof);await cold.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(2);
  expect(f.bodies.map(body=>JSON.parse(body)).filter(body=>body.opId===original.opId)).toEqual([original,original,original]);
 }finally{f.close();}
});
it('atomic restore specifically rejects a structurally valid causal Producer update after Author delete without changing queue bytes',async()=>{
 const f=await fixture();try{
  await f.current.deleteAuthor(f.author.id);const before=JSON.stringify(await f.store.list());const backup=await buildPendingWorkExport(f.store);const deletion=backup.operations[0]!;
  const later={...deletion,opId:randomUUID(),operationKind:'producer.update',baseVersion:deletion.baseVersion+1,clientCreatedAt:new Date(Date.parse(deletion.clientCreatedAt)+1000).toISOString(),baseValues:{content:''},payload:{content:'Illegal later write'}};
  const {syncReplayRequestSchema,pendingWorkFileSchema}=await import('@t3/shared');const {preparePendingWork}=await import('../src/offline/pending-work-restore.js');
  expect(syncReplayRequestSchema.safeParse(originalMutationEnvelope(later)).success).toBe(true);
  const file={...backup,operations:[deletion,later]};expect(pendingWorkFileSchema.safeParse(file).success).toBe(true);const text=JSON.stringify(file);
  expect((await preparePendingWork(text)).operations).toEqual(file.operations);
  f.business.length=0;await expect(f.current.restorePendingWork!(text)).rejects.toThrow(/deleted.*later restored edits/i);
  expect(JSON.stringify(await f.store.list())).toBe(before);expect(f.business).toEqual([]);expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(1);
 }finally{f.close();}
});

it('mixed Author profile anchor tag rating and viewlater edits settle only behind verified final deletion',async()=>{''')
gate('restore-first',['node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts',P,'--maxWorkers','2','--testTimeout','30000','-t','ordinary Author delete export|atomic restore specifically|known offline Author delete refuses'])
