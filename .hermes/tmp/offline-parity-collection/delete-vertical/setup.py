from pathlib import Path
import hashlib,json
r=Path('D:/Project/TagTraceTrove'); out=r/'.hermes/tmp/offline-parity-collection/delete-vertical'; out.mkdir(parents=True,exist_ok=True)
files=['packages/shared/src/schemas/sync.ts','packages/shared/src/schemas/native-mutation-contract.ts','apps/server/src/sync/sync-service.ts','apps/server/src/sync/replay-service.ts','apps/server/src/http/app.ts','apps/web/src/api/gallery.ts','apps/web/src/offline/offline-api.ts','apps/web/src/offline/sync-mutation-plan.ts','apps/web/src/offline/pending-work-restore.ts']
manifest=[]
for f in files:
 b=(r/f).read_bytes(); p=out/'before'/f;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);manifest.append({'path':f,'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b)})
(out/'before-manifest.json').write_text(json.dumps(manifest,indent=2))
s=(r/'apps/web/tests/offline-collection-parity.integration.test.ts').read_text(encoding='utf-8').split("it('ordinary common-tag")[0]
s=s.replace("import { expect, it, vi }", "import { originalMutationEnvelope } from '../src/offline/sync-mutation-plan.js';\nimport { expect, it, vi }")
s=s.replace('let disconnected = false;', 'let disconnected = false, loseReplay = false, loseAck = false;\n  const bodies: string[] = [];')
s=s.replace('return app.request(url.pathname + url.search, init);', "if (url.pathname === '/api/sync/replay') bodies.push(String(init?.body));\n    const response = await app.request(url.pathname + url.search, init);\n    if (loseReplay && url.pathname === '/api/sync/replay' && response.ok) {loseReplay=false;throw new TypeError('Replay response lost');}\n    if (loseAck && url.pathname.includes('/ack') && response.ok) {loseAck=false;throw new TypeError('ACK response lost');}\n    return response;")
s=s.replace('const store = createIndexedDbOfflineStore({ indexedDB: new IDBFactory(), databaseName: randomUUID() });', 'const indexedDB = new IDBFactory(), databaseName = randomUUID();\n  let store = createIndexedDbOfflineStore({ indexedDB, databaseName });')
s=s.replace('api, calls, store,', "api, calls, bodies, get store(){return store;},\n    connect(){disconnected=false;}, loseReplay(){loseReplay=true;},loseAck(){loseAck=true;},\n    cold(){store.close();store=createIndexedDbOfflineStore({indexedDB,databaseName});return createOfflineAwareGalleryApi(online,store,{clientId:'collection-parity-phone',randomUUID});},")
s+='''it('Collection delete actual double-confirm projects root and child cold, commits SQL, and retains exact originals across replay and ACK loss', async () => {
  const f=await fixture(); setLocale('en');showNsfw.value=true;vi.stubGlobal('scrollTo',vi.fn());
  let wrapper:ReturnType<typeof mount>|undefined;
  try {
    await f.online.addCollectionTag(f.parent.id,'Winter');await f.offline();
    wrapper=mount(CollectionsPage,{props:{api:f.api}});await settle();
    await wrapper.get('[data-testid="collections-edit-toggle"]').trigger('click');f.calls.length=0;
    await wrapper.get(`[data-testid="delete-collection-${f.parent.id}"]`).trigger('click');expect(await f.store.list()).toEqual([]);
    await wrapper.get(`[data-testid="delete-collection-${f.parent.id}"]`).trigger('click');await settle();
    expect(f.calls).toEqual([]);expect((await f.store.list()).map(row=>row.operationKind)).toEqual(['collection.delete']);
    wrapper.unmount();wrapper=undefined;
    const originals=(await f.store.list()).map(originalMutationEnvelope);const cold=f.cold();await cold.preferOfflineSnapshot!();
    expect((await cold.listCollections('entry',true)).map(row=>row.id)).toEqual([f.peer.id]);
    f.connect();f.loseReplay();await cold.flushOfflineOutbox!();
    expect(f.db.prepare('SELECT id FROM collections ORDER BY id').pluck().all()).toEqual([f.peer.id]);
    const retry=f.cold();f.loseAck();await retry.flushOfflineOutbox!();expect((await f.store.list()).map(originalMutationEnvelope)).toEqual(originals);
    const final=f.cold();await final.flushOfflineOutbox!();expect(await f.store.list()).toEqual([]);
    expect(f.bodies.filter(body=>JSON.parse(body).opId===originals[0]!.opId).length).toBeGreaterThanOrEqual(3);
    expect(new Set(f.bodies).size).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(3);
    expect(f.db.prepare('SELECT count(*) FROM producers').pluck().get()).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM entry_producers').pluck().get()).toBe(1);
    expect(f.db.prepare('SELECT count(*) FROM entry_tags').pluck().get()).toBe(2);
    expect(f.db.prepare('SELECT collection_id,entry_id FROM collection_entries').all()).toEqual([{collection_id:f.peer.id,entry_id:f.work.id}]);
  } finally {wrapper?.unmount();f.close();vi.unstubAllGlobals();}
});
'''
p=r/'apps/web/tests/offline-collection-delete.integration.test.ts';assert not p.exists();p.write_text(s,encoding='utf-8')
(out/'finite-cells.json').write_text(json.dumps(['caller/cold/cascade/replay+ACKloss','connected-noCopy+oldCopy','root-child-Author-empty scope','concurrent child add/edit rejection','held predecessor + independent Entry','capabilities false/absent + legacy unknown','restore export/exact + later write refusal','corrupt/foreign authority zero cleanup'],indent=2))
print('Registered',len(files),'before files; created caller RED test')
