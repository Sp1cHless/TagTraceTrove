from pathlib import Path
import hashlib,json,difflib
base=Path('.hermes/tmp/quick-author-safe');m=json.loads((base/'working.json').read_text())
for p,h in m.items(): assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,'OWNED DRIFT '+p
p='apps/web/src/AuthorPage.vue';start=base/'start'/p
assert not start.exists()
start.parent.mkdir(parents=True,exist_ok=True);start.write_bytes((base/'continuation-start'/p).read_bytes())
for file in ['continuation-focused-integration-final.json','continuation-focused-default.json']:
 j=json.loads((base/file).read_text());assert j['success'] and j['numFailedTests']==0
 print(file,'passed',j['numPassedTests'],'files',len(j['testResults']))
report=Path('.hermes/artifacts/quick-author-entrypoints-implementation.md');before=report.read_bytes();q=base/'continuation-start'/report;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(before)
b=before
for old,new in [('- Defect RED / first GREEN / harness corrections: pending execution.','- Defect RED / first GREEN / harness corrections: executed; see cycles and continuation below.'),('- Final focused/static/checkpoint: pending.','- Final continuation focused/static/checkpoint: completed; latest evidence below supersedes historical gate/blocker/partial statements.'),('## Final focused/static and handoff boundary','## Prior writer focused/static and handoff boundary (historical; continuation below supersedes)'),('- Dedicated new coverage not completed:', '- At prior stop, dedicated new coverage not completed (now covered below):')]:
 old=old.encode();assert b.count(old)==1;b=b.replace(old,new.encode())
b+=b'''
## Continuation: all five remaining entrypoint seams completed
- Initial full-byte hashes: all 9 manifest entries matched. Existing offline-library.ts and producer-tag-repository.ts fixes preserved; API reveal-folder imports supplied by external actor preserved. Fixture18742 files unchanged and left under parent ownership.
- New actual AuthorPage -> offline facade -> cold IndexedDB -> injected ApiClient -> app.request -> disposable migrated SQLite coverage: own tag (2 results), own+work tags (1), then rating AND; displayed IDs/order and total equal real SQL response at each stage. No raw query stub; spy calls through production facade.
- Navigation-memory actual defect RED: after list unmount, author-list state was undefined; no list state save on sidebar departure (only drill-down actions saved). Minimal production fix adds rememberAuthorNavigationState() to existing AuthorPage onUnmounted. GREEN then proves two rating rows (slot/operator/3 and 3.5), own/work tags and result/total restore on remount with shared NavigationMemory.
- Multiple real selected rating rows: empty leading row ignores sort; first selected slot orders high-first, selecting/replacing first slot changes order, deleting first row promotes the surviving slot; gt/lt/eq/unrated changes and removing final row reset actual results and total. Each UI transition compared with real SQL, not rawApi stub.
- New online uncertain Quick import cases: 0 and blank optional duration retain original preset body, cold reopen and exact retry settle one SQL entry. Blank remains absent, not injected null in payload. Existing 805 case retained as regression, not claimed newly added.
- New actual Quick import create (duration 0) snapshot-response-loss and durable ACK-response-loss tests: real baseline fetched via server snapshot endpoint (cursor registered), server has committed entry, original UUID/payload retained in cold reopened queue, pending create retained, exact replay-body retry then verified settlement clears queue/pending and SQL count stays 1. Application HTTP/SQLite + fake-IDB evidence, not TCP/Android survival evidence.
- First continuation run: 10/11 UI tests passed; only navigation departure was production RED. Other added seams first-GREEN; no invented defect RED. Initial CRLF anchor assumption rejected before any write; corrected to the original LF bytes. Initial static errors were own spy generic typing, fixed with MockInstance<GalleryApi['queryProducerPage']>; no unrelated production workaround.
- Latest focused integration: 40/40 across 7 files PASS, machine-readable continuation-focused-integration-final.json. Two new integration files now contain 16 tests total (11 UI + 5 parity), including 6 additional continuation cases; previous 10 not relabeled new.
- Latest focused default: 411/411 across 7 files PASS, continuation-focused-default.json (AuthorPage/GalleryApp/Quick import/offline API/snapshot/IDB/delta safety). Existing Vue warnings remain; not pristine stdout.
- Shared/server typecheck PASS; FINAL web typecheck PASS (continuation-web-typecheck-final.log). Affected ESLint and git diff-check PASS (continuation-lint-final.log / continuation-diffcheck-final.log). Historical out-of-scope API/stub blocker no longer present; no test stub needed adapting in this continuation.
- Full-byte owned GREEN/manifest and working.json updated for every owned production/config/test/fixture plus report; continuation-start preserves full pre-continuation bytes, start retains first-writer originals and adds actual AuthorPage pre-fix bytes. own.diff remains start-versus-current GREEN, never HEAD; continuation.diff is pre-continuation-versus-GREEN for the two edited source/test files. Hash verification performed after copying.
- Writer STOPPED after complete checkpoint. Parent owns final full-tree gates/review/APK and fixture shutdown. No version/APK/CURRENT edits, formal database/assets reads, default services, migration files, probe/doctor, deploy/restart, commit/reset/stash. Physical phone touch/keyboard/WebView/PluginCall/Keystore/force-stop remain independently UNVERIFIED; no request to clear storage or re-download.
'''
assert report.read_bytes()==before;report.write_bytes(b);m[report.as_posix()]=hashlib.sha256(b).hexdigest()
manifest={};diff=[];continuation=[]
for p,h in m.items():
 b=Path(p).read_bytes();assert hashlib.sha256(b).hexdigest()==h,'DRIFT '+p
 q=base/'green'/p;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b)
 manifest[p]={'sha256':h,'bytes':len(b),'new':not(base/'start'/p).exists()}
 old=(base/'start'/p).read_bytes() if (base/'start'/p).exists() else b''
 diff.extend(difflib.unified_diff(old.decode('utf-8-sig').splitlines(True),b.decode('utf-8-sig').splitlines(True),fromfile='start/'+p,tofile='green/'+p))
 if p in ['apps/web/src/AuthorPage.vue','apps/web/tests/quick-author-ui.integration.test.ts']:
  old=(base/'continuation-start'/p).read_bytes();continuation.extend(difflib.unified_diff(old.decode().splitlines(True),b.decode().splitlines(True),fromfile='continuation-start/'+p,tofile='green/'+p))
(base/'own.diff').write_text(''.join(diff),encoding='utf-8');(base/'continuation.diff').write_text(''.join(continuation),encoding='utf-8')
(base/'green'/'manifest.json').write_text(json.dumps(manifest,indent=2));(base/'working.json').write_text(json.dumps(m,indent=2))
dependencies=['apps/web/src/AddEntryPage.vue','apps/web/src/GalleryApp.vue','apps/web/src/AuthorPage.vue','apps/web/src/offline/offline-api.ts','apps/web/src/navigation-memory.ts','apps/web/src/api/gallery.ts','apps/web/tests/gallery-app.test.ts','packages/shared/src/schemas/api.ts']
(base/'green'/'observed-dependencies.json').write_text(json.dumps({p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in dependencies},indent=2))
for p,v in manifest.items():
 assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==v['sha256'];assert (base/'green'/p).read_bytes()==Path(p).read_bytes()
print('Full-byte owned checkpoint PASS',len(manifest),'entries; source/test writer STOPPED')
print(json.dumps({p:v for p,v in manifest.items() if p in ['apps/web/src/AuthorPage.vue','apps/web/tests/quick-author-ui.integration.test.ts']},indent=2))
