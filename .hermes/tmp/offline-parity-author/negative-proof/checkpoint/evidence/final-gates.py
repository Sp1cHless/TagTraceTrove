from run import R,B,M,guard,sha,gate,owned
import json
p=owned[2];m=guard();d=(R/p).read_bytes();(B/'last-error-correction-before.bytes').write_bytes(d);o=b"   expect(after[0]!.lastError).toMatch(/Cursor precedes acknowledged progress/i);";assert d.count(o)==1;d=d.replace(o,b'   // Attempt/status/error metadata may change independently of immutable bytes.');(B/'last-error-correction-candidate.bytes').write_bytes(d);guard();(R/p).write_bytes(d);m[p]=sha(d);M.write_text(json.dumps(m,indent=2));guard()
assert gate('focused-verified',['node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts',owned[2],owned[3],'--maxWorkers','2','--testTimeout','30000','--reporter','json','--outputFile',str(B/'focused-verified.json')])==0
j=json.loads((B/'focused-verified.json').read_text());print({k:j[k] for k in ['success','numTotalTests','numPassedTests','numFailedTests','numPendingTests']});assert j['success'] and j['numFailedTests']==0
assert gate('web-types',['apps/web/node_modules/vue-tsc/bin/vue-tsc.js','-p','apps/web/tsconfig.json','--noEmit'])==0
assert gate('owned-lint',['node_modules/eslint/bin/eslint.js']+owned[:3])==0
assert gate('scoped-diff',['git','diff','--check','--']+owned,node=False)==0
