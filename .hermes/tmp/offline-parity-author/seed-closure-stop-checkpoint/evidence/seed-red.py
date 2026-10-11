from pathlib import Path
import hashlib
p=Path('apps/web/tests/offline-author-parity.integration.test.ts'); b=p.read_bytes(); assert hashlib.sha256(b).hexdigest()=='613d72d142bf526652f71c465ed39e8d654e8147591730c08b8382ae8cfef2f3'
s='''
it('new standalone Directory seed survives actual cold Directory gestures restore SQL response and ACK loss',async()=>{
 const f=await fixture();setLocale('en');let wrapper:ReturnType<typeof mount>|undefined;
 try{
  const spy=vi.spyOn(f.current,'createAuthor');wrapper=mount(GalleryApp,{props:{api:f.current}});await settle();await wrapper.get('[data-testid="new-author"]').trigger('click');await settle();await wrapper.get('input[name="name"]').setValue('Seed Author');await wrapper.get('form').trigger('submit');await settle();
  expect(wrapper.get('[data-testid="author-information-board"]').text()).toContain('Seed Author');const id=(await spy.mock.results[0]!.value).id;const create=(await f.store.list())[0]!;
  expect(create.payload.directorySetUid).toEqual(expect.any(String));expect(create.payload.directorySetUid).not.toBe(create.entityUid);
  await f.current.linkEntryAuthor(f.entry.id,id);await f.current.linkEntryAuthor(f.survivor.id,id);wrapper.unmount();wrapper=undefined;
  let cold=f.cold();await cold.preferOfflineSnapshot!();const {default:AuthorPage}=await import('../src/AuthorPage.vue');wrapper=mount(AuthorPage,{props:{api:cold,authors:[],initialAuthorId:id}});await settle();await wrapper.get('[data-testid="start-author-editing"]').trigger('click');await settle();await wrapper.get(`[data-author-work-id="${f.entry.id}"]`).trigger('dragstart');await wrapper.get(`[data-author-work-id="${f.survivor.id}"]`).trigger('drop');await settle();
  const directory=(await cold.getAuthor(id)).directories[0]!;expect(directory).toBeDefined();await wrapper.get(`[data-author-directory-id="${directory.id}"] [data-directory-open]`).trigger('click');await settle();await wrapper.get('[data-testid="start-directory-editing"]').trigger('click');await wrapper.get(`[data-entry-id="${f.entry.id}"]`).trigger('click');await wrapper.get('[data-testid="directory-remove-target"]').trigger('click');await settle();await wrapper.get('input[name="directoryTitle"]').setValue('Seed renamed');await wrapper.get('[data-testid="finish-directory-editing"]').trigger('click');await settle();wrapper.unmount();wrapper=undefined;
  const originals=(await f.store.list()).map(originalMutationEnvelope);expect(originals.filter(row=>row.operationKind==='author.directories.set')).toHaveLength(3);const exported=JSON.stringify(await buildPendingWorkExport(f.store));await f.store.removeMany(originals.map(row=>row.opId));cold=f.cold();await cold.restorePendingWork!(exported);await cold.preferOfflineSnapshot!();expect((await cold.getAuthor(id)).directories[0]).toMatchObject({title:'Seed renamed',entryCount:1});
  await cold.updateAuthorDirectory(directory.id,{title:'Restored continued'});const finalOriginals=(await f.store.list()).map(originalMutationEnvelope);f.connect();f.loseReplay();await cold.flushOfflineOutbox!();f.loseAck();cold=f.cold();await cold.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(finalOriginals);cold=f.cold();await cold.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  const snapshot=await f.online.fetchSyncSnapshot();const owner=snapshot.payload.producers.find(row=>row.syncUid===create.entityUid)!;expect(owner.id).toBeGreaterThan(0);expect(snapshot.payload.producers.filter(row=>row.syncUid===create.entityUid)).toHaveLength(1);expect(snapshot.payload.authorDirectorySets!.find(row=>row.producerId===owner.id)!.syncUid).toBe(create.payload.directorySetUid);expect((await f.online.getAuthor(owner.id)).directories[0]).toMatchObject({title:'Restored continued',entryCount:1});
  for(const original of finalOriginals)expect(new Set(f.bodies.filter(body=>JSON.parse(body).opId===original.opId)).size).toBe(1);
 }finally{wrapper?.unmount();f.close();}
});
'''
p.write_bytes(b+s.encode());print('test added')
