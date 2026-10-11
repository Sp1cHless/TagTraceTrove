from guard import edit
p='apps/web/tests/offline-author-parity.integration.test.ts'
edit(p,"it('actual GalleryApp Author delete preserves works and cold absence then exact receipt and ACK retry',async()=>{",'''it('held owned Directory blocks Author deletion while independent owner progresses then settles exact ACK retry',async()=>{
 const f=await fixture();try{
  await f.current.createAuthorDirectory(f.author.id,{title:'Owned',entryIds:[f.entry.id]});
  const held=(await f.store.list())[0]!;expect(held.entityUid).not.toBe(f.author.syncUid);
  await f.store.update(held.opId,{status:'conflict',lastError:'Held Directory'});
  await f.current.deleteAuthor(f.author.id);await f.current.updateEntry(f.survivor.id,{title:'Independent Directory owner'});
  const originals=(await f.store.list()).map(originalMutationEnvelope);
  f.connect();await f.current.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(1);
  expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.survivor.id)).toBe('Independent Directory owner');
  expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals.slice(0,2));
  await f.store.update(held.opId,{status:'pending',lastError:null});f.loseAck();const retry=f.cold();await retry.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(0);
  expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals.slice(0,2));
  const final=f.cold();await final.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  for(const original of originals.slice(0,2))expect(f.bodies.map(body=>JSON.parse(body)).filter(body=>body.opId===original.opId)).toEqual([original,original]);
 }finally{f.close();}
});
it('actual GalleryApp Author delete preserves works and cold absence then exact receipt and ACK retry',async()=>{''')
