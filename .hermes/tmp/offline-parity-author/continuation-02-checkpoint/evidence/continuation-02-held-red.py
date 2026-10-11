from guard import edit
edit('apps/web/tests/offline-author-parity.integration.test.ts',"\nit('actual GalleryApp Author delete", """
it('Author deletion waits for a held referencing Entry while an independent Entry progresses',async()=>{
 const f=await fixture();try{
  await f.current.linkEntryAuthor(f.survivor.id,f.author.id);
  const held=(await f.store.list())[0]!;await f.store.update(held.opId,{status:'conflict',lastError:'Held reference'});
  await f.current.deleteAuthor(f.author.id);
  await f.current.updateEntry(f.entry.id,{title:'Independent progressed'});
  const originals=(await f.store.list()).map(originalMutationEnvelope);
  f.connect();await f.current.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(1);
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe('Independent progressed');
  expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals.slice(0,2));
  await f.store.update(held.opId,{status:'pending',lastError:null});await f.current.flushOfflineOutbox!();
  expect(await f.store.list()).toEqual([]);expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(0);
 }finally{f.close();}
});
it('actual GalleryApp Author delete""")
