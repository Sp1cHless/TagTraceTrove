from pathlib import Path
import hashlib,json,difflib
ROOT=Path('D:/Project/TagTraceTrove');BASE=ROOT/'.hermes/tmp/offline-parity-first-tranche/continuation';REG=BASE/'edits.json'
def sha(b):return hashlib.sha256(b).hexdigest()
def edit(path,old,new,count=1):
 p=ROOT/path;b=p.read_bytes();reg=json.loads(REG.read_text());
 if path not in reg:
  q=BASE/'original'/path;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b);reg[path]={'new':False,'startSha256':sha(b),'startSize':len(b),'currentSha256':sha(b)}
 # UI script execution is the only inherited-ledger update since continuation backup.
 if path=='apps/web/tests/offline-entry-delete.integration.test.ts' and sha(b)!=reg[path]['currentSha256']:
  inherited=json.loads((BASE.parent/'edits.json').read_text());assert sha(b)==inherited[path]['currentSha256'];reg[path]['currentSha256']=sha(b)
 assert sha(b)==reg[path]['currentSha256'],path
 nl=b'\r\n' if b'\r\n' in b else b'\n';enc=lambda s:s.replace('\r\n','\n').encode().replace(b'\n',nl)
 assert b.count(enc(old))==count,(path,b.count(enc(old)),old[:100]);out=b.replace(enc(old),enc(new));p.write_bytes(out);reg[path].update(currentSha256=sha(out),currentSize=len(out));REG.write_text(json.dumps(reg,indent=2));print(path,sha(out))
 with (BASE/'patches.diff').open('a',encoding='utf-8') as f:f.write(''.join(difflib.unified_diff(b.decode().splitlines(True),out.decode().splitlines(True),fromfile=path,tofile=path)))
