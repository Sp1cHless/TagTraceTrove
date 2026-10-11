from edit import edit
p='apps/web/tests/offline-entry-delete.integration.test.ts'
edit(p,"  const button=wrapper.get('[data-testid=\"delete-entry\"]');await button.trigger('click');expect(await f.store.list()).toEqual([]);","  f.business.length=0;const button=wrapper.get('[data-testid=\"delete-entry\"]');await button.trigger('click');expect(await f.store.list()).toEqual([]);")
edit(p,"it('known-offline deleted detail refuses locally rather than business HTTP; post-delete writes cannot recreate it',async()=>{", """it('duration edit then delete settles the final deleted owner timeline after cold exact retries',async()=>{
 const f=await fixture();try{
  await f.current.updateEntry(f.entry.id,{title:'Changed',durationSeconds:0});
  await f.current.deleteEntry(f.entry.id);const originals=(await f.store.list()).map(originalMutationEnvelope);
  f.connect();const state:import('../src/offline/offline-api.js').OfflineApiState={mode:'offline'};
  const cold=f.cold(state);await cold.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe(0);
  expect(await f.store.list(),state.lastReplayError ?? undefined).toEqual([]);
  expect(f.bodies.map(body=>JSON.parse(body))).toEqual(originals);
 }finally{f.close();}
});
it('known-offline deleted detail refuses locally rather than business HTTP; post-delete writes cannot recreate it',async()=>{""")
