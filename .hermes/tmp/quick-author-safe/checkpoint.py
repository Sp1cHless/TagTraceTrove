from pathlib import Path
import hashlib,json,difflib
base=Path('.hermes/tmp/quick-author-safe')
m=json.loads((base/'working.json').read_text())
for p,h in m.items():
 assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,'EXTERNAL OWNED DRIFT '+p
owned=list(m)+['apps/web/tests/quick-author-entrypoints.integration.test.ts','apps/web/tests/quick-author-ui.integration.test.ts']
owned += [p.as_posix() for p in Path('.hermes/tmp/quick-author-entrypoints').rglob('*') if p.is_file()]
manifest={};diff=[]
for p in owned:
 b=Path(p).read_bytes();q=base/'green'/p;q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(b)
 manifest[p]={'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'new':not(base/'start'/p).exists()}
 old=(base/'start'/p).read_bytes() if (base/'start'/p).exists() else b''
 diff.extend(difflib.unified_diff(old.decode('utf-8-sig').splitlines(True),b.decode('utf-8-sig').splitlines(True),fromfile='start/'+p,tofile='green/'+p))
(base/'own.diff').write_text(''.join(diff),encoding='utf-8')
(base/'green'/'manifest.json').write_text(json.dumps(manifest,indent=2))
(base/'working.json').write_text(json.dumps({p:v['sha256'] for p,v in manifest.items()},indent=2))
dependencies=['apps/web/src/AddEntryPage.vue','apps/web/src/GalleryApp.vue','apps/web/src/AuthorPage.vue','apps/web/src/offline/offline-api.ts','apps/web/src/api/gallery.ts','packages/shared/src/schemas/api.ts']
(base/'green'/'observed-dependencies.json').write_text(json.dumps({p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in dependencies},indent=2))
p=Path('.hermes/artifacts/quick-author-entrypoints-implementation.md')
p.write_text(p.read_text()+"""
## Final focused/static and handoff boundary
- Latest focused integration: 33/33, 7 files PASS (10 new tests, 23 existing). Log quick-author-safe/focused-integration-final.log.
- Focused default: 284/284, 4 files PASS; existing Vue warnings remain (not pristine stdout).
- Affected ESLint PASS; git diff-check PASS (existing CRLF advisories).
- Shared/server typecheck PASS. Web typecheck passed once after own harness correction, but FINAL web typecheck BLOCKED by concurrent out-of-scope edits: api/gallery.ts lines865/867 missing siteprobeRevealFolder schemas; gallery-app.test.ts memory API missing revealSiteprobeFolder. Earlier AdvancedImportPanel dynamic translation-key error disappeared without our editing it. Do not label current full tree GREEN.
- Production: offline-library.ts fixes options anchor eligibility/unscored self slots, query anchor-type/whole-author NSFW eligibility, wrong-class/unknown validation and anchor-protected filter/sort scalar. producer-tag-repository.ts adds same anchor partition SQL guard after isolated SQL defect RED. No migrations/native/API payload changes. Quick duration production needed no fix: real shell/form/cold-IDB/replay proved existing behavior.
- New UI tests: invalid no queue, parsed805/0/blank omission, cold pending visibility, committed response loss exact retry, SQL duration and queue/pending cleanup; online uncertain create/preset805 also cold-retried. Actual AuthorPage/facade covers unscored option/default gt/unrated/removal and pending dimension add/clear/delete/anchor options.
- SQL parity: gt/lt/eq/unrated, half-step/null, five sorting modes incl seeded random, page2 total, AND conditions, invalid class/unknown slot, same-name cross Gallery, NSFW. Rating0 intentionally invalid (.5-5); Entry duration0 supported.
- Dedicated new coverage not completed: Author own/work tags; navigation-memory restoration; multiple selected UI rows/first-row replacement; online uncertain0/blank presets; durable ACK-loss injection. Existing regressions are not relabeled new vertical proof. Physical Android touch/keyboard/WebView/PluginCall/Keystore/force-stop UNVERIFIED.
- Full bytes owned checkpoint/manifest: .hermes/tmp/quick-author-safe/green; working.json includes all owned production/config/new tests/fixtures. start contains complete pre-edit dirty bytes; own.diff is start-versus-green, never HEAD. observed-dependencies.json records current caller hashes (concurrent drift requires parent full gates).
- Checkpoint shell -c attempt hit quoting SyntaxError before any writes; corrected by executing checkpoint.py, not assumed successful.
- No formal DB/assets read/touch, default services/deploy/restart, migrations, commit/reset/stash, CURRENT/version/APK modifications. Disposable SQL and temp roots closed/removed in finally. Fixture18742 remains for parent review; kill proc_c609da1a1ed0 when done.
- Writer STOPPED after checkpoint/report. Parent owns final review/fullgates/APK; resolve concurrent typecheck drift before packaging.
""",encoding='utf-8')
q=base/'green'/'.hermes/artifacts/quick-author-entrypoints-implementation.md';q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(p.read_bytes())
print(json.dumps(manifest,indent=2))
print('Owned hash checks PASS; checkpoint saved; source/test writer STOPPED')
