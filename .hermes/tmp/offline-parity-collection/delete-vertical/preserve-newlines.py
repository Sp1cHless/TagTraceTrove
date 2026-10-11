from pathlib import Path
import json,hashlib
r=Path('D:/Project/TagTraceTrove');out=r/'.hermes/tmp/offline-parity-collection/delete-vertical'
script=(out/'apply.py').read_text();script=script[:script.index('# Entire batch preflight')];script=script.replace("assert not (r/f).exists();",'').replace(";assert not (r/f).exists()",'').replace("f='apps/web/src/offline/collection-delete.ts';assert not (r/f).exists()", "f='apps/web/src/offline/collection-delete.ts'")
read=Path.read_bytes
before={str((r/row['path']).resolve()):(out/'before'/row['path']).read_bytes() for row in json.loads((out/'before-manifest.json').read_text())}
def source(p):return before.get(str(p.resolve()),read(p))
Path.read_bytes=source
try:
 env={};exec(compile(script,'archived-apply-candidate','exec'),env);candidate=env['candidates']['apps/web/src/offline/offline-api.ts']
finally:Path.read_bytes=read
p=r/'apps/web/src/offline/offline-api.ts';current=p.read_bytes()
a=b"      if (await store.readMeta('capability.offlineMutations')!=='1' || await store.readMeta(COLLECTION_MANAGEMENT_CAPABILITY_KEY)!=='1' || await store.readMeta('capability.offlineCollectionDelete')!=='1') throw new Error('Collection deletion is not available under offline');"
z=b"      if (isOnlineMode() && (await store.readMeta('capability.offlineMutations')!=='1' || await store.readMeta(COLLECTION_MANAGEMENT_CAPABILITY_KEY)!=='1' || await store.readMeta('capability.offlineCollectionDelete')!=='1')) await facade.getSyncCapabilities({replay:false});\n"+a
assert candidate.count(a)==1;candidate=candidate.replace(a,z,1)
assert current.replace(b'\r\n',b'\n')==candidate.replace(b'\r\n',b'\n'),'STOP non-newline content differs from genuine prior writes'
assert p.read_bytes()==current;p.write_bytes(candidate)
record={'path':str(p),'normalizedToolBytesSHA':hashlib.sha256(current).hexdigest(),'reconstructedSHA':hashlib.sha256(candidate).hexdigest(),'method':'full genuine before bytes + sequential preflighted actual apply + single capability patch; full normalized content equality; restored every other line ending'}
(out/'mixed-newline-repair.json').write_text(json.dumps(record,indent=2));print(record)
# Remove the unused test parameter preserving its original bytes.
p=r/'apps/web/tests/offline-collection-parity.integration.test.ts';b=p.read_bytes();a=b"preserve the outbox', async kind => {";assert b.count(a)==1;candidate=b.replace(a,b"preserve the outbox', async () => {",1);assert p.read_bytes()==b;p.write_bytes(candidate)
print('Recovered mixed newlines; corrected owned lint parameter')
