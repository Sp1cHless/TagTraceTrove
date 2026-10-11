from run import gate,guard,R,B,digest
import json,re
# Read-only runtime dependency inventory. Desktop/System differences are recorded,
# not claimed as owned or a reason to stop this isolated mobile lane.
paths=[]
for root in ['apps/server/src','packages/shared/src','apps/web/src/offline','apps/web/src/api']:
 paths += [p for p in (R/root).rglob('*') if p.is_file() and p.suffix in ['.ts','.sql']]
def capture():return {str(p.relative_to(R)).replace('\\','/'):digest(p.read_bytes()) for p in paths}
before=capture();(B/'read-dependencies-before.json').write_text(json.dumps(before,indent=2))
app=(R/'apps/server/src/http/app.ts').read_bytes();(B/'app-observed-before.bytes').write_bytes(app)
args=['node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts','apps/web/tests/offline-author-parity.integration.test.ts','apps/web/tests/offline-entry-delete.integration.test.ts','--maxWorkers','2','--testTimeout','30000','--reporter','json','--outputFile',str(B/'focused.json')]
assert gate('focused',args)==0
assert gate('nearest',['node_modules/vitest/vitest.mjs','run','apps/web/tests/offline-api.test.ts','apps/web/tests/pending-work-restore.test.ts','apps/web/tests/pending-work-restore-atomic.test.ts','apps/web/tests/outbox-store.test.ts','apps/web/tests/outbox-cleanup-race.test.ts','--maxWorkers','2','--testTimeout','30000','--reporter','json','--outputFile',str(B/'nearest.json')])==0
assert gate('web-types',['apps/web/node_modules/vue-tsc/bin/vue-tsc.js','-p','apps/web/tsconfig.json','--noEmit'])==0
assert gate('owned-lint',['node_modules/eslint/bin/eslint.js','apps/web/src/offline/offline-api.ts','apps/web/src/offline/pending-work-restore.ts','apps/web/tests/offline-author-parity.integration.test.ts'])==0
after=capture();(B/'read-dependencies-after.json').write_text(json.dumps(after,indent=2));print('READ DEP DRIFT',[(p,before[p],after[p]) for p in before if before[p]!=after[p]])
for n in ['focused','nearest']:
 j=json.loads((B/(n+'.json')).read_text());print(n,{k:j[k] for k in ['success','numTotalTests','numPassedTests','numFailedTests','numPendingTests']});assert j['success'] and j['numFailedTests']==0
