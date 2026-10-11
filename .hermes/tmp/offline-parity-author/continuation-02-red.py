from guard import edit
edit('apps/web/tests/offline-author-parity.integration.test.ts', "\nit('actual GalleryApp Author delete", """
it('mixed Author profile anchor tag rating and viewlater edits settle only behind verified final deletion',async()=>{
 const f=await fixture();try{
  await f.current.updateAuthor(f.author.id,{content:'Before delete'});
  await f.current.setAuthorGalleryAnchor(f.author.id,'comic');
  await f.current.assignAuthorTag(f.author.id,'Owned tag');
  const slot=await f.current.createAuthorRatingSlot(f.author.id,'Self');
  await f.current.setAuthorRating(f.author.id,slot.id,4);
  await f.current.setProducerViewLater(f.author.id,true);
  await f.current.deleteAuthor(f.author.id);
  const originals=(await f.store.list()).map(originalMutationEnvelope);
  f.connect();f.loseAck();const retry=f.cold();await retry.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(0);
  expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);
  await retry.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  expect(f.db.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(2);
 }finally{f.close();}
});
it('actual GalleryApp Author delete""")
