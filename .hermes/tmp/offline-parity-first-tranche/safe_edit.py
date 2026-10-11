from pathlib import Path
import hashlib,json,difflib
ROOT=Path('D:/Project/TagTraceTrove'); BASE=ROOT/'.hermes/tmp/offline-parity-first-tranche'; REG=BASE/'edits.json'
def sha(b):return hashlib.sha256(b).hexdigest()
def edit(path,old,new):
 p=ROOT/path;b=p.read_bytes();reg=json.loads(REG.read_text()) if REG.exists() else {}
 if path not in reg:
  backup=BASE/'original'/path;backup.parent.mkdir(parents=True,exist_ok=True);backup.write_bytes(b)
  reg[path]={'originalSha256':sha(b),'originalSize':len(b),'currentSha256':sha(b)}
 assert sha(b)==reg[path]['currentSha256'],f'SHA drift {path}'
 nl=b'\r\n' if b'\r\n' in b else b'\n'
 def encode(s):return s.replace('\r\n','\n').encode().replace(b'\n',nl)
 o,n=encode(old),encode(new);assert b.count(o)==1,(path,b.count(o),old[:100])
 out=b.replace(o,n);p.write_bytes(out);reg[path]['currentSha256']=sha(out);reg[path]['currentSize']=len(out)
 REG.write_text(json.dumps(reg,indent=2)); print(path,len(b),'->',len(out),sha(out))
 diff=''.join(difflib.unified_diff(b.decode().splitlines(True),out.decode().splitlines(True),fromfile=path,tofile=path))
 with (BASE/'patches.diff').open('a',encoding='utf-8') as f:f.write(diff)
