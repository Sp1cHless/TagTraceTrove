from edit import edit
p='apps/web/tests/offline-entry-delete.integration.test.ts'
edit(p,"it('known-offline deleted detail refuses locally rather than business HTTP; post-delete writes cannot recreate it',async()=>{", """it('Author Tag Content usage View-later and media predecessors settle only against final authoritative delete',async()=>{
 const f=await fixture();try{
  await f.current.linkEntryAuthorByName(f.entry.id,'New retained Author');
  const detail=await f.current.getEntry(f.entry.id);const facet=detail.sections.flatMap(section=>section.facets)[0]!;
  await f.current.assignEntryTag(f.entry.id,{name:'delete timeline',facetId:facet.id});
  await f.current.createEntryContent(f.entry.id,{contentType:'Note',content:'before delete'});
  await f.current.likeEntry(f.entry.id);await f.current.addViewLaterEntry(f.entry.id);
  const sharp=(await import('sharp')).default;const png=await sharp({create:{width:2,height:2,channels:4,background:'#ff0000'}}).png().toBuffer();
  await f.current.uploadEntryMedia(f.entry.id,'preview',new File([png],'preview.png',{type:'image/png'}));
  await f.current.deleteEntry(f.entry.id);const operations=await f.store.list();const media=await f.store.listMedia();expect(media).toHaveLength(1);
  f.connect();const state:import('../src/offline/offline-api.js').OfflineApiState={mode:'offline'};const cold=f.cold(state);await cold.flushOfflineOutbox!();
  expect(f.db.prepare('SELECT count(*) FROM entries WHERE id=?').pluck().get(f.entry.id)).toBe(0);
  expect(await f.store.list(),state.lastReplayError ?? undefined).toEqual([]);expect(await f.store.listMedia()).toEqual([]);
  expect(operations.length).toBeGreaterThan(4);expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(2);
 }finally{f.close();}
});
it('restore rejects a later write to a deleted owner atomically and retains current exact operations',async()=>{
 const f=await fixture();try{
  await f.current.updateEntry(f.entry.id,{title:'Before'});const update=originalMutationEnvelope((await f.store.list())[0]!);
  await f.current.deleteEntry(f.entry.id);const before=await f.store.list();const backup=await buildPendingWorkExport(f.store);
  const bad={...backup,operations:[...backup.operations,{...update,opId:randomUUID()}]};
  await expect(f.current.restorePendingWork!(JSON.stringify(bad))).rejects.toThrow();expect(await f.store.list()).toEqual(before);
 }finally{f.close();}
});
it('known-offline deleted detail refuses locally rather than business HTTP; post-delete writes cannot recreate it',async()=>{""")
