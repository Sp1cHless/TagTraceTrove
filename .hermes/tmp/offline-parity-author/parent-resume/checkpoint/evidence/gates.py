from pathlib import Path
import hashlib,json,subprocess,os,sys
r=Path('D:/Project/TagTraceTrove')
s=Path(__file__).resolve().parent
node='C:/Users/hzy/AppData/Local/hermes/node/node.exe'
m=json.loads((s.parent/'seed-closure-stop-checkpoint/manifest.json').read_bytes())
paths=set(m['sources'])|{'apps/web/tests/gallery-app.test.ts','apps/web/tests/pending-work-restore.test.ts','apps/web/src/offline/cache-names.ts','apps/web/src/offline/offline-media.ts','apps/web/src/offline/offline-media-task.ts'}
h=lambda p:hashlib.sha256((r/p).read_bytes()).hexdigest()
watch={p:h(p) for p in sorted(paths)}
(s/'watch.json').write_text(json.dumps(watch,indent=2))
def guard():
    bad={p:{'expected':v,'actual':h(p)} for p,v in watch.items() if h(p)!=v}
    if bad:
        (s/'drift.json').write_text(json.dumps(bad,indent=2))
        raise RuntimeError('External source drift: '+repr(bad))
base=[node,str(r/'node_modules/vitest/vitest.mjs'),'run','--maxWorkers=2','--testTimeout=30000','--reporter=json']
commands={
 'focused':base+['--config','vitest.integration.config.ts','apps/web/tests/offline-author-parity.integration.test.ts','--outputFile='+str(s/'focused.json')],
 'default':base+['--exclude','**/*.integration.test.ts','--outputFile='+str(s/'default.json')],
 'integration':base+['--config','vitest.integration.config.ts','--outputFile='+str(s/'integration.json')],
 'lint':[node,str(r/'node_modules/eslint/bin/eslint.js'),'.'],
 'diff':['git','diff','--check'],
 'build':[node,str(r/'apps/web/node_modules/vite/bin/vite.js'),'build','--outDir',str(s/'web-dist')],
}
results={}
for name,cmd in commands.items():
    guard()
    env=os.environ.copy();cwd=r
    if name=='build':env['T3_SW_BUILD']='1';cwd=r/'apps/web'
    with (s/(name+'.log')).open('w',encoding='utf-8') as out:
        rc=subprocess.run(cmd,cwd=cwd,env=env,stdout=out,stderr=subprocess.STDOUT).returncode
    results[name]={'exitCode':rc}
    guard()
    if name in ['focused','default','integration']:
        j=json.loads((s/(name+'.json')).read_bytes())
        results[name].update({k:j.get(k) for k in ['success','numPassedTests','numFailedTests','numPendingTests']})
    (s/'gates.json').write_text(json.dumps(results,indent=2))
    print(name,json.dumps(results[name]),flush=True)
    if rc or results[name].get('success') is False:sys.exit(1)
