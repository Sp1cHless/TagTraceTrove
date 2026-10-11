# Read-only v40 bundle comparison

Inputs: `.hermes/tmp/recovery2-snapshot-candidate.ts`, subsequently independently checked `.hermes/tmp/recovery3-bundle-candidate.ts`; actual `apps/web/dist/assets/index-B5YHEFQj.js` (SHA256 `41329b1383bf65711bbb14326fa07e11f5207c185988a2cb0354899b8415c246`). No production edits or services/tests/network operations.

Exact bundle excerpts and offsets: `recovery-compare-exact-evidence.json`. Offsets labelled Codepoint are zero-based Python Unicode offsets, matching the supplied assignEntryTag=690194 convention; Utf16 offsets are TypeScript/JS offsets and differ by 8 at these locations.

## Confirmed additional missing executable behavior

### 1. Retry/preset Entry-create envelope reuse

Candidate3 `enqueueOfflineEntryCreate` line 2735: no `presetCreateOperation` reference anywhere in file. Actual bundle helper `Te`, codepoint offset 629555:

- `let a=e.presetCreateOperation!==void 0&&e.presetCreateOperation.operationKind===\`entry.create\`?e.presetCreateOperation:void 0`
- Rejects preset whose libraryId or syncEpoch differs from active snapshot: `This offline copy belongs to a different library revision; refresh it while online`.
- Initial-contents capability checks input contents OR preset payload contents.
- Title/type come from preset payload when preset exists.
- Preset ratings are copied as slotId-or-slotUid plus stars, rather than resolving current numeric IDs.
- `g=a===void 0?e.syncUid??c():a.entityUid`: stable entry entity UID reuse.
- Operation branch copies preset clientId, libraryId, syncEpoch, entityUid, opId, clientCreatedAt and payload title/type/uploadDate/pageCount/viewLater/contents; content syncUids/contentType/content/sortOrder are preserved. It resets queued status to pending and attempt/error to null.

Candidate instead always constructs a new operation with current client identity/random operation ID/timestamp and newly generated content identities. This is demonstrated missing v40 behavior, not proposed code.

### 2. Discard detects pending operations owned by another snapshot library/epoch

Candidate3 `discardBlockedOfflineOperations` line 3953 only selects initial blockers with status conflict/failed. Actual bundle helper `qe`, codepoint offset 675309:

`let e=await t.list(),r=await AF(t),i=r?.snapshot.header.libraryId,a=r?.snapshot.header.syncEpoch`

`if(e.status!==\`conflict\`&&e.status!==\`failed\`&&(i===void 0||e.libraryId===i&&e.syncEpoch===a))return;`

Thus when an active snapshot exists, a foreign libraryId/syncEpoch operation also seeds blocked chains, even if status pending. Subsequent dependency filtering, native pause before removeMany, failed-media cleanup, library invalidation, and replay-state refresh are present on both sides. Exact narrower missing behavior is the ownership predicate, not the rest of cleanup.

## Additional proven v40-vs-candidate difference, chronology not established

Candidate3 uploadEntryMedia line 4017 and setEntryMediaOrder line 4071 do not invoke forgetEntryMedia after offline enqueue paths. Actual v40 helper `x`, codepoint offset 596614:

`async function x(t){let n=e.assetUrl?.bind(e);n!==void 0&&await qF(t,{assetUrl:n,objectUrls:Cj})}`

Actual uploadEntryMedia codepoint offset 676583 calls x(await l()) after enqueue in offline mode, existing-media-outbox mode, and transport-error fallback. Candidate only calls forgetEntryMedia after online success, and legitimately newer offline enqueue returns an authoritative projected detail instead of the bundle's snapshot row.

Actual setEntryMediaOrder codepoint offset 678803 calls x(u) after enqueue both offline and transport-error fallback, where u contains previous and incoming refs. Candidate only does cache forgetting after online success.

This is an exact executable difference. Because fresh staged-preview/cache fixes are explicitly expected to differ from v40, do not automatically restore the old media return shape or label the cache difference incident loss without confirming a pre-incident read. Preserve newer projection behavior.

## Coverage / limitations

TypeScript AST extraction compared facade inventory: 84 vs83 total object members, 65 vs64 method declarations; extra method setGalleryOrder is authorised newer work. Source and bundle each have 71 direct closure helper declarations; bundle-only Tag result helper ye is known, while source-only enqueueGalleryOrder is authorised newer work. Property-call/literal comparison of methods identified only media paths, known Tag return/helper paths, and added Gallery capability write as executable call-count differences. Helper property/literal comparison after stripping types isolated preset create handling and ownership discard; remaining suffix differences are evaluation-order/minification/shorthand differences, not demonstrated missing code.

Client identity helper and native handoff/pause/resume mechanisms retain matching signatures; replayPendingOperations including revision-guarded snapshot application and acknowledgement has identical property/literal sequence after stripping types. This is static evidence, not a dynamic equivalence proof. No default DB/services were started. Candidate3 appeared during the review; its known Tag additions and the two findings above were independently rechecked.

Artifacts: recovery-compare-inspect.cjs, methods.json, report.json, bundle-facade.js, bundle-helpers.json, compile.cjs, compiled.js, compiled-methods.json, shapes.cjs, shapes.json, functions.cjs, functions.json, function-matches.json, exact-evidence.json, findings.md. All under .hermes/tmp/recovery-compare-*; no production or historical script executed.
