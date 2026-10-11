from pathlib import Path
import subprocess,json,os
r=Path.cwd();out=r/'.hermes/tmp/offline-parity-author';node='C:/Users/hzy/AppData/Local/hermes/node/node.exe'
commands={
'focused':[node,'node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts','apps/web/tests/offline-author-parity.integration.test.ts','--maxWorkers=2','--testTimeout=30000','--reporter=json','--outputFile='+str(out/'seed-focused.json')],
'default':[node,'node_modules/vitest/vitest.mjs','run','--exclude','**/*.integration.test.ts','--maxWorkers=2','--testTimeout=30000','--reporter=json','--outputFile='+str(out/'seed-default.json')],
'integration':[node,'node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts','--maxWorkers=2','--testTimeout=30000','--reporter=json','--outputFile='+str(out/'seed-integration.json')],
 'types':['C:/Windows/System32/cmd.exe','/c','npm exec --yes --package=pnpm@10.15.0 -- pnpm run typecheck'],
 'lint':[node,'node_modules/eslint/bin/eslint.js','.'],
 'diff':['git','diff','--check'],
 'build':[node,'node_modules/vite/bin/vite.js','build','--outDir','../../.hermes/tmp/offline-parity-author/seed-isolated-web']}
results={}
for name,cmd in commands.items():
 env=os.environ.copy();cwd=r
 if name=='build':cwd=r/'apps/web';env['T3_SW_BUILD']='1'
 with (out/('seed-'+name+'.log')).open('w') as log:results[name]=subprocess.run(cmd,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT).returncode
 print(name,results[name],flush=True)
(out/'seed-gates.json').write_text(json.dumps(results,indent=2))
