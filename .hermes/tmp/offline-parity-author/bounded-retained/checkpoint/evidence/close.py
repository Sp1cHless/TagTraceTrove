from run import R,B,guard,digest
from pathlib import Path
import json,difflib,datetime
m=guard();report='.hermes/artifacts/offline-parity-author-retained-bounded.md'; c=B/'checkpoint';assert not c.exists(); c.mkdir()
files={}
for p in [*m,report]:
 d=(R/p).read_bytes();q=c/'bytes'/p;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(d)
 files[p]={'sha256':digest(d),'byteLength':len(d),'saved':str(q.relative_to(c)).replace('\\','/'),'role':'new-report' if p==report else 'owned/watched','startSha256':digest((B/'start'/p).read_bytes()) if p in m else None}
 if p in m:
  a=(B/'start'/p).read_bytes().decode();z=d.decode();(B/(Path(p).name+'.diff')).write_text(''.join(difflib.unified_diff(a.splitlines(True),z.splitlines(True),fromfile='continuation-start/'+p,tofile='checkpoint/'+p)))
evidence={}
for p in list(B.rglob('*')):
 if not p.is_file() or c in p.parents or '__pycache__' in p.parts:continue
 d=p.read_bytes();q=c/'evidence'/p.relative_to(B);q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(d);evidence[str(p.relative_to(B)).replace('\\','/')]={'sha256':digest(d),'byteLength':len(d),'saved':str(q.relative_to(c)).replace('\\','/')}
manifest={'status':'RETAINED_BOUNDED_GREEN_STOP_WRITING_NOT_AUTHOR02_COMPLETE','createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':files,'evidence':evidence,'tests':{'Author':23,'nearestEntryDelete':22,'focused':45,'nearestUnit':178},'excluded':['desktop/System/UI/service','standalone +Author UI','03','APK/native/Gradle','root full gates/build/deployment']}
(c/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2));guard()
for p,v in files.items():assert (R/p).read_bytes()==(c/v['saved']).read_bytes();assert digest((c/v['saved']).read_bytes())==v['sha256']
for v in evidence.values():assert digest((c/v['saved']).read_bytes())==v['sha256']
print('CHECKPOINT',str(c/'manifest.json'));print('MANIFEST_SHA',digest((c/'manifest.json').read_bytes()));print('FILES',json.dumps(files,indent=2));print('EVIDENCE_COUNT',len(evidence));print('VERIFIED_LIVE_SAVED_HASH_EQUAL; SOURCE/TEST/REPORT WRITING STOPPED')
