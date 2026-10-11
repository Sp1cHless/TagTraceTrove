from run import R,B,M,guard,sha,gate,owned
import json
p=owned[2];m=guard();d=(R/p).read_bytes();(B/'ack-assertion-correction-before.bytes').write_bytes(d)
pairs=[(b"expect(remove).not.toHaveBeenCalled();expect(ack).not.toHaveBeenCalled();",b"expect(remove).not.toHaveBeenCalled();\n   // Snapshot bootstrap can ACK its registered cursor, but never clear the\n   // original delete without matching foreground journal authority.\n   for(const [request] of ack.mock.calls)expect(request).toMatchObject({libraryId:original.libraryId,syncEpoch:original.syncEpoch,clientId:'delete-phone'});"),(b'// Applied receipts contain entityId, not library/epoch/UID fields. Change only',b'// Persisted foreground receipts contain entityId, not library/epoch/UID. Change only')]
for o,n in pairs:
 assert d.count(o)==1;nl=b'\r\n' if b'\r\n' in d else b'\n';d=d.replace(o,n.replace(b'\n',nl))
(B/'ack-assertion-correction-candidate.bytes').write_bytes(d);guard();(R/p).write_bytes(d);m[p]=sha(d);M.write_text(json.dumps(m,indent=2));guard()
assert gate('focused-complete',['node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts',owned[2],owned[3],'--maxWorkers','2','--testTimeout','30000','--reporter','json','--outputFile',str(B/'focused-complete.json')])==0
j=json.loads((B/'focused-complete.json').read_text());print({k:j[k] for k in ['success','numTotalTests','numPassedTests','numFailedTests','numPendingTests']});assert j['success'] and j['numFailedTests']==0
assert gate('web-types',['apps/web/node_modules/vue-tsc/bin/vue-tsc.js','-p','apps/web/tsconfig.json','--noEmit'])==0
assert gate('owned-lint',['node_modules/eslint/bin/eslint.js']+owned[:3])==0
assert gate('scoped-diff',['git','diff','--check','--']+owned,node=False)==0
