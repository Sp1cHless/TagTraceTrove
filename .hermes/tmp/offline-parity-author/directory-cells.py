from guard import edit
p='apps/web/tests/offline-author-parity.integration.test.ts'
edit(p,"it('held owned Directory blocks Author deletion while independent owner progresses then settles exact ACK retry',async()=>{",'''it('actual Author Directory create move rename then ordinary delete cascades only owned relationships',async()=>{
 const f=await fixture(false);setLocale('en');vi.stubGlobal('scrollTo',vi.fn());let wrapper:ReturnType<typeof mount>|undefined;
 try{
  const peer=await f.online.createAuthor({name:'Other Author',occupation:'',artworkRef:'',content:''});
  await f.online.linkEntryAuthor(f.entry.id,peer.id);await f.online.linkEntryAuthor(f.survivor.id,peer.id);
  const peerDir=await f.online.createAuthorDirectory(peer.id,{title:'Other Directory',entryIds:[f.survivor.id]});
  const existing=await f.online.createAuthorDirectory(f.author.id,{title:'Old Directory'});
  for(let i=0;i<6;i++)await f.online.updateAuthorDirectory(existing.id,{title:'Old Directory '+i});
  await f.online.assignAuthorTag(f.author.id,'Owned tag');await f.online.assignAuthorTag(peer.id,'Other tag');
  await f.online.setAuthorGalleryAnchor(f.author.id,'comic');await f.online.setAuthorGalleryAnchor(peer.id,'comic');
  const slot=await f.online.createAuthorRatingSlot(f.author.id,'Shared slot');await f.online.setAuthorRating(f.author.id,slot.id,4);await f.online.setAuthorRating(peer.id,slot.id,3);
  await f.online.addViewLaterAuthor(f.author.id);await f.online.addViewLaterAuthor(peer.id);
  const collection=await f.online.createCollection({kind:'producer',title:'Shared collection'});await f.online.addCollectionProducer(collection.id,f.author.id);await f.online.addCollectionProducer(collection.id,peer.id);
  const before=await f.online.fetchSyncSnapshot();await f.store.writeGeneration(2,JSON.stringify(before));await f.store.writeMeta('activeGeneration','2');await f.current.preferOfflineSnapshot!();f.disconnect();f.business.length=0;
  wrapper=mount(GalleryApp,{props:{api:f.current}});await settle();await wrapper.get('.author-link').trigger('click');await settle();await wrapper.get(`[data-author-id="${f.author.id}"]`).trigger('click');await settle();await wrapper.get('[data-testid="start-author-editing"]').trigger('click');await settle();
  await wrapper.get('[data-testid="add-author-directory"]').trigger('click');await settle();
  const directory=(await f.current.getAuthor(f.author.id)).directories.find(row=>row.id!==existing.id)!;expect(directory).toBeDefined();
  await wrapper.get(`[data-entry-id="${f.entry.id}"]`).trigger('click');await settle();await wrapper.get(`[data-move-work-to-directory-id="${directory.id}"]`).trigger('click');await settle();
  await wrapper.get(`[data-author-directory-id="${directory.id}"] [data-directory-open]`).trigger('click');await settle();await wrapper.get('[data-testid="start-directory-editing"]').trigger('click');await wrapper.get('input[name="directoryTitle"]').setValue('Renamed Directory');await wrapper.get('[data-testid="finish-directory-editing"]').trigger('click');await settle();
  const back=wrapper.findAll('button').find(row=>row.text().includes('Back to'));expect(back).toBeDefined();await back!.trigger('click');await settle();
  if(!wrapper.find('[data-testid="delete-author"]').exists()){await wrapper.get('[data-testid="start-author-editing"]').trigger('click');await settle();}
  await wrapper.get('[data-testid="delete-author"]').trigger('click');await wrapper.get('[data-testid="delete-author"]').trigger('click');await settle();wrapper.unmount();wrapper=undefined;
  const originals=(await f.store.list()).map(originalMutationEnvelope);expect(originals.filter(row=>row.operationKind==='author.directories.set')).toHaveLength(3);
  expect(originals[0]!.baseVersion).toBeGreaterThan(originals.at(-1)!.baseVersion);expect(f.business).toEqual([]);
  const cold=f.cold();await cold.preferOfflineSnapshot!();expect((await cold.queryProducerPage(producerPageQueryRequestSchema.parse({}))).items.map(row=>row.id)).toEqual([peer.id]);expect((await cold.getAuthor(peer.id)).directories.map(row=>row.id)).toEqual([peerDir.id]);expect(await cold.listCollectionsForProducer(peer.id)).toEqual([collection.id]);expect((await cold.getViewLater()).producerIds).toEqual([peer.id]);expect((await cold.queryEntryPage(entryPageQueryRequestSchema.parse({entryType:'comic'}))).total).toBe(2);
  f.connect();f.loseAck();await cold.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);
  const final=f.cold();await final.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  const after=await f.online.fetchSyncSnapshot();expect(after.payload.entries).toEqual(before.payload.entries);expect(after.payload.ratingSlots).toEqual(before.payload.ratingSlots);expect(after.payload.ratingLayouts).toEqual(before.payload.ratingLayouts);
  for(const key of ['producers','producerTagAssignments','authorDirectories','authorDirectorySets','producerRatingValues','viewLaterProducers'] as const)expect(after.payload[key]).toEqual(before.payload[key]!.filter(row=>('producerId' in row?row.producerId:'subjectId' in row?row.subjectId:row.id)!==f.author.id));
  expect(after.payload.authorDirectoryEntries).toEqual(before.payload.authorDirectoryEntries);expect(after.payload.collectionMembers).toEqual(before.payload.collectionMembers.filter(row=>!('producerId' in row)||row.producerId!==f.author.id));expect(after.payload.collections.map(row=>row.id)).toEqual(before.payload.collections.map(row=>row.id));
  for(const original of originals)expect(f.bodies.map(body=>JSON.parse(body)).filter(body=>body.opId===original.opId)).toEqual([original,original]);
 }finally{wrapper?.unmount();f.close();vi.unstubAllGlobals();}
});
it('held Collection Producer membership blocks Author delete but independent Entry progresses',async()=>{
 const f=await fixture(false);try{
  const collection=await f.online.createCollection({kind:'producer',title:'Held membership'});await f.store.writeGeneration(2,JSON.stringify(await f.online.fetchSyncSnapshot()));await f.store.writeMeta('activeGeneration','2');await f.current.preferOfflineSnapshot!();f.disconnect();
  await f.current.addCollectionProducer(collection.id,f.author.id);const held=(await f.store.list())[0]!;await f.store.update(held.opId,{status:'conflict',lastError:'Held Collection'});await f.current.deleteAuthor(f.author.id);await f.current.updateEntry(f.survivor.id,{title:'Collection independent'});
  const originals=(await f.store.list()).map(originalMutationEnvelope);f.connect();await f.current.flushOfflineOutbox!();expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(1);expect(f.db.prepare('SELECT title FROM entries WHERE id=?').pluck().get(f.survivor.id)).toBe('Collection independent');expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals.slice(0,2));
  await f.store.update(held.opId,{status:'pending',lastError:null});f.loseAck();await f.current.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals.slice(0,2));const cold=f.cold();await cold.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);expect((await f.online.listCollections('producer')).map(row=>row.id)).toEqual([collection.id]);expect(await f.online.listCollectionsForProducer(f.author.id)).toEqual([]);
 }finally{f.close();}
});
for(const mode of ['wrong UUID','noncausal seq','unknown scope'] as const)it(`Directory deletion settlement retains originals for ${mode}`,async()=>{
 const f=await fixture();try{
  await f.current.createAuthorDirectory(f.author.id,{title:'Receipt boundary'});await f.current.deleteAuthor(f.author.id);const originals=(await f.store.list()).map(originalMutationEnvelope);f.connect();
  if(mode==='unknown scope'){
   f.loseAck();await f.current.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);await f.store.writeMeta('authorDirectoryScope.'+originals[0]!.opId,JSON.stringify({nativeReceipt:{producerUid:originals[1]!.entityUid}}));
  }else{
   const replay=f.online.replaySyncOperation.bind(f.online);vi.spyOn(f.online,'replaySyncOperation').mockImplementation(async operation=>{const receipt=await replay(operation);return operation.operationKind==='author.directories.set' && receipt.status==='applied'?{...receipt,...(mode==='wrong UUID'?{opId:randomUUID()}:{serverSeq:Number.MAX_SAFE_INTEGER})}:receipt;});
  }
  const cold=f.cold();await cold.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);
 }finally{f.close();vi.restoreAllMocks();}
});
it('held owned Directory blocks Author deletion while independent owner progresses then settles exact ACK retry',async()=>{''')
