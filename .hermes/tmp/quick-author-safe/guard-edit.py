from pathlib import Path
import hashlib,json,sys
base=Path('.hermes/tmp/quick-author-safe');m=json.loads((base/'working.json').read_text())
for change in json.loads(Path(sys.argv[1]).read_text()):
 p=Path(change['path']); b=p.read_bytes(); assert hashlib.sha256(b).hexdigest()==m[p.as_posix()], 'DRIFT '+str(p)
 old=change['old'].encode(); new=change['new'].encode(); assert b.count(old)==1, 'ANCHOR '+str(p)
 b=b.replace(old,new);p.write_bytes(b);m[p.as_posix()]=hashlib.sha256(b).hexdigest();(base/'working.json').write_text(json.dumps(m,indent=2));print(p,len(b),m[p.as_posix()])
