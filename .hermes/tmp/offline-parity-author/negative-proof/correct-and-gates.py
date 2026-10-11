from run import R,B,M,guard,sha,gate,owned
import json,difflib
p=owned[2];m=guard();d=(R/p).read_bytes();(B/'setup-correction-before.bytes').write_bytes(d)
o=b"receipt:{opId:original.opId,status:'applied',entityId:f.author.id,resourceVersion:original.baseVersion+1,serverSeq:expect.any(Number)}";n=b"receipt:{entityId:f.author.id,resourceVersion:original.baseVersion+1,serverSeq:expect.any(Number)}";assert d.count(o)==1;c=d.replace(o,n);(B/'setup-correction-candidate.bytes').write_bytes(c);guard();(R/p).write_bytes(c);m[p]=sha(c);M.write_text(json.dumps(m,indent=2));guard()
assert gate('focused-final',['node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts',owned[2],owned[3],'--maxWorkers','2','--testTimeout','30000','--reporter','json','--outputFile',str(B/'focused-final.json')])==0
j=json.loads((B/'focused-final.json').read_text());print({k:j[k] for k in ['success','numTotalTests','numPassedTests','numFailedTests','numPendingTests']});assert j['success'] and j['numFailedTests']==0
assert gate('web-types',['apps/web/node_modules/vue-tsc/bin/vue-tsc.js','-p','apps/web/tsconfig.json','--noEmit'])==0
assert gate('owned-lint',['node_modules/eslint/bin/eslint.js']+owned[:3])==0
assert gate('scoped-diff',['git','diff','--check','--']+owned,node=False)==0
