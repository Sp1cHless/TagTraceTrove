import json,subprocess,hashlib,shutil,difflib,xml.etree.ElementTree as E
from pathlib import Path
r=Path('.hermes/tmp/offline-parity-first-tranche');c=r/'continuation';reg=json.loads((c/'edits.json').read_text());old=json.loads((r/'edits.json').read_text())
p=subprocess.run(['C:/Users/hzy/AppData/Local/hermes/node/node.exe','node_modules/eslint/bin/eslint.js',*[p for p in reg if p.endswith(('.ts','.vue'))]],capture_output=True,text=True);(c/'lint-current.log').write_text(p.stdout+p.stderr);assert p.returncode==0,p.stdout+p.stderr
p=subprocess.run(['git','diff','--check'],capture_output=True,text=True);(c/'diff-current.log').write_text(p.stdout+p.stderr);assert p.returncode==0,p.stdout+p.stderr
xmls=list(Path('spikes/001-android-webview-shell/android/app/build/test-results/testDebugUnitTest').glob('TEST-*.xml'));jvm={'suites':len(xmls),'tests':0,'failures':0,'errors':0,'skipped':0};proof=c/'jvm-xml';proof.mkdir(exist_ok=True)
for q in xmls:
 t=E.parse(q).getroot();shutil.copyfile(q,proof/q.name)
 for key in ['tests','failures','errors','skipped']:jvm[key]+=int(t.attrib.get(key,0))
assert jvm['failures']==0 and jvm['errors']==0 and jvm['tests']>0,jvm
(c/'jvm-summary.json').write_text(json.dumps(jvm,indent=2));print('JVM',jvm)
for n in ['root-retry','integration-retry','focused-current','native-ts-final']:
 j=json.loads((c/(n+'.json')).read_text());assert j['success'] and j['numFailedTests']==0;print(n,j['numPassedTests'])
path=Path('.hermes/artifacts/offline-parity-first-tranche-implementation.md');checkpoint=c/'checkpoint';checkpoint.mkdir(exist_ok=True);manifest={};diff=[]
for name,meta in reg.items():
 b=Path(name).read_bytes();assert hashlib.sha256(b).hexdigest()==meta['currentSha256'],name
 dest=checkpoint/'current'/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(b)
 orig=None if meta['new'] else ((r/'original'/name) if name in old else (c/'original'/name));o=orig.read_bytes() if orig else b''
 if orig:
  target=checkpoint/'original'/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(o)
 manifest[name]={'new':meta['new'],'originalSha256':hashlib.sha256(o).hexdigest() if orig else None,'originalSize':len(o) if orig else None,'currentSha256':hashlib.sha256(b).hexdigest(),'currentSize':len(b)}
 diff.extend(difflib.unified_diff(o.decode().splitlines(True),b.decode().splitlines(True),fromfile=name,tofile=name))
b=path.read_bytes();dest=checkpoint/'current'/path;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(b);manifest[path.as_posix()]={'report':True,'currentSha256':hashlib.sha256(b).hexdigest(),'currentSize':len(b)}
(checkpoint/'manifest.json').write_text(json.dumps({'status':'WORKING_NOT_FEATURE_COMPLETE','jvm':jvm,'files':manifest},indent=2));(checkpoint/'changes.diff').write_text(''.join(diff),encoding='utf-8')
for name,m in manifest.items():assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==m['currentSha256'] and Path(name).read_bytes()==(checkpoint/'current'/name).read_bytes()
print('FULLBYTES equality PASS',len(manifest),'manifest SHA',hashlib.sha256((checkpoint/'manifest.json').read_bytes()).hexdigest());print('source writing STOP')
