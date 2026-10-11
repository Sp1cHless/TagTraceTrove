from pathlib import Path
import subprocess,json,os,hashlib
r=Path.cwd();out=r/'.hermes/tmp/offline-parity-author';node='C:/Users/hzy/AppData/Local/hermes/node/node.exe'
watch=json.loads((out/'seed-closure-watch.json').read_text())
def guard():
 bad=[n for n,h in watch.items() if not (r/n).exists() or hashlib.sha256((r/n).read_bytes()).hexdigest()!=h]
 if bad:raise RuntimeError('EXTERNAL DRIFT STOP '+repr(bad))
commands={
'focused':[node,'node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts','apps/web/tests/offline-author-parity.integration.test.ts','--maxWorkers=2','--testTimeout=30000','--reporter=json','--outputFile='+str(out/'seed-closure-focused.json')],
'default':[node,'node_modules/vitest/vitest.mjs','run','--exclude','**/*.integration.test.ts','--maxWorkers=2','--testTimeout=30000','--reporter=json','--outputFile='+str(out/'seed-closure-default.json')],
'integration':[node,'node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts','--maxWorkers=2','--testTimeout=30000','--reporter=json','--outputFile='+str(out/'seed-closure-integration.json')],
'lint':[node,'node_modules/eslint/bin/eslint.js','.'],
'diff':['git','diff','--check'],
'web':[node,'node_modules/vite/bin/vite.js','build','--outDir','../../.hermes/tmp/offline-parity-author/seed-closure-isolated-web']}
results={}
for name,cmd in commands.items():
 guard();env=os.environ.copy();cwd=r
 if name=='web':cwd=r/'apps/web';env['T3_SW_BUILD']='1'
 with (out/('seed-closure-'+name+'.log')).open('w') as log:rc=subprocess.run(cmd,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT).returncode
 result={'command':cmd,'cwd':str(cwd),'exit':rc}
 if name in ['focused','default','integration']:
  j=json.loads((out/('seed-closure-'+name+'.json')).read_text());result.update({k:j[k] for k in ['success','numPassedTests','numFailedTests','numPendingTests','numTotalTests']})
 guard();results[name]=result;(out/'seed-closure-gates.json').write_text(json.dumps(results,indent=2));print(name,result,flush=True)
 if rc:raise RuntimeError('GATE FAILED '+name)
