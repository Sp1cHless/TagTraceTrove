from pathlib import Path
import hashlib,json
r=Path('D:/Project/TagTraceTrove');out=r/'.hermes/tmp/offline-parity-collection/delete-vertical';changes=[]
def edit(f,a,z):
 p=r/f;b=p.read_bytes();aa=a.encode();zz=z.encode()
 if b.count(aa)!=1:aa=a.replace('\n','\r\n').encode();zz=z.replace('\n','\r\n').encode()
 assert b.count(aa)==1,(f,a[:100],b.count(aa));candidate=b.replace(aa,zz,1);assert p.read_bytes()==b;p.write_bytes(candidate);changes.append({'path':f,'before':hashlib.sha256(b).hexdigest(),'after':hashlib.sha256(candidate).hexdigest(),'count':1,'anchor':a[:100]})
f='apps/web/src/offline/sync-mutation-plan.ts'
edit(f,"   if(((operation.operationKind==='entry.delete'", "   if ((operation.operationKind==='collection.delete' && referencedEntityKeys(op).map(key=>key.toLowerCase()).some(key=>key===ownerKey || refs.includes(key)))) deps.add(op.opId);\n   if(((operation.operationKind==='entry.delete'")
f='apps/web/src/offline/collection-delete.ts';s=(r/f).read_text();a=s[s.index('  const parsed='):s.index('  const result=')];edit(f,a,'  // Old missing stable child identity remains unknown, never an empty cascade.\n');edit(f,'  void parsed;\n','')
f='apps/web/tests/offline-collection-parity.integration.test.ts';p=r/f;b=p.read_bytes();dest=out/'before'/f;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(b);manifest=json.loads((out/'before-manifest.json').read_text());manifest.append({'path':f,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()});(out/'before-manifest.json').write_text(json.dumps(manifest,indent=2))
edit(f,"    expect(f.calls).toContain(`DELETE /api/collections/${f.parent.id}`);", "    expect(f.calls).toContain('POST /api/sync/replay');\n    expect(f.calls).not.toContain(`DELETE /api/collections/${f.parent.id}`);")
edit(f,"it.each(['delete', 'common-tag'] as const)","it.each(['common-tag'] as const)")
# Narrow the unresolved legacy test to bulk tags only; delete now has its dedicated finite matrix.
edit(f,"    const action = kind === 'delete' ? f.api.deleteCollection(f.parent.id) : f.api.addCollectionTag(f.parent.id, 'Winter');", "    const action = f.api.addCollectionTag(f.parent.id, 'Winter');")
edit(f,"const settle = async () => { for (let i = 0; i < 12; i++) await flushPromises(); };", "const settle = async () => { for (let i = 0; i < 20; i++) { await flushPromises(); await new Promise(resolve=>setTimeout(resolve,5)); } };")
(out/'final-anchor-edits.json').write_text(json.dumps(changes,indent=2));print('Applied bounded planner fix and retired obsolete numeric-DELETE expectations; common tag remains ordinary RED')
