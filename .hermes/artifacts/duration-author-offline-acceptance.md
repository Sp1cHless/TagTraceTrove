# Duration / Author rating offline extension — bounded acceptance

Status: IMPLEMENTED / AUTOMATED + PACKAGE VERIFIED. Sole successor closed remaining seams and stopped writing. Parent verified complete checkpoint, bounded review, 1212 default / 655 integration / 60 native plus typecheck/lint/build gates, and v42 debug APK bytes/version/marker/original signer. Final evidence: duration-author-apk-verification.json and duration-author-release-final/manifest.json. DEVICE UNVERIFIED; no deployment or official data/service operation. First interrupted handoff is historical, not current. Parent owns docs/read-only and final review/root/build/package; child owns production/tests. v41 device checks remain deferred by the user; do not reopen the historical register.

## Live domain baseline

- Duration: migration 038; nullable integer seconds. Existing EntryStatsRow shows it beside page count, uses touch tap / pointer double-click, shared parse/format, blank clears, invalid stays editable. Online repositories, API and atomic create know it; snapshot metadata, offline read/queue/replay currently omit it.
- Rating: migration 039 + immutable correction 040; entry = work, producer = works summary, author_self = person/studio. Both Author classes have Gallery-scoped shared dimension templates and per-author values. Stored gallery_anchor determines the partition, including an author with no works. Current AuthorPage already has two groups and responsive wide-side-by-side / narrow-stacked layout; preserve edit-only hints and removal of manual reconcile UI.
- Current filter rules supersede the intermediate three-option version: expose entry + author_self only; legacy producer selector remains compatible. Entry missing explicit score falls back to the highest same-name works-summary score; author_self reads only author-self values. Four-or-more linked authors never inherit. Null is not zero. Filter and sort use the same effective value; legacy applyAuthorRating no longer changes server results. Current new-filter default is gt 3.
- Online wrapper third-argument createAuthorRatingSlot fix is already present. Do not reverse it or mistake it for complete offline support. The server already advertises offlineAuthorSelfRatings; client persistence/gates and actual per-class readers/queue/replay require verification.

## Finite acceptance

1. Duration add/edit/clear/0 and invalid UI input, durable cold IDB, original operation retry after response/ACK loss, correct SQL value and snapshot field, disjoint pageCount merge versus same-field conflict. Existing create/pending callers must not silently lose supplied duration. Optional new fields cannot rehash old envelopes.
2. Author read: both rating classes and durable anchor, same-name dimension class isolation, empty new class can acquire a valid template; no-work anchored Author supported. Preserve current template/global deletion semantics and per-author values.
3. Author write: create/set/clear/reorder/delete class-specific slots and values; anchor modification; cold persistence and actual replay/SQL/receipt verification. Refresh malformed/wrong-class/missing-field snapshots must not falsely clean canonical work.
4. SQL/offline parity for rating options, matching-name fallback, author-self filter/sort/unrated, old producer selections and both old flag values, four-author cutoff.
5. Export/atomic restore, current native contract/foreground reporting and immutable uncertain work remain truthful. No auth/pinning/ledger rewrite without actual targeted RED.
6. Upgrade compatibility: prior snapshot/outbox/work files remain readable; unsupported new writes fail closed. Retain media cache and test reuse across metadata refresh; no unconditional clear/reset/re-download or forced media-cache name change.

## Protection and release

Only disposable migrated SQL, temp assets and random temporary listeners; never official DB/assets/default services. Do not run default probe/doctor, deploy/restart/install or commit/reset/stash. Existing source gets complete-byte backups and targeted edits, with post-worker fresh reads and checkpoints. Never modify applied migrations; background capability polling has applied new migrations to the formal library in the other workstream before, so a new migration is not an innocuous file write.

After both items return: one bounded review, nearest/global checks, a strictly incremented APK and existing signer. Keep automatic evidence distinct from phone WebView/PluginCall/Keystore/OS behavior. User cannot test now; retain one grouped new-extension device sequence, not patch-by-patch requests.
