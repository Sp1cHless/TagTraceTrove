from guard import *
base=(ROOT/'apps/web/tests/offline-entry-delete.integration.test.ts').read_text(encoding='utf-8').split("it('ordinary existing Entry deletion")[0]
newfile('apps/web/tests/offline-author-parity.integration.test.ts',base+'''\nit('standalone Author actual form creates a durable workless detail, cold edits and links an existing work with exact replay retry',async()=>{
 const f=await fixture();try{
  const {default:AddAuthorPage}=await import('../src/AddAuthorPage.vue');
  let created:Awaited<ReturnType<typeof f.current.createAuthor>>|undefined;
  const page=mount(AddAuthorPage,{props:{submitting:false,onSubmit:async draft=>{created=await f.current.createAuthor(draft);}}});
  await page.get('input[name="name"]').setValue('Standalone');await page.get('input[name="occupation"]').setValue('Artist');
  await page.get('textarea').setValue('Profile');await page.get('form').trigger('submit');await settle();page.unmount();
  expect(created?.name).toBe('Standalone');expect(f.business).toEqual([]);
  const id=created!.id;expect(id).toBeLessThan(0);expect((await f.store.list())[0]?.operationKind).toBe('producer.create');
  const backup=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany((await f.store.list()).map(row=>row.opId));
  const cold=f.cold();await cold.restorePendingWork!(backup);await cold.preferOfflineSnapshot!();
  expect((await cold.getAuthor(id)).occupation).toBe('Artist');expect((await cold.queryProducerPage(producerPageQueryRequestSchema.parse({}))).items).toEqual([expect.objectContaining({id:f.author.id})]);
  await cold.updateAuthor(id,{content:'Edited profile'});await cold.linkEntryAuthor(f.survivor.id,id);
  const originals=(await f.store.list()).map(originalMutationEnvelope);f.connect();f.loseReplay();await cold.flushOfflineOutbox!();
  expect(f.db.prepare("SELECT count(*) FROM producers WHERE name='Standalone'").pluck().get()).toBe(1);
  const retry=f.cold();f.loseAck();await retry.flushOfflineOutbox!();expect((await f.store.list()).length).toBeGreaterThan(0);
  await retry.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  const numeric=Number(f.db.prepare("SELECT id FROM producers WHERE name='Standalone'").pluck().get());
  expect(numeric).toBeGreaterThan(0);expect((await f.online.getAuthor(numeric)).content).toBe('Edited profile');
  expect(f.db.prepare('SELECT count(*) FROM entry_producers WHERE entry_id=? AND producer_id=?').pluck().get(f.survivor.id,numeric)).toBe(1);
  expect(f.bodies.map(body=>JSON.parse(body)).filter(body=>body.opId===originals[0]!.opId)).toEqual([originals[0],originals[0],originals[0]]);
 }finally{f.close();}
});
''')
