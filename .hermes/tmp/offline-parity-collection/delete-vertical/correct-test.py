from pathlib import Path
r=Path('D:/Project/TagTraceTrove');p=r/'apps/web/tests/offline-collection-delete.integration.test.ts';b=p.read_bytes();s=b.decode();e='\r\n' if '\r\n' in s else '\n';s=s.replace('\r\n','\n')
a=" const {computeSnapshotChecksum}=await import('../src/offline/snapshot-store.js');value.header.checksum=await computeSnapshotChecksum(value);";assert s.count(a)==1;s=s.replace(a," const {createHash}=await import('node:crypto');const {checksum,...header}=value.header;void checksum;value.header.checksum=createHash('sha256').update(JSON.stringify(header)+JSON.stringify(value.payload)).digest('hex');")
a="  await f.api.deleteCollection(folder.id);";assert s.count(a)==1;s=s.replace(a,"  f.loseReplay();await f.api.deleteCollection(folder.id);const originals=(await f.store.list()).map(originalMutationEnvelope);expect(originals.length).toBe(1);\n  const retry=f.cold();f.loseAck();await retry.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);await f.cold().flushOfflineOutbox!();expect(new Set(f.bodies).size).toBe(1);")
s+='''
it('held complete Collection order is a root-delete predecessor, not absence authority',async()=>{
 const f=await fixture();try{await f.offline();await f.api.reorderCollections('entry',[f.peer.id,f.parent.id]);const order=(await f.store.list())[0]!;await f.store.update(order.opId,{status:'conflict'});await f.api.deleteCollection(f.parent.id);f.connect();await f.api.flushOfflineOutbox!();
 expect(f.bodies.some(body=>JSON.parse(body).operationKind==='collection.delete')).toBe(false);expect(f.db.prepare('SELECT id FROM collections WHERE id=?').get(f.parent.id)).toBeDefined();
 await f.store.update(order.opId,{status:'pending'});await f.api.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
 }finally{f.close();}
});
'''
assert p.read_bytes()==b;p.write_bytes(s.replace('\n',e).encode());print('corrected legacy checksum harness, expanded existing connected cells and added order RED')
