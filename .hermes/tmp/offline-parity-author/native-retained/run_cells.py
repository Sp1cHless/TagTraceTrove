import os, subprocess, json, shutil, hashlib, datetime
from pathlib import Path
from xml.etree import ElementTree as E
repo=Path('D:/Project/TagTraceTrove')
root=repo/'.hermes/tmp/offline-parity-author/native-retained'
android=repo/'spikes/001-android-webview-shell/android'
env=os.environ.copy()
env.update(JAVA_HOME='C:/Program Files/Eclipse Adoptium/jdk-21.0.7.6-hotspot',ANDROID_HOME=str(repo/'spikes/001-android-webview-shell/.android-sdk'),ANDROID_SDK_ROOT=str(repo/'spikes/001-android-webview-shell/.android-sdk'),T3_TEST_REPO=str(repo))
env['PATH']='C:/Users/hzy/AppData/Local/hermes/node;'+env['JAVA_HOME']+'/bin;'+env['PATH']
methods=['heldTrustedDirectoryPredecessorBlocksDeleteIndependentEntryProgressesColdResumeRetriesExactBody','heldCollectionProducerMembershipBlocksDeleteIndependentEntryProgressesColdResumeRetriesExactBody','existingProducerProfileThenDeleteRetainsCompletedOriginalsAcrossColdReopen']
results=[]
for idx,method in enumerate(methods):
 token=f'cell-{idx}-isolated-v2'
 env['T3_NATIVE_OUTPUT_TOKEN']=token
 command=['cmd.exe','/c','gradlew.bat','--offline','--no-daemon','--console=plain','--project-cache-dir',str(root/'gradle-cache'),'-I',str(root/'author02-retained-isolated.init.gradle'),':app:testDebugUnitTest','--tests','com.speechless666.t3.spike.NativeAuthorDeleteTimelineJvmTest.'+method]
 output=root/(token+'.stdout')
 start=datetime.datetime.now(datetime.timezone.utc).isoformat()
 with output.open('wb') as f:r=subprocess.run(command,cwd=android,env=env,stdout=f,stderr=subprocess.STDOUT)
 archive=root/(token+'-archive');archive.mkdir(exist_ok=False)
 shutil.copyfile(output,archive/output.name)
 summaries=[]
 for p in (root/'gradle-output'/token).rglob('TEST-*.xml'):
  q=archive/p.relative_to(root/'gradle-output'/token);q.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,q)
  xml=E.parse(p).getroot();summaries.append({'suite':dict(xml.attrib),'cases':[dict(c.attrib) for c in xml.findall('testcase')],'failures':[x.text for x in xml.findall('.//failure')]})
 for p in (root/'gradle-output'/token).rglob('NativeMutationContract.java'):
  q=archive/'generated'/p.name;q.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,q)
 record={'start':start,'command':command,'exit':r.returncode,'summaries':summaries}
 (archive/'gate.json').write_text(json.dumps(record,indent=2))
 results.append(record);print(json.dumps(record,indent=2),flush=True)
 if r.returncode:print(output.read_text(errors='replace')[-10000:],flush=True);break
(root/'isolated-cells-summary.json').write_text(json.dumps(results,indent=2))
