from pathlib import Path
import hashlib,json,subprocess,datetime,difflib,sys
R=Path('D:/Project/TagTraceTrove'); B=R/'.hermes/tmp/offline-parity-author/negative-proof'; M=B/'owned.json'
owned=['apps/web/src/offline/offline-api.ts','apps/web/src/offline/pending-work-restore.ts','apps/web/tests/offline-author-parity.integration.test.ts','apps/web/tests/offline-entry-delete.integration.test.ts']
def sha(d):return hashlib.sha256(d).hexdigest()
def guard():
 m=json.loads(M.read_text()); assert all(sha((R/p).read_bytes())==h for p,h in m.items()),'OWNED DRIFT';return m
def provenance():
 return {str(p.relative_to(R)).replace('\\','/'):sha(p.read_bytes()) for root in ['apps/server/src','packages/shared/src','apps/web/src/offline','apps/web/src/api'] for p in (R/root).rglob('*') if p.is_file() and p.suffix in ['.ts','.sql']}
def gate(name,args,node=True):
 before=guard();dep=provenance();time=datetime.datetime.now(datetime.timezone.utc).isoformat();cmd=(['C:/Users/hzy/AppData/Local/hermes/node/node.exe'] if node else [])+args
 with (B/(name+'.log')).open('wb') as out: result=subprocess.run(cmd,cwd=R,stdout=out,stderr=subprocess.STDOUT)
 after=guard();post=provenance();(B/(name+'.gate.json')).write_text(json.dumps(dict(time=time,command=cmd,exit=result.returncode,ownedBefore=before,ownedAfter=after,externalBefore=dep,externalAfter=post),indent=2));print(name,result.returncode);print((B/(name+'.log')).read_text(errors='replace')[-5500:]);return result.returncode
if __name__=='__main__':
 if sys.argv[1]=='install':
  assert not M.exists(),'already installed';start={p:sha((R/p).read_bytes()) for p in owned};assert start[owned[0]]=='982b69cb25178c4dddf6331007664e277c97ffbcee9bb452b6496b57a9598805';assert start[owned[2]]=='a364dbd34f18c487ae7f3746d3a1288c5975a09d12dcd1a0375bb2d9409260f4'
  for p in owned:
   q=B/'start'/p;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes((R/p).read_bytes())
  M.write_text(json.dumps(start,indent=2));(B/'start.json').write_text(json.dumps(start,indent=2));guard();p=owned[2];d=(R/p).read_bytes();nl=b'\r\n' if b'\r\n' in d else b'\n';anchor=b"it('atomic restore specifically rejects a structurally valid causal Producer update after Author delete without changing queue bytes',async()=>{";assert d.count(anchor)==1
  insert=(B/'cases.txt').read_bytes().replace(b'\r\n',b'\n').replace(b'\n',nl);candidate=d.replace(anchor,insert+nl+anchor);(B/'candidate.bytes').write_bytes(candidate);(B/'candidate.diff').write_text(''.join(difflib.unified_diff(d.decode().splitlines(True),candidate.decode().splitlines(True),fromfile=p,tofile=p)));guard();(R/p).write_bytes(candidate);start[p]=sha(candidate);M.write_text(json.dumps(start,indent=2));guard();print(json.dumps(start,indent=2))
 elif sys.argv[1]=='focused':
  assert gate('first-green',['node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts',owned[2],owned[3],'--maxWorkers','2','--testTimeout','30000','--reporter','json','--outputFile',str(B/'first-green.json')])==0
  j=json.loads((B/'first-green.json').read_text());print({k:j[k] for k in ['success','numTotalTests','numPassedTests','numFailedTests','numPendingTests']});assert j['success'] and j['numFailedTests']==0
 elif sys.argv[1]=='gates':
  assert gate('web-types',['apps/web/node_modules/vue-tsc/bin/vue-tsc.js','-p','apps/web/tsconfig.json','--noEmit'])==0
  assert gate('owned-lint',['node_modules/eslint/bin/eslint.js']+owned[:3])==0
  assert gate('scoped-diff',['git','diff','--check','--']+owned,node=False)==0
