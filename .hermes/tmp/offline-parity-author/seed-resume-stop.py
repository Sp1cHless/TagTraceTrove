from pathlib import Path
import hashlib,json
r=Path('D:/Project/TagTraceTrove');o=r/'.hermes/tmp/offline-parity-author/seed-resume'; dest=o/'stop-checkpoint';dest.mkdir(exist_ok=True)
sha=lambda b:hashlib.sha256(b).hexdigest();w=json.loads((o/'watch.json').read_bytes());sources={}
for n,h in w.items():
 b=(r/n).read_bytes();p=dest/'sources'/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b)
 sources[n]={'resumeStart':h,'actual':sha(b),'saved':sha(p.read_bytes()),'provenance':'observed-external-drift' if sha(b)!=h else 'unchanged-resume-baseline'}
report='''# Author Directory seed resume — STOPPED, no production/test writes

Fresh start verified the supplied STOP manifest's 27 live files and saved 571 complete source/test/config/report byte copies plus SHA watch. GalleryApp and its external performance test baseline were preserved. No old seed scripts were rerun, and no fix candidate/apply stage executed.

First red-types runner attempt failed setup because guessed Git bash executable path did not exist; this is not application RED. Subsequent red-nearest pre-gate guard detected external modification of apps/web/tests/pending-work-restore.test.ts: expected b0ecc7a537a72b22331245c595f11e03aa5ad36c067f7ec622eb14eb166281b2, actual 23075b40316868d59f925dc0cfd9a5b9c0b4a4d9b919aa37b0fa5fd11ac3f056. No nearest tests ran. Unfortunately the already-submitted compound shell command used semicolons and therefore continued to direct pnpm typecheck after the guard failure; it exited 2. This execution-discipline mistake is disclosed, and the result is NOT frozen/current GREEN. No further gates or production/test writes followed. Future compound commands must use fail-fast &&, never semicolons after guard-sensitive work. Correct discovered bash executable: D:/install/Git/usr/bin/bash.exe.

Still unapplied: probe.ts seeded check must use buildSyncCapabilities(database, 'probe') matching the existing probe call and function signature. Three receipt rollback tests need complete SELECT * FROM sync_changes ORDER BY seq and sqlite_sequence snapshots captured before injected failure. Current files retain all original partial defects; no hard-coded journal rollback assertions were substituted.

02 remains WORKING; no03, no owner GREEN. Seed feature implementation exists but current full gates remain unclosed. Inherited finite cells: gap1 remaining negative authority cases; gap4 independent Directory seed current gates/native and remaining actual caller variants (Collections/Random departure, previously facade-only rating/layout gestures not represented as UI proof); gap5 restore matrix; gap6 connected/no-copy, capability/legacy unknown and wrong snapshot cells; gap7 production Worker create/edit/delete and held/resume timeline. No expanded audit. Next concrete prerequisite is coordinate this new pending-work-restore.test.ts writer, release ownership and verify actual bytes; then fix the stated probe/three rollback declarations and run nearest/types followed by focused/default/integration/lint/diff/isolated client Vite once. Native seed test XML remains UNVERIFIED; no Gradle launched.

No formal DB/assets/default services read/touch/request; no existing migration edits, APK/build version/signing/deploy/git restore/reset/stash/commit or cache/media changes. Stop checkpoint contains observed actual bytes, not repaired GREEN or authorization to overwrite external changes.
'''
(o/'STOP.md').write_text(report,encoding='utf-8'); reportbytes=(o/'STOP.md').read_bytes();(dest/'STOP.md').write_bytes(reportbytes)
m={'status':'STOPPED_EXTERNAL_SOURCE_DRIFT_NO_PRODUCTION_TEST_WRITES','sources':sources,'report':{'path':str(o/'STOP.md'),'actual':sha(reportbytes),'saved':sha((dest/'STOP.md').read_bytes())},'drift':json.loads((o/'drift.json').read_bytes()),'appliedEdits':[],'native':'UNVERIFIED_NOT_RUN','gates':'NO_CURRENT_FROZEN_GREEN','evidence':{}}
for name in ['red-types.log','red-types-direct.log','drift.json']:
 b=(o/name).read_bytes();p=dest/'evidence'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b);m['evidence'][name]={'sha256':sha(b),'size':len(b)}
(dest/'manifest.json').write_text(json.dumps(m,indent=2),encoding='utf-8');print('STOP manifest',sha((dest/'manifest.json').read_bytes()),'files',len(sources));print((o/'red-types-direct.log').read_text(encoding='utf-8',errors='replace')[-5000:])
