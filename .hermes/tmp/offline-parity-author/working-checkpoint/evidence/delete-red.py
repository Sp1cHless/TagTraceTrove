from guard import *
f='apps/web/tests/offline-author-parity.integration.test.ts'
edit(f,"await page.get('textarea').setValue('Profile');", "await page.get('input[name=\"artworkRef\"]').setValue('https://example.invalid/artwork.webp');await page.get('textarea').setValue('Profile');")
edit(f,"expect((await cold.getAuthor(id)).occupation).toBe('Artist');", "expect(await cold.getAuthor(id)).toMatchObject({occupation:'Artist',content:'Profile',artworkRef:'https://example.invalid/artwork.webp'});")
edit(f," }finally{f.close();}\n});", """ }finally{f.close();}
});
it('actual GalleryApp Author delete preserves works and cold absence then exact receipt and ACK retry',async()=>{
 const f=await fixture();setLocale('en');vi.stubGlobal('scrollTo',vi.fn());const wrapper=mount(GalleryApp,{props:{api:f.current}});
 try{
  await settle();const authors=wrapper.findAll('button').find(button=>button.text()==='Authors');expect(authors).toBeDefined();await authors!.trigger('click');await settle();
  await wrapper.get(`[data-author-id="${f.author.id}"]`).trigger('click');await settle();
  f.business.length=0;const button=wrapper.get('[data-testid="delete-author"]');await button.trigger('click');expect(await f.store.list()).toEqual([]);
  await button.trigger('click');await settle();expect((await f.store.list()).map(row=>row.operationKind)).toEqual(['producer.delete']);expect(f.business).toEqual([]);
  const cold=f.cold();await cold.preferOfflineSnapshot!();expect((await cold.queryProducerPage(producerPageQueryRequestSchema.parse({}))).total).toBe(0);
  expect((await cold.queryEntryPage(entryPageQueryRequestSchema.parse({entryType:'comic'}))).total).toBe(2);
  const original=originalMutationEnvelope((await f.store.list())[0]!);f.connect();f.loseReplay();await cold.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(f.author.id)).toBe(0);expect(f.db.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(2);
  const retry=f.cold();f.loseAck();await retry.flushOfflineOutbox!();expect(await f.store.list()).toHaveLength(1);await retry.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  expect(f.bodies.map(body=>JSON.parse(body)).filter(body=>body.opId===original.opId)).toEqual([original,original,original]);
 }finally{wrapper.unmount();f.close();vi.unstubAllGlobals();}
});""")
