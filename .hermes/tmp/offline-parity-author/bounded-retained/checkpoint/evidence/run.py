from pathlib import Path
import hashlib,json,subprocess,sys,datetime,difflib
R=Path('D:/Project/TagTraceTrove'); B=R/'.hermes/tmp/offline-parity-author/bounded-retained'; M=B/'owned.json'
def digest(d):return hashlib.sha256(d).hexdigest()
def guard():
 m=json.loads(M.read_text());assert all(digest((R/p).read_bytes())==h for p,h in m.items()),'OWNED DRIFT';return m
def edit(p,old,new):
 m=guard(); d=(R/p).read_bytes(); nl=b'\r\n' if b'\r\n' in d else b'\n';o=old.replace('\r\n','\n').encode().replace(b'\n',nl);n=new.replace('\r\n','\n').encode().replace(b'\n',nl);assert d.count(o)==1,(p,d.count(o));candidate=d.replace(o,n);assert len(candidate)>=len(d)*.98;guard();(R/p).write_bytes(candidate);m[p]=digest(candidate);M.write_text(json.dumps(m,indent=2));guard()
def provenance():
 paths=['apps/server/src/http/app.ts','apps/web/src/api/gallery.ts','packages/shared/src/sync.ts']
 paths+= [str(p.relative_to(R)).replace('\\','/') for p in (R/'apps/server/src/repositories').glob('*producer*')]
 paths+= [str(p.relative_to(R)).replace('\\','/') for root in ['packages/shared/src','apps/server/src/repositories','apps/server/src/database'] for p in (R/root).rglob('*') if p.is_file() and p.suffix in ['.ts','.sql']]
 paths+= [str(p.relative_to(R)).replace('\\','/') for p in (R/'apps/server/src').glob('*sync*.ts')]
 return {p:digest((R/p).read_bytes()) for p in paths if (R/p).exists()}
def gate(name,args):
 guard(); before=provenance(); t=datetime.datetime.now(datetime.timezone.utc).isoformat();cmd=['C:/Users/hzy/AppData/Local/hermes/node/node.exe']+args
 with (B/(name+'.log')).open('wb') as out: result=subprocess.run(cmd,cwd=R,stdout=out,stderr=subprocess.STDOUT)
 guard(); after=provenance(); v={'time':t,'exit':result.returncode,'command':cmd,'owned':json.loads(M.read_text()),'externalBefore':before,'externalAfter':after};(B/(name+'.gate.json')).write_text(json.dumps(v,indent=2));print(name,result.returncode);print((B/(name+'.log')).read_text(errors='replace')[-5500:]);return result.returncode
if __name__=='__main__':gate(sys.argv[1],sys.argv[2:])
