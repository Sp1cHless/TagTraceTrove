from run import R,B,M,guard,sha,gate,owned
import json
p=owned[2];m=guard();d=(R/p).read_bytes();(B/'spy-types-correction-before.bytes').write_bytes(d);nl=b'\r\n' if b'\r\n' in d else b'\n'
pairs=[("  const remove=vi.spyOn(f.store,'removeMany');const ack=vi.spyOn(f.online,'ackSnapshotDelta');", "  const proofApi=f.online as typeof f.online & {fetchSyncChanges:NonNullable<typeof f.online.fetchSyncChanges>;ackSnapshotDelta:NonNullable<typeof f.online.ackSnapshotDelta>};\n  const remove=vi.spyOn(f.store,'removeMany');const ack=vi.spyOn(proofApi,'ackSnapshotDelta');"),("const journal=vi.spyOn(f.online,'fetchSyncChanges').mockImplementation", "const journal=vi.spyOn(proofApi,'fetchSyncChanges').mockImplementation")]
for a,b in pairs:
 o=a.encode().replace(b'\n',nl);n=b.encode().replace(b'\n',nl);assert d.count(o)==1;d=d.replace(o,n)
(B/'spy-types-correction-candidate.bytes').write_bytes(d);guard();(R/p).write_bytes(d);m[p]=sha(d);M.write_text(json.dumps(m,indent=2));guard()
assert gate('focused-final-verified',['node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts',owned[2],owned[3],'--maxWorkers','2','--testTimeout','30000','--reporter','json','--outputFile',str(B/'focused-final-verified.json')])==0
j=json.loads((B/'focused-final-verified.json').read_text());print({k:j[k] for k in ['success','numTotalTests','numPassedTests','numFailedTests','numPendingTests']});assert j['success'] and j['numFailedTests']==0
types=gate('web-types-final',['apps/web/node_modules/vue-tsc/bin/vue-tsc.js','-p','apps/web/tsconfig.json','--noEmit'])
if types:assert (B/'web-types-final.log').read_text().strip()=="apps/web/src/offline/connection-recovery.ts(55,5): error TS2322: Type 'Timeout' is not assignable to type 'number'."
assert gate('owned-lint',['node_modules/eslint/bin/eslint.js']+owned[:3])==0
assert gate('scoped-diff',['git','diff','--check','--']+owned,node=False)==0
