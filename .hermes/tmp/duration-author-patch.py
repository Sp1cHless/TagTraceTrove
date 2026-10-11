from pathlib import Path
import hashlib,json
ROOT=Path('D:/Project/TagTraceTrove')
BASE=ROOT/'.hermes/tmp/duration-author-safe'
manifest=BASE/'working.json'
def digest(b):return hashlib.sha256(b).hexdigest()
def replace(path,old,new,count=1):
 p=ROOT/path;b=p.read_bytes();state=json.loads(manifest.read_text()) if manifest.exists() else {}
 if path not in state:
  backup=BASE/'start'/path;backup.parent.mkdir(parents=True,exist_ok=True);backup.write_bytes(b);state[path]={'start':digest(b),'current':digest(b)}
 assert digest(b)==state[path]['current'],f'EXTERNAL CHANGE: {path}'
 # Explicit targeted byte replacement; never reconstruct source from tool excerpts.
 old=old.replace('\n','\r\n') if b'\r\n' in b and '\r\n' not in old else old
 new=new.replace('\n','\r\n') if b'\r\n' in b and '\r\n' not in new else new
 assert b.count(old.encode())==count,(path,b.count(old.encode()),old)
 result=b.replace(old.encode(),new.encode());assert len(result)>len(b)*.95
 assert p.read_bytes()==b
 p.write_bytes(result);state[path]['current']=digest(result)
 manifest.parent.mkdir(parents=True,exist_ok=True);manifest.write_text(json.dumps(state,indent=2))
if __name__=='__main__':
 import sys
 for change in json.loads(Path(sys.argv[1]).read_text()):replace(**change)
