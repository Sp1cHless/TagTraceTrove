from edit import edit
p='apps/web/tests/offline-entry-delete.integration.test.ts'
edit(p,"  const bad={...backup,operations:[...backup.operations,{...update,opId:randomUUID()}]};", "  const bad={...backup,operations:[...backup.operations,{...before[0]!,...update,opId:randomUUID(),sequence:before[1]!.sequence+1}]};")
edit(p,"it('absence without an authoritative matching delete journal cannot authorize receipt cleanup',async()=>{", """it('exact delete replay after numeric ID reuse never removes replacement media',async()=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.survivor.id);const op=originalMutationEnvelope((await f.store.list())[0]!);f.connect();await f.online.replaySyncOperation!(op);
  const {createEntry}=await serverModule('repositories/entry-repository');const replacement=createEntry(f.db,{title:'Replacement',type:'comic'});expect(replacement.id).toBe(f.survivor.id);
  const {mkdirSync,writeFileSync,readFileSync}=await import('node:fs');const path=join(f.root,'entries',String(replacement.id));mkdirSync(path,{recursive:true});writeFileSync(join(path,'cover.webp'),'replacement bytes');
  expect((await f.online.replaySyncOperation!(op)).status).toBe('applied');expect(readFileSync(join(path,'cover.webp'),'utf8')).toBe('replacement bytes');
 }finally{f.close();}
});
it.each(['corrupt','foreign','body'])('changed stored delete proof %s cannot authorize cleanup after ACK loss',async mode=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.entry.id);const row=(await f.store.list())[0]!;f.connect();f.loseAck();await f.current.flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);
  const key='entryDeleteProof.'+row.opId;const original=await f.store.readMeta(key);expect(original).not.toBeNull();
  const proof=JSON.parse(original!);if(mode==='foreign')proof.receipt.entityId=999;else if(mode==='body')proof.fingerprint='changed';
  await f.store.writeMeta(key,mode==='corrupt'?'native raw proof':JSON.stringify(proof));const state:import('../src/offline/offline-api.js').OfflineApiState={mode:'offline'};
  await f.cold(state).flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);
 }finally{f.close();}
});
it('absence without an authoritative matching delete journal cannot authorize receipt cleanup',async()=>{""")
