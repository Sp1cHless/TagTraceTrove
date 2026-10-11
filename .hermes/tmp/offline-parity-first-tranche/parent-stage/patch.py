from pathlib import Path
import hashlib,json
R=Path("D:/Project/TagTraceTrove");D=R/".hermes/tmp/offline-parity-first-tranche/parent-stage";L=D/"ledger.json"
def edit(p,old,new):
 ledger=json.loads(L.read_bytes()) if L.exists() else {};f=R/p;b=f.read_bytes();h=hashlib.sha256(b).hexdigest()
 if p not in ledger:
  q=D/"start"/p;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b);ledger[p]={"startSha256":h,"currentSha256":h,"originalSize":len(b)}
 assert h==ledger[p]["currentSha256"],("DRIFT",p)
 pairs=[(old.encode(),new.encode()),(old.replace("\n","\r\n").encode(),new.replace("\n","\r\n").encode())]
 matches=[(a,z) for a,z in pairs if b.count(a)==1];assert matches,("ANCHOR",p,old[:100]);a,z=matches[0];out=b.replace(a,z,1)
 assert hashlib.sha256(f.read_bytes()).hexdigest()==h;f.write_bytes(out);ledger[p]["currentSha256"]=hashlib.sha256(out).hexdigest();ledger[p]["size"]=len(out);L.write_text(json.dumps(ledger,indent=2));print("PATCH",p)
