from run import R,B,guard,sha,owned
import json,datetime,difflib,subprocess
m=guard();report=R/'.hermes/artifacts/offline-parity-author-negative-proof.md';C=B/'checkpoint';C.mkdir(exist_ok=False)
gates={p.stem:json.loads(p.read_text()) for p in B.glob('*.gate.json')};drift={n:{p:[g['externalBefore'][p],h] for p,h in g['externalAfter'].items() if g['externalBefore'].get(p)!=h} for n,g in gates.items()};drift={n:d for n,d in drift.items() if d};(B/'dependency-drift-summary.json').write_text(json.dumps(drift,indent=2))
observed=R/'apps/web/src/offline/connection-recovery.ts';(B/'connection-recovery-observed.bytes').write_bytes(observed.read_bytes());diff=subprocess.run(['git','diff','--','apps/web/src/offline/connection-recovery.ts'],cwd=R,capture_output=True);(B/'connection-recovery-observed.diff').write_bytes(diff.stdout+diff.stderr)
j=json.loads((B/'focused-final-verified.json').read_text());assert j['success'] and j['numPassedTests']==47 and j['numFailedTests']==0
text='''# Author02 bounded foreground-delete proof negatives — STOP handoff

## Outcome and exact scope

Only the existing `apps/web/tests/offline-author-parity.integration.test.ts` changed: exactly two parameterized cases, fingerprint corruption and foreign identity. Production `offline-api.ts` and `pending-work-restore.ts` remain byte-identical to the registered handoff. These are first-GREEN existing-behavior defenses once harness assertions matched actual contracts; no production defect RED or source fix is claimed. No broader Author02 completion claim.

Both cases exercise real `createApiApp().request`, migrated memory SQLite, explicit temporary assetRoot/dataDir and fake IndexedDB. Actual Producer delete SQL commits, replay response is lost, real ACK is processed then its response is lost, absent-owner snapshot installs, and `producerDeleteProof.<original UUID>` persists. The genuine foreground proof contains `receipt:{entityId,resourceVersion,serverSeq}` plus the original operation fingerprint; it does NOT contain opId/status/library/epoch/UID receipt fields. Foreign identity changes only the actual `receipt.entityId` to another genuinely created Producer ID. Fingerprint case changes only `fingerprint`.

Cold retry gets the real immutable applied replay response, rejects the mismatching cached proof and actually requests the old authoritative journal at original serverSeq-1. Real server refusal `Cursor precedes acknowledged progress` is captured by a call-through spy (not synthesized). Queue retains exactly the original delete; `removeMany` is never called, immutable envelope/UUID/fingerprint remain identical and all three replay raw bodies are equal. Damaged metadata is not replaced by arbitrary receipt authority. Both works and the foreign Producer survive. This test does not require permanent hold when future fresh matching authority becomes available; it proves no unauthorized cleanup in this already-ACKed cursor scenario. Snapshot bootstrap may legitimately ACK its registered cursor; ACK alone is not delete cleanup authority.

## Actual gates and honest harness history

- Final `focused-final-verified.json`: **47/47 PASS**, success=true, failed=0, pending=0; Author25 + unchanged Entry-delete22.
- Configured owned ESLint: **exit0**.
- Scoped `git diff --check`: **exit0**; inherited LF/CRLF warning retained.
- Final web vue-tsc: **exit2**, only external `apps/web/src/offline/connection-recovery.ts(56,5): TS2322 Type Timeout is not assignable to type number`. No final owned-test type errors remain. This is NOT web-types GREEN.
- No source fix, so nearest178 was not rerun. No broad/default/build/server/shared/native/APK/device gates.

Earlier focused evidence preserved separately: initial45/47 setup assertion wrongly expected raw applied opId/status in the persisted narrowed receipt; next45/47 wrongly required zero snapshot-bootstrap ACK; next45/47 wrongly required a string per-row lastError (null is legal; real server rejection already captured). After these harness corrections47/47 passed. First web type run also exposed optional-method spy typing errors; corrected via a non-optional typed facade reference, then final47/47 rerun. None of these setup failures establish a production defect. No production behavior was changed to make tests pass.

## Parallel work / provenance

Owned/watched four-file hashes are guarded before/after every gate; fresh full-byte start backups and unique byte anchors/candidates preserve original CRLF/mixed bytes. Read-dependency SHA inventories and real UTC times are in each gate JSON. `dependency-drift-summary.json` records actual external changes; observed connection-recovery bytes/diff are external evidence only, not owned GREEN or a rollback candidate. Its retry/heartbeat change and timer typing are outside this Author-delete contract and were not absorbed. Final web type failure is explicitly handed off to the external writer/parent. No ordinary Producer delete/replay/proof/restore owned-file drift was observed. This does not establish a frozen whole-tree GREEN.

## Archive and stop

Fresh negative-prefix checkpoint: `.hermes/tmp/offline-parity-author/negative-proof/checkpoint/manifest.json`. It saves complete final four-file bytes plus this report, continuation-start hashes, exact start-to-final diffs and all raw local evidence; live/saved/hash equality is verified. Prior reports/checkpoints/evidence are untouched. Do not restore saved bytes over live source.

Source/test writes are STOPPED. The two authorized foreground negative classes are closed by application HTTP/SQL/fake-IDB evidence, not TCP/phone/Native evidence. The sole remaining platform seam is ordinary production Worker deletion / held dependencies / resume / native proof; no03, standalone seed/UI expansion or new malformed matrices are proposed. Web typecheck's external timer error is a separate gate blocker, not another Author02 negative or permission to edit parallel scope.

Formal DB/assets/default8765/8766/env credentials were not read/touched/requested/restarted. No migrations042/desktop/System/navigation/clientAPI/serverroutes/rootconfig/native/transport/auth/cache/media/launchers were written. No git commit/reset/stash/checkout, deployment, uninstall/cache clear/redownload/version/signing side effects.
'''
assert not report.exists();report.write_bytes(text.encode('utf-8'))
entries=[]
for p in owned+[str(report.relative_to(R)).replace('\\','/')]:
 live=(R/p).read_bytes();saved=C/'files'/p;saved.parent.mkdir(parents=True,exist_ok=True);saved.write_bytes(live);assert saved.read_bytes()==live
 start=B/'start'/p;startsha=sha(start.read_bytes()) if start.exists() else None
 if start.exists():
  q=C/'diffs'/(p+'.diff');q.parent.mkdir(parents=True,exist_ok=True);q.write_text(''.join(difflib.unified_diff(start.read_bytes().decode().splitlines(True),live.decode().splitlines(True),fromfile='start/'+p,tofile='final/'+p)),encoding='utf-8')
 entries.append(dict(path=p,saved=str(saved.relative_to(R)).replace('\\','/'),sha256=sha(live),startSha256=startsha,bytes=len(live)))
