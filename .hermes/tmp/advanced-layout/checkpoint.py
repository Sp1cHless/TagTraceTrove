from pathlib import Path
import hashlib,json,difflib,subprocess
root=Path('D:/Project/TagTraceTrove'); d=root/'.hermes/tmp/advanced-layout'; manifest=json.loads((d/'patch-manifest.json').read_text())
scoped=''
for r in manifest:
 p=root/r['path']; assert hashlib.sha256(p.read_bytes()).hexdigest()==r['after']; scoped+=''.join(difflib.unified_diff((d/'before'/r['path']).read_text().splitlines(True),p.read_text().splitlines(True),fromfile='before/'+r['path'],tofile=r['path']))
(d/'scoped.diff').write_text(scoped)
rows=[]
for base in ['apps/web/src','apps/web/tests','apps/server/src','apps/server/tests','packages/shared/src','packages/shared/tests']:
 for p in (root/base).rglob('*'):
  if not p.is_file():continue
  b=p.read_bytes(); name=p.relative_to(root).as_posix(); dest=d/'checkpoint'/name; dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(b);rows.append({'path':name,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
for name in ['package.json','pnpm-lock.yaml','vitest.config.ts','vitest.integration.config.ts','eslint.config.js']:
 p=root/name
 if p.is_file():
  b=p.read_bytes(); dest=d/'checkpoint'/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(b);rows.append({'path':name,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
for r in rows:assert hashlib.sha256((root/r['path']).read_bytes()).hexdigest()==r['sha256']
(d/'checkpoint/manifest.json').write_text(json.dumps({'state':'working source/test bytes, no HEAD restoration','files':rows},indent=2))
reds=json.loads((d/'red.json').read_text());first=json.loads((d/'first-green.json').read_text());current=json.loads((d/'current-green.json').read_text());assert all(not r['failures'] and not r['errors'] and r['card']['right']<=r['width']+1 and r['card']['left']>=0 for r in current)
report='''# Advanced functions mobile layout implementation

## Outcome / stop boundary
Only three production CSS sections changed, preserving script/template/function behavior and original line endings. Source/test writer is STOPPED after this checkpoint. Parent owns final whole-tree gates/version/v44 APK. No CURRENT/version/APK, official DB/assets/default 8765/8766 service, immutable migrations, git commit/reset/stash/HEAD operations performed.

## Actual-shell browser RED → GREEN
Isolated Vite imports production GalleryApp, theme, production offline facade + unique seeded IndexedDB snapshot and throw-only fetchImplementation. Browser traverses Settings → Advanced functions → Tags / Source maintenance / Offline library. Seeded API responses and native/restore preview overrides are deliberate layout simulation, NOT sync/native proof. No external API or media fetch allowed.

Initial repeatable defect RED: `red.json`, `red-*.png` (24 cases). English360 had Tags27 / Sources17 / Offline27 card-inner-bound violations; source host URL right5367.8 vs inner319.6; offline button right1325.9 vs319.6. Inputs/file controls and text Range rectangles measured, not document.scrollWidth or overflow masking. Original complete-byte backups in `before/` and SHA/unique-anchor guarded patch.py preserve prior dirty work. Scoped diff is relative to those backups, NOT the much larger historical git diff.

First GREEN: `first-green.json`, 24/24 cases at360/390/430/768 en/zh, no text/control violations or pageerrors. Screenshots captured; offline RED/GREEN inspected visually.
Current GREEN: `current-green.json`,30/30 cases at360/390/430/768/1440 en/zh, no text/control violations or pageerrors; all cards also inside viewport. Adds populated long-tag autocomplete selected chips, both dictionary groups expanded, Fill inputs, source URL/candidate/review/manual input and job controls, selected-original textarea, long simulated native reason, restore-file preview + confirm action. Changes phone rules to container queries so768's narrower sidebar shell gets the same safe card layout, while1440 retains multi-column desktop form.

Root causes repaired: explicit minmax(0,1fr) nested grid tracks, grid/flex min-width0 and control max-width/box-sizing, card-local overflow-wrap:anywhere, source inline row wrapping, stacked library labels, desktop form breakpoint based on actual available card container. No global truncation, font shrinking, hidden-overflow workaround or large refactor.

## Gates
Focused existing suites: advanced-import-panel16 + source-maintenance-panel2 + offline-library-settings7 =25 PASS. No existing AdvancedEditingPage-specific jsdom suite found; actual executed Playwright regression covers Tags geometry rather than pretend jsdom layout.
Commands (Node22 directory prefixed PATH):
- pnpm exec vitest run apps/web/tests/advanced-import-panel.test.ts apps/web/tests/source-maintenance-panel.test.ts apps/web/tests/offline-library-settings.test.ts
- pnpm --filter @t3/shared typecheck
- pnpm --filter @t3/server typecheck
- pnpm --filter @t3/web typecheck
- pnpm exec eslint apps/web/src/AdvancedEditingPage.vue apps/web/src/SourceMaintenancePanel.vue apps/web/src/components/OfflineLibrarySettings.vue
- git diff --check
All exit0; logs under fixture directory. Repeated after final container breakpoint CSS patch.

## Reproduction / handoff
Fixture: `.hermes/tmp/advanced-layout/`, server http://127.0.0.1:18744; health reports {ok:true,isolated:true,productionApi:false}. Start command `pnpm --filter @t3/web exec vite --config ../../.hermes/tmp/advanced-layout/vite.config.mjs`. Running session proc_401e6f426e75, launch PID47256. Leave running for parent verification. Re-run `C:/Users/hzy/AppData/Local/hermes/node/node.exe .hermes/tmp/advanced-layout/browser.cjs current-green`. Browser dependency uses existing Hermes playwright installation. Full working source/test byte checkpoint + hashes `checkpoint/manifest.json`; original hashes and final edited hashes `patch-manifest.json`; scoped.diff contains only this task CSS deltas.

Harness issues distinguished from product RED: initial vite path missing root vite symlink (fixed workspace exec); wrong shell test IDs (corrected to settings-button/advanced-entry); hidden first mobile nav button at768 (wait for settings instead); invalid locale zh (corrected zh-CN). Those failed setup runs do not count as defect or acceptance proof.

Phone hardware/touch/IME/keyboard/WebView/Keystore/native plugin/OS lifecycle UNVERIFIED. Browser geometry is Chromium desktop-engine proof, not phone proof. Upgrade should reuse current app data/media; no Clear/uninstall/re-download requirement introduced.
'''
p=root/'.hermes/artifacts/advanced-layout-implementation.md';p.write_text(report,encoding='utf-8')
print('checkpoint',len(rows),'full-byte files; current browser cases',len(current),'PASS; source/test writes stopped')
