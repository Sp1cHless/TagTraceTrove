from run import edit,gate
P='apps/web/tests/offline-author-parity.integration.test.ts'
edit(P,"for(const oldCopy of [false,true])it(`bounded connected",'''for(const flag of ['offlineMutations','offlineAuthorDelete'] as const)for(const value of ['0',null])it(`known offline Author delete refuses ${flag} ${value===null?'absent':'false'} locally without queue changes`,async()=>{
 const f=await fixture();try{
  await f.current.updateEntry(f.survivor.id,{title:'Retain queued work'});
  await f.store.writeMeta('capability.'+flag,value);
  const before=JSON.stringify(await f.store.list());const cold=f.cold();await cold.preferOfflineSnapshot!();f.business.length=0;
  await expect(cold.deleteAuthor(f.author.id)).rejects.toThrow('Author deletion is not available under offline');
  expect(f.business).toEqual([]);expect(JSON.stringify(await f.store.list())).toBe(before);
  expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(1);
 }finally{f.close();}
});

for(const oldCopy of [false,true])it(`bounded connected''')
gate('cap-red',['node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts',P,'--maxWorkers','2','--testTimeout','30000','-t','known offline Author delete refuses'])
