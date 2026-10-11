from pathlib import Path
import hashlib,json,sys
ROOT=Path('D:/Project/TagTraceTrove'); BASE=ROOT/'.hermes/tmp/offline-parity-first-tranche'; C=BASE/'continuation'; C.mkdir(exist_ok=True)
def sha(b):return hashlib.sha256(b).hexdigest()
reg=json.loads((BASE/'edits.json').read_text()); new=['apps/web/tests/offline-entry-delete.integration.test.ts','apps/web/tests/offline-entry-delete-native.test.ts']
manifest={}
for path in list(reg)+[p for p in new if p not in reg]:
 b=(ROOT/path).read_bytes()
 if path in reg:assert sha(b)==reg[path]['currentSha256'],path
 target=C/'original'/path;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b)
 manifest[path]={'new':path in new,'startSha256':sha(b),'startSize':len(b),'currentSha256':sha(b),'currentSize':len(b)}
(C/'edits.json').write_text(json.dumps(manifest,indent=2))
sys.path.insert(0,str(BASE));import safe_edit
script=(BASE/'tests-ui.py').read_text(); buffers={}
def dry(path,old,new):
 b=buffers.get(path,(ROOT/path).read_bytes());nl=b'\r\n' if b'\r\n' in b else b'\n';enc=lambda s:s.replace('\r\n','\n').encode().replace(b'\n',nl)
 assert b.count(enc(old))==1,(path,b.count(enc(old)));buffers[path]=b.replace(enc(old),enc(new))
safe_edit.edit=dry;exec(compile(script,'tests-ui.py','exec'));print('SHA verified',len(manifest),'UI dry-run PASS')
