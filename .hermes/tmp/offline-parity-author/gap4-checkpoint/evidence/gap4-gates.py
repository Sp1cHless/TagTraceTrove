from pathlib import Path
import subprocess,json,os,concurrent.futures
R=Path('D:/Project/TagTraceTrove');S=R/'.hermes/tmp/offline-parity-author';N='C:/Users/hzy/AppData/Local/hermes/node/node.exe'
from guard import edit
p='apps/web/tests/offline-author-parity.integration.test.ts'
edit(p,"await settle();expect((await cold.getViewLaterState()).producerIds).toContain(authorId);", "await settle();expect(wrapper.get('[data-testid=\"author-view-later-button\"]').attributes('aria-pressed')).toBe('true');expect((await cold.getViewLaterState()).producerIds).toContain(authorId);expect((await cold.queryProducerPage(producerPageQueryRequestSchema.parse({}))).items.map(row=>row.id)).not.toContain(authorId);")
commands={
 'focused':[N,'node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts','apps/web/tests/offline-author-parity.integration.test.ts','--maxWorkers','2','--testTimeout','30000','--reporter=json','--outputFile='+str(S/'gap4-focused.json')],
 'default':[N,'node_modules/vitest/vitest.mjs','run','--exclude','**/*.integration.test.ts','--maxWorkers','2','--testTimeout','30000','--reporter=json','--outputFile='+str(S/'gap4-default.json')],
 'integration':[N,'node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts','--maxWorkers','2','--testTimeout','30000','--reporter=json','--outputFile='+str(S/'gap4-integration.json')],
 'types':['npm.cmd','exec','--yes','--package=pnpm@10.15.0','--','pnpm','run','typecheck'],
 'lint':['npm.cmd','exec','--yes','--package=pnpm@10.15.0','--','pnpm','run','lint'],
 'diff':['git','diff','--check'],
 'build':[N,'node_modules/vite/bin/vite.js','build','--outDir',str(S/'gap4-client-build')],
}
def run(pair):
 name,cmd=pair;env=os.environ.copy();env['T3_SW_BUILD']='1'
 with (S/('gap4-'+name+'.log')).open('wb') as out:p=subprocess.run(cmd,cwd=R/'apps/web' if name=='build' else R,env=env,stdout=out,stderr=subprocess.STDOUT)
 return name,p.returncode
# Sequential suites avoid multiplied worker load; other independent gates run concurrently.
results={}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
 for name,code in pool.map(run,[(n,c) for n,c in commands.items() if n not in ['focused','default','integration']]):results[name]=code
for name in ['focused','default','integration']:n,code=run((name,commands[name]));results[n]=code
summary={'exitCodes':results}
for name in ['focused','default','integration']:
 p=S/('gap4-'+name+'.json')
 if p.exists():
  v=json.loads(p.read_bytes());summary[name]={k:v.get(k) for k in ['success','numPassedTests','numFailedTests','numPendingTests']}
(S/'gap4-gates.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
for name,code in results.items():
 if code:print('\nFAILED',name,(S/('gap4-'+name+'.log')).read_text(errors='replace')[-10000:])
raise SystemExit(int(any(results.values())))
