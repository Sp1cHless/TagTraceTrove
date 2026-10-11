import subprocess,os,json,xml.etree.ElementTree as E
from pathlib import Path
r=Path('D:/Project/TagTraceTrove');t=r/'.hermes/tmp/offline-parity-gallery/native-repair'
def gate(token,tests):
 env=os.environ.copy();env.update(JAVA_HOME='C:/Program Files/Eclipse Adoptium/jdk-21.0.7.6-hotspot',ANDROID_HOME=str(r/'spikes/001-android-webview-shell/.android-sdk'),ANDROID_SDK_ROOT=str(r/'spikes/001-android-webview-shell/.android-sdk'),T3_TEST_REPO=str(r),T3_NATIVE_TEST_OUTPUT=str(t/'gradle-output'/token),PATH='D:/install/Git/usr/bin;'+env['PATH'])
 argv=['cmd.exe','/c','gradlew.bat','--no-daemon','--init-script',str(t/'isolated.gradle'),':app:testDebugUnitTest']
 for test in tests:argv+=['--tests','com.speechless666.t3.spike.'+test]
 p=subprocess.run(argv,cwd=r/'spikes/001-android-webview-shell/android',env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
 (t/(token+'.log')).write_bytes(p.stdout);print('EXIT',p.returncode,p.stdout.decode(errors='replace')[-1800:])
 out=t/'actual-gates'/token;out.mkdir(parents=True,exist_ok=True);counts=[]
 for f in (t/'gradle-output'/token).rglob('TEST-*.xml'):
  (out/f.name).write_bytes(f.read_bytes());root=E.parse(f).getroot();counts.append(root.attrib);print(root.attrib,root.findtext('system-out'),[(c.attrib,c.find('failure').attrib if c.find('failure') is not None else {}) for c in root.findall('testcase')])
 (out/'gate.json').write_text(json.dumps({'gradleExit':p.returncode,'argv':argv,'xml':counts},indent=2))
 return p.returncode
