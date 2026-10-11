from run import edit,gate
P='apps/web/tests/offline-author-parity.integration.test.ts'
edit(P,'const app=createApiApp(db,{assetRoot:root});','const app=createApiApp(db,{assetRoot:join(root,\'assets\'),dataDir:root});')
edit(P,"it('mixed Author profile anchor tag rating and viewlater edits settle only behind verified final deletion',async()=>{",'''for(const oldCopy of [false,true])it(`bounded connected Author delete ${oldCopy?'created after old copy':'without installed copy'} keeps exact cold retries and works`,async()=>{
 const f=await fixture(oldCopy);try{
  f.connect();await f.current.getSyncCapabilities({replay:false});
  const author=oldCopy?await f.online.createAuthor({name:'After installed copy'}):f.author;
  if(oldCopy)await f.online.linkEntryAuthor(f.survivor.id,author.id);
  const identity=await f.online.getAuthorSyncIdentity!(author.id);f.business.length=0;
  expect(await f.store.readMeta('activeGeneration')).toBe(oldCopy?'1':null);
  f.loseReplay();await f.current.deleteAuthor(author.id);
  const original=originalMutationEnvelope((await f.store.list())[0]!);
  expect(original).toMatchObject({entityUid:identity.syncUid,baseVersion:identity.syncVersion,libraryId:identity.libraryId,syncEpoch:identity.syncEpoch,operationKind:'producer.delete'});
  expect(f.business[0]).toBe(`/api/producers/${author.id}/sync-identity`);
  expect(f.business.indexOf('/api/sync/replay')).toBeGreaterThan(0);
  expect(f.business).not.toContain('/api/producers');expect(f.business.some(path=>path.startsWith('/api/assets'))).toBe(false);
  expect(f.db.prepare('SELECT count(*) FROM producers WHERE id=?').pluck().get(author.id)).toBe(0);
  expect(f.db.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(2);
  f.loseAck();const retry=f.cold();await retry.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual([original]);
  const final=f.cold();await final.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
  expect(f.bodies.map(body=>JSON.parse(body)).filter(body=>body.opId===original.opId)).toEqual([original,original,original]);
 }finally{f.close();}
});

it('mixed Author profile anchor tag rating and viewlater edits settle only behind verified final deletion',async()=>{''')
gate('connected-first',['node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts',P,'--maxWorkers','2','--testTimeout','30000','-t','bounded connected'])
