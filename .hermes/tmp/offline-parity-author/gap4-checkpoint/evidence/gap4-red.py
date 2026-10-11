from guard import ROOT,STAGE,edit
p='apps/web/tests/offline-author-parity.integration.test.ts'
test=r'''it('actual GalleryApp standalone Author opens direct edit and cold ordinary editing families replay exact originals',async()=>{
 const f=await fixture();setLocale('en');let wrapper:ReturnType<typeof mount>|undefined;
 try{
  wrapper=mount(GalleryApp,{props:{api:f.current}});await settle();
  const add=wrapper.findAll('button').find(row=>row.text()==='Add Author');expect(add).toBeDefined();await add!.trigger('click');await settle();
  await wrapper.get('input[name="name"]').setValue('Cold standalone');await wrapper.get('input[name="occupation"]').setValue('Artist');await wrapper.get('input[name="artworkRef"]').setValue('https://example.invalid/new.webp');await wrapper.get('textarea').setValue('Created content');await wrapper.get('form').trigger('submit');await settle();
  const created=(await f.store.list()).find(row=>row.operationKind==='producer.create')!;expect(created).toBeDefined();const uid=created.entityUid;
  const detail=wrapper.get('[data-testid="author-information-board"]');expect(detail.text()).toContain('Cold standalone');await wrapper.get('[data-testid="start-author-editing"]').trigger('click');
  await wrapper.get('input[name="authorName"]').setValue('Cold renamed');await wrapper.get('input[name="authorOccupation"]').setValue('Writer');await wrapper.get('input[name="authorArtwork"]').setValue('https://example.invalid/edited.webp');await wrapper.get('textarea[name="authorContent"]').setValue('Edited content');await wrapper.get('.author-edit-form').trigger('submit');await settle();
  const id=(await f.current.getAuthorList()).find(row=>row.name==='Cold renamed')?.id;void id;
  const local=(await f.current.getAuthor((await f.current.createAuthor({name:'Temporary identity lookup',occupation:'',artworkRef:'',content:''})).id));void local;
  wrapper.unmount();wrapper=undefined;
  const createRows=await f.store.list();const extra=createRows.find(row=>row.operationKind==='producer.create' && row.entityUid!==uid)!;await f.store.removeMany([extra.opId]);
  const {localCollectionId}=await import('../src/offline/local-identity.js');const authorId=localCollectionId(uid);
  expect(authorId).toBeLessThan(0);const cold=f.cold();await cold.preferOfflineSnapshot!();
  const {default:AuthorPage}=await import('../src/AuthorPage.vue');wrapper=mount(AuthorPage,{props:{api:cold,authors:[],initialAuthorId:authorId}});await settle();await wrapper.get('[data-testid="start-author-editing"]').trigger('click');
  await wrapper.get('[data-testid="author-tag-row"] .add-button').trigger('click');await wrapper.get('input[name="authorTagName"]').setValue('New own tag');await wrapper.get('input[name="authorTagName"]').trigger('keydown',{key:'Enter'});await settle();expect((await cold.getAuthor(authorId)).tags.map(row=>row.name)).toEqual(['New own tag']);
  await wrapper.get('[data-testid="author-view-later-button"]').trigger('click');await settle();expect((await cold.getViewLaterState()).producerIds).toContain(authorId);
  await cold.setAuthorGalleryAnchor(authorId,'comic');
  const slot=await cold.createAuthorRatingSlot(authorId,'New works rating');await cold.setAuthorRating(authorId,slot.id,4);
  const self=await cold.createAuthorRatingSlot(authorId,'New self rating','author_self');await cold.setAuthorRating(authorId,self.id,3.5);
  await cold.linkEntryAuthor(f.survivor.id,authorId);wrapper.unmount();wrapper=undefined;
  const originals=(await f.store.list()).map(originalMutationEnvelope);f.connect();f.loseReplay();await cold.flushOfflineOutbox!();expect(f.db.prepare('SELECT count(*) FROM producers WHERE sync_uid=?').pluck().get(uid)).toBe(1);
  const retry=f.cold();f.loseAck();await retry.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);const final=f.cold();await final.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  const numeric=Number(f.db.prepare('SELECT id FROM producers WHERE sync_uid=?').pluck().get(uid));expect(numeric).toBeGreaterThan(0);const after=await final.getAuthor(numeric);expect(after).toMatchObject({name:'Cold renamed',occupation:'Writer',artworkRef:'https://example.invalid/edited.webp',content:'Edited content',galleryType:'comic'});expect(after.tags.map(row=>row.name)).toEqual(['New own tag']);expect(after.ratings[0]?.stars).toBe(4);expect(after.authorSelfRatings?.[0]?.stars).toBe(3.5);expect((await final.getViewLaterState()).producerIds).toContain(numeric);expect((await final.queryEntryPage({...entryPageQueryRequestSchema.parse({}),authorIds:[numeric]})).items.map(row=>row.id)).toEqual([f.survivor.id]);
  for(const original of originals){const bodies=f.bodies.filter(body=>JSON.parse(body).opId===original.opId);expect(bodies.length).toBeGreaterThanOrEqual(2);expect(new Set(bodies).size).toBe(1);expect(JSON.parse(bodies[0]!)).toEqual(original);}
 }finally{wrapper?.unmount();f.close();}
});
'''
# Resolve local identity from actual production helper without injecting operations.
s=(ROOT/'apps/web/src/offline/offline-api.ts').read_text();import re
m=re.search(r"import \{[^}]*localCollectionId[^}]*\} from '([^']+)';",s);print('local identity import',m.group(1) if m else 'inline')
# Avoid artificial lookup creates: obtain ID through the API's canonical create return captured by call-through spy.
test=test.replace("  wrapper=mount(GalleryApp", "  const createSpy=vi.spyOn(f.current,'createAuthor');wrapper=mount(GalleryApp",1)
a=test.index('  const id=');b=test.index('  expect(authorId)')
test=test[:a]+'''  const authorId=(await createSpy.mock.results[0]!.value).id;wrapper.unmount();wrapper=undefined;
'''+test[b:]
edit(p,"it('mixed Author profile anchor tag rating and viewlater edits settle only behind verified final deletion',async()=>{",test+"it('mixed Author profile anchor tag rating and viewlater edits settle only behind verified final deletion',async()=>{")
