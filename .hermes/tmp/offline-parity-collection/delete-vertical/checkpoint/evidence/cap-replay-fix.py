from pathlib import Path
import hashlib,json
r=Path('D:/Project/TagTraceTrove');out=r/'.hermes/tmp/offline-parity-collection/delete-vertical'
records=[]
for f,a,z,count in [('apps/web/src/offline/sync-mutation-plan.ts',"&& value===null))missing.push(flag)","&& value===null && operation.operationKind!=='collection.delete'))missing.push(flag)",1),('apps/web/tests/offline-collection-delete.integration.test.ts','f.online.replaySyncOperation(','f.online.replaySyncOperation!(',4)]:
 p=r/f;b=p.read_bytes();assert b.count(a.encode())==count;candidate=b.replace(a.encode(),z.encode());assert p.read_bytes()==b;p.write_bytes(candidate);records.append({'path':f,'count':count,'before':hashlib.sha256(b).hexdigest(),'after':hashlib.sha256(candidate).hexdigest()})
(out/'cap-replay-fix.json').write_text(json.dumps(records,indent=2));print('New delete kind no longer inherits implicit legacy absent-global capability permission; optional-method test typing corrected')
