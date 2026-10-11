from pathlib import Path
import hashlib,json,difflib,re
r=Path('D:/Project/TagTraceTrove');out=r/'.hermes/tmp/offline-parity-collection/delete-vertical';checkpoint=out/'checkpoint';checkpoint.mkdir(exist_ok=True)
sha=lambda b:hashlib.sha256(b).hexdigest()
baselines=json.loads((out/'before-manifest.json').read_text());existing=[v['path'] for v in baselines];new=['apps/server/src/sync/collection-delete.ts','apps/web/src/offline/collection-delete.ts','apps/web/tests/offline-collection-delete.integration.test.ts'];owned=existing+new
guards={}
for f in ['apps/server/src/http/app.ts','apps/web/src/api/gallery.ts']:
 before=(out/'before'/f).read_bytes();current=(r/f).read_bytes();stripped=current
 if f.endswith('app.ts'):
  prefix=b"import { collectionDeleteIdentity } from '../sync/collection-delete.js';\n";assert stripped.startswith(prefix);stripped=stripped[len(prefix):]
  a=b"  app.get('/api/collections/:collectionId/sync-identity',";start=stripped.index(a);end=stripped.index(b"  app.delete('/api/collections/:collectionId',",start);route=stripped[start:end];stripped=stripped[:start]+stripped[end:]
  strip=[b'\n  syncCollectionIdentitySchema,']
 else:
  a=b'    async getCollectionSyncIdentity(collectionId) {';start=stripped.index(a);end=stripped.index(b'    async getAuthorSyncIdentity(authorId)',start);route=stripped[start:end];stripped=stripped[:start]+stripped[end:]
  strip=[b'\n  syncCollectionIdentitySchema,',b"\n  getCollectionSyncIdentity?(collectionId:number):Promise<import('@t3/shared').SyncCollectionIdentity>;"]
 for a in strip:assert stripped.count(a)==1;stripped=stripped.replace(a,b'',1)
 assert stripped==before,('STOP unrelated shared-file bytes changed',f)
 guards[f]={'beforeFullSHA':sha(before),'currentFullSHA':sha(current),'ownedInsertedRegionSHA':sha(route),'outsideCollectionBytesIdentical':True}
# Record metadata derivation without pretending Gradle/JVM executed.
f='packages/shared/src/schemas/native-mutation-contract.ts';source=(r/f).read_text();match=re.search(r'export const nativeMutationContract\s*=\s*(\{.*\})\s*as const;',source,re.S);assert match
contract=json.loads(match.group(1));assert contract['collection.delete']=={'entityKind':'collection','flags':['offlineMutations','offlineCollectionManagement','offlineCollectionDelete']}
(out/'native-contract-prepared.json').write_text(json.dumps({'inputSHA':sha((r/f).read_bytes()),'kindCount':len(contract),'collectionDelete':contract['collection.delete'],'javaGeneration':'Gradle task derives from this exact shared JSON object; NOT RUN','contract':contract},indent=2))
(out/'owner-region-provenance.json').write_text(json.dumps(guards,indent=2))
deps=['apps/server/src/repositories/collection-repository.ts','apps/web/src/CollectionsPage.vue','packages/shared/src/schemas/api.ts','apps/web/src/offline/outbox-store.ts','apps/web/src/offline/indexeddb-snapshot-store.ts','apps/server/src/database/testing.ts','apps/server/src/database/migrations/028_author_resource_sync.sql','apps/server/src/database/migrations/037_gallery_order_sync.sql','apps/server/src/database/migrations/042_standalone_author_directory_seed.sql','spikes/001-android-webview-shell/android/app/build.gradle']
assert sha((r/deps[0]).read_bytes())=='f7011273420eddb731d101f0a110513174c80b92c07992642c6acde1f7cdfb97','DISTINCT provenance mismatch'
for p in out.glob('*-guard.json'):
 value=json.loads(p.read_text());assert value['unchanged'],('Recorded gate source changed',p)
# Final source corresponds to final21 type/test + final nearest guards.
for name in ['server-types-final21-guard.json','web-types-final21-guard.json','delete-final21-final21-guard.json','nearest-integration-guard.json','nearest-default-guard.json','owned-lint-guard.json','diff-check-guard.json']:
 value=json.loads((out/name).read_text());assert value['exitCode']==0
 for f,h in value['after'].items():assert sha((r/f).read_bytes())==h,('Final source no longer gated',name,f)
rows=[]
def save(p,relative,role,origin=None):
 b=p.read_bytes();saved=checkpoint/relative;saved.parent.mkdir(parents=True,exist_ok=True);saved.write_bytes(b);rows.append({'livePath':str(p),'savedPath':str(saved),'role':role,'origin':origin,'bytes':len(b),'sha256':sha(b)})
for f in owned:save(r/f,Path('working')/f,'new-owned' if f in new else 'owned')
report='.hermes/artifacts/offline-parity-collection-delete.md';save(r/report,Path('working')/report,'report')
for f in deps:save(r/f,Path('observed')/f,'observed-dependency')
for p in sorted(out.rglob('*')):
 if p.is_file() and checkpoint not in p.parents:save(p,Path('evidence')/p.relative_to(out),'original-before' if (out/'before') in p.parents else 'actual-evidence')
diffs=[]
for f in existing:
 before=(out/'before'/f).read_bytes().decode();after=(r/f).read_bytes().decode();diffs.extend(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile='before/'+f,tofile='working/'+f))
(out/'owned-continuation.diff').write_text(''.join(diffs),encoding='utf-8');save(out/'owned-continuation.diff',Path('evidence/owned-continuation.diff'),'actual-evidence')
for row in rows:
 live=Path(row['livePath']).read_bytes();saved=Path(row['savedPath']).read_bytes();assert live==saved and sha(live)==row['sha256']
manifest={'status':'Collection delete finite foreground/SQL GREEN; Collection03 NOT DONE; writers stopped','entries':rows,'ownerRegionGuards':guards,'nativeWorker':'UNVERIFIED','bulkTag':'actual RED'}
p=checkpoint/'manifest.json';p.write_text(json.dumps(manifest,indent=2),encoding='utf-8')
results={}
for n in ['red-corrected','delete-applied1','delete-planner-red','delete-cap-replay-red','delete-final21','nearest-integration','nearest-default','ordinary-parity','common-tag-red']:
 j=json.loads((out/(n+'.json')).read_text());results[n]={k:j[k] for k in ['success','numPassedTests','numFailedTests','numPendingTests']}
summary={'manifestSHA':sha(p.read_bytes()),'entries':len(rows),'liveSavedHashesVerified':True,'results':results,'reportSHA':sha((r/report).read_bytes()),'outsideCollectionSharedBytesIdentical':True,'sourceWriterStopped':True}
(checkpoint/'verification.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
