from pathlib import Path
import hashlib,json,subprocess,os,sys
r=Path('D:/Project/TagTraceTrove'); out=r/'.hermes/tmp/offline-parity-author/seed-resume'; out.mkdir(exist_ok=True)
sha=lambda b:hashlib.sha256(b).hexdigest()
old=json.loads((r/'.hermes/tmp/offline-parity-author/seed-closure-stop-checkpoint/manifest.json').read_bytes())
watchfile=out/'watch.json'
def guard():
 w=json.loads(watchfile.read_bytes()); bad={n:{'expected':h,'actual':sha((r/n).read_bytes()) if (r/n).exists() else None} for n,h in w.items() if not (r/n).exists() or sha((r/n).read_bytes())!=h}
 if bad:
  (out/'drift.json').write_text(json.dumps(bad,indent=2)); raise RuntimeError('EXTERNAL DRIFT STOP '+repr(bad))
node='C:/Users/hzy/AppData/Local/hermes/node/node.exe'
vit=[node,'node_modules/vitest/vitest.mjs','run']
commands={
 'types':['C:/Program Files/Git/bin/bash.exe','-lc','npm exec --yes --package=pnpm@10.15.0 -- pnpm run typecheck'],
 'nearest':vit+['--config','vitest.integration.config.ts','apps/server/tests/integration/sync.integration.test.ts','--testNamePattern=rolls back','--maxWorkers=2','--testTimeout=30000'],
 'focused':vit+['--config','vitest.integration.config.ts','apps/web/tests/offline-author-parity.integration.test.ts','--maxWorkers=2','--testTimeout=30000'],
 'default':vit+['--exclude','**/*.integration.test.ts','--maxWorkers=2','--testTimeout=30000'],
 'integration':vit+['--config','vitest.integration.config.ts','--maxWorkers=2','--testTimeout=30000'],
 'lint':[node,'node_modules/eslint/bin/eslint.js','.'],
 'diff':['git','diff','--check'],
 'web':[node,'node_modules/vite/bin/vite.js','build','--outDir','../../.hermes/tmp/offline-parity-author/seed-resume/client-web']}
mode=sys.argv[1]
if mode=='start':
 for n,v in old['sources'].items(): assert sha((r/n).read_bytes())==v['actual'],n
 paths=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard'],cwd=r,text=True).splitlines()
 paths=[n for n in paths if n.startswith(('apps/web/src/','apps/web/tests/','apps/server/src/','apps/server/tests/','packages/shared/','spikes/001-android-webview-shell/android/app/src/')) and not any(x in n for x in ['/build/','/dist/','/node_modules/']) and (r/n).is_file()]
 paths=sorted(set(paths+list(old['sources'])+['package.json','vitest.config.ts','vitest.integration.config.ts','apps/web/vite.config.ts']))
 w={}
 for n in paths:
  b=(r/n).read_bytes(); p=out/'start'/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);w[n]=sha(b)
 watchfile.write_text(json.dumps(w,indent=2));print('START verified STOP27; saved complete bytes',len(w))
elif mode=='fix':
 guard(); candidates={}; n='apps/server/src/database/probe.ts'; b=(r/n).read_bytes(); a=b'buildSyncCapabilities(database).featureFlags.offlineStandaloneAuthorDirectorySeed';assert b.count(a)==1;candidates[n]=b.replace(a,b"buildSyncCapabilities(database, 'probe').featureFlags.offlineStandaloneAuthorDirectorySeed")
 n='apps/server/tests/integration/sync.integration.test.ts';b=(r/n).read_bytes()
 for trigger in ['test_block_sync_receipt','test_block_usage_receipt','test_block_create_receipt']:
  pos=b.index(('CREATE TRIGGER '+trigger).encode());start=b.rfind(b'    database.exec(`',0,pos);assert start>=0
  newline=b'\r\n' if b[start-2:start]==b'\r\n' else b'\n'
  ins=newline.join([b"    const beforeJournal = database.prepare('SELECT * FROM sync_changes ORDER BY seq').all();",b"    const beforeSequence = database.prepare(\"SELECT seq FROM sqlite_sequence WHERE name='sync_changes'\").get();",b''])
  b=b[:start]+ins+b[start:]
 assert b.count(b'const beforeJournal =')==3 and b.count(b'const beforeSequence =')==3;candidates[n]=b
 for n,b in candidates.items():
  p=out/'candidate'/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b)
  print('DRYRUN',n,len((r/n).read_bytes()),len(b),sha(b))
 guard();w=json.loads(watchfile.read_bytes()); ledger={}
 for n,b in candidates.items():
  assert sha((r/n).read_bytes())==w[n];ledger[n]={'before':w[n],'after':sha(b)};(r/n).write_bytes(b);w[n]=sha(b)
 watchfile.write_text(json.dumps(w,indent=2));(out/'edit-ledger.json').write_text(json.dumps(ledger,indent=2));guard();print('APPLIED exact byte targeted batch')
else:
 name=mode.removeprefix('red-');cmd=commands[name][:];guard();cwd=r;env=os.environ.copy()
 if name in ['nearest','focused','default','integration']:cmd+=['--reporter=json','--outputFile='+str(out/(mode+'.json'))]
 if name=='web':cwd=r/'apps/web';env['T3_SW_BUILD']='1'
 with (out/(mode+'.log')).open('w') as f:rc=subprocess.run(cmd,cwd=cwd,env=env,stdout=f,stderr=subprocess.STDOUT).returncode
 result={'exit':rc,'command':cmd,'cwd':str(cwd)}
 if (out/(mode+'.json')).exists():
  j=json.loads((out/(mode+'.json')).read_bytes());result.update({k:j[k] for k in ['success','numPassedTests','numFailedTests','numPendingTests','numTotalTests']})
 (out/(mode+'-result.json')).write_text(json.dumps(result,indent=2));guard();print(mode,json.dumps(result),flush=True)
 sys.exit(0 if mode.startswith('red-') else rc)
