from pathlib import Path
import hashlib,json,shutil,xml.etree.ElementTree as E
base=Path('.hermes/tmp/duration-author-safe');manifest=base/'working.json';state=json.loads(manifest.read_text())
newfiles=['apps/web/tests/duration-author-safety.integration.test.ts','apps/web/tests/duration-author-ui.test.ts','spikes/001-android-webview-shell/android/app/src/test/java/com/speechless666/t3/spike/DurationAuthorPlanJvmTest.java']
def digest(b):return hashlib.sha256(b).hexdigest()
for f in newfiles:
 assert f not in state
 state[f]={'start':None,'current':digest(Path(f).read_bytes()),'new':True}
for f,v in state.items():
 b=Path(f).read_bytes();assert digest(b)==v['current'],f'External change: {f}'
 target=base/'green'/f;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b);assert target.read_bytes()==b
manifest.write_text(json.dumps(state,indent=2));(base/'green-manifest.json').write_text(json.dumps(state,indent=2))
for name in ['focused','integration']:
 result=json.loads(Path(f'.hermes/tmp/duration-author-{name}.json').read_text());assert result['success'] and result['numFailedTests']==0
 print(name,result['numPassedTests'])
xmls=list(Path('.hermes/tmp/duration-author-jvm').glob('TEST-*.xml'));assert len(xmls)==3
count=0
for p in xmls:
 root=E.parse(p).getroot();assert root.attrib['failures']=='0' and root.attrib['errors']=='0';count+=int(root.attrib['tests'])
print('JVM',count,'GREEN_FILES',len(state))
print('FULL_BYTE_CHECKPOINT verified')
