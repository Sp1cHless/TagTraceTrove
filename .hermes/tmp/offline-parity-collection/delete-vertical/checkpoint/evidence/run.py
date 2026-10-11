from pathlib import Path
import subprocess,json,hashlib,sys
from concurrent.futures import ThreadPoolExecutor
r=Path('D:/Project/TagTraceTrove');out=r/'.hermes/tmp/offline-parity-collection/delete-vertical';node='C:/Users/hzy/AppData/Local/hermes/node/node.exe'
files=[row['path'] for row in json.loads((out/'before-manifest.json').read_text())]+['apps/server/src/sync/collection-delete.ts','apps/web/src/offline/collection-delete.ts','apps/web/tests/offline-collection-delete.integration.test.ts']
def capture():return {f:hashlib.sha256((r/f).read_bytes()).hexdigest() for f in files}
tasks=[('server-types',[node,'node_modules/typescript/bin/tsc','-p','apps/server/tsconfig.json','--noEmit']),('web-types',[node,'apps/web/node_modules/vue-tsc/bin/vue-tsc.js','-p','apps/web/tsconfig.json','--noEmit']),('delete-'+sys.argv[1],[node,'node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts','apps/web/tests/offline-collection-delete.integration.test.ts','--maxWorkers=2','--testTimeout=30000','--reporter=json','--outputFile='+str(out/('delete-'+sys.argv[1]+'.json'))])]
def run(task):
 n,c=task;before=capture();a=subprocess.run(c,capture_output=True,text=True,timeout=120);after=capture();(out/(n+'-'+sys.argv[1]+'.log')).write_text(a.stdout+a.stderr);result={'gate':n,'exitCode':a.returncode,'before':before,'after':after,'unchanged':before==after};(out/(n+'-'+sys.argv[1]+'-guard.json')).write_text(json.dumps(result,indent=2));return n,a.returncode,(a.stdout+a.stderr)[-6000:]
for n,code,log in ThreadPoolExecutor(3).map(run,tasks):print(n,code,log)
p=out/('delete-'+sys.argv[1]+'.json')
if p.exists():
 j=json.loads(p.read_text());print({k:j[k] for k in ['success','numPassedTests','numFailedTests']});print([a['failureMessages'] for t in j['testResults'] for a in t['assertionResults'] if a['status']=='failed'])