evidence=[]
for p in sorted(B.rglob('*')):
 if not p.is_file() or C in p.parents:continue
 d=p.read_bytes();q=C/'evidence'/p.relative_to(B);q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(d);assert q.read_bytes()==d;evidence.append(dict(path=str(p.relative_to(R)).replace('\\','/'),saved=str(q.relative_to(R)).replace('\\','/'),sha256=sha(d),bytes=len(d)))
manifest=dict(time=datetime.datetime.now(datetime.timezone.utc).isoformat(),files=entries,evidence=evidence,focused=dict(passed=47,failed=0),webTypes='BLOCKED external connection-recovery timer typing',sourceFix=False)
q=C/'manifest.json';q.write_text(json.dumps(manifest,indent=2),encoding='utf-8');guard()
for e in entries+evidence:assert sha((R/e['path']).read_bytes())==e['sha256']==sha((R/e['saved']).read_bytes())
print('LIVE == SAVED == SHA VERIFIED',len(entries),'files',len(evidence),'evidence');print('MANIFEST',sha(q.read_bytes()));print('REPORT',sha(report.read_bytes()));print('SOURCE',m[owned[0]]);print('TEST',m[owned[2]]);print('EVIDENCE focused-final-verified.json',sha((B/'focused-final-verified.json').read_bytes()));print('DEPENDENCY DRIFT',json.dumps(drift));print('STOP WRITING')
