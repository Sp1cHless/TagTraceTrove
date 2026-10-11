from safe_edit import edit
edit('apps/web/tests/offline-entry-delete.integration.test.ts',"import { buildPendingWorkExport }", "import { originalMutationEnvelope } from '../src/offline/sync-mutation-plan.js';\nimport { buildPendingWorkExport }")
edit('apps/web/tests/offline-entry-delete.integration.test.ts',"  expect(f.db.prepare('SELECT count(*) FROM entry_producers WHERE entry_id=?').pluck().get(f.entry.id)).toBe(0);\n }finally{f.close();}\n});", """  expect(f.db.prepare('SELECT count(*) FROM entry_producers WHERE entry_id=?').pluck().get(f.entry.id)).toBe(0);
 }finally{f.close();}
});
it('known-offline deleted detail refuses locally rather than business HTTP; post-delete writes cannot recreate it',async()=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.entry.id);f.business.length=0;
  await expect(f.current.getEntry(f.entry.id)).rejects.toThrow(/delet/i);expect(f.business).toEqual([]);
  await expect(f.current.updateEntry(f.entry.id,{title:'Resurrection'})).rejects.toThrow(/delet/i);
  expect(await f.store.list()).toHaveLength(1);
 }finally{f.close();}
});
it.each([false,undefined])('cold capability %s refuses deletion with zero business HTTP and no new envelope',async value=>{
 const f=await fixture();try{
  f.connect();const caps=await f.online.getSyncCapabilities();
  if(value===undefined)delete caps.featureFlags.offlineEntryDelete;else caps.featureFlags.offlineEntryDelete=value;
  f.online.getSyncCapabilities=async()=>caps;await f.current.getSyncCapabilities({replay:false});
  const cold=f.cold();await cold.preferOfflineSnapshot!();f.business.length=0;
  await expect(cold.deleteEntry(f.entry.id)).rejects.toThrow(/refresh/i);expect(f.business).toEqual([]);expect(await f.store.list()).toEqual([]);
 }finally{f.close();}
});
it('absence without an authoritative matching delete journal cannot authorize receipt cleanup',async()=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.entry.id);f.connect();
  const fetch=f.online.fetchSyncChanges!;
  f.online.fetchSyncChanges=async query=>({...await fetch(query),changes:[]});
  await f.current.flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);
  f.online.fetchSyncChanges=fetch;await f.current.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
 }finally{f.close();}
});
it('strict version conflict holds deletion but lets an independent Entry settle; collision and identity mismatch never delete',async()=>{
 const f=await fixture();try{
  await f.current.deleteEntry(f.entry.id);await f.current.updateEntry(f.survivor.id,{title:'Updated survivor'});
  const operation=originalMutationEnvelope((await f.store.list())[0]!);f.connect();
  f.db.prepare('UPDATE entries SET title=? WHERE id=?').run('Server update',f.entry.id);
  await f.current.flushOfflineOutbox!();const held=await f.store.list();expect(held).toHaveLength(1);expect(held[0]!.status).toBe('conflict');
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.survivor.id)).toBe('Updated survivor');
  expect((await f.online.replaySyncOperation!({...operation,baseVersion:operation.baseVersion+1})).status).toBe('failed');
  expect((await f.online.replaySyncOperation!({...operation,opId:randomUUID(),syncEpoch:'another'})).status).toBe('resnapshot-required');
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe(1);
 }finally{f.close();}
});""")
