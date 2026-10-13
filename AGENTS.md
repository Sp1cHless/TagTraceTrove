# T³ Agent Guardrails

T³ is a lightweight personal collection index.

For the live implementation boundary read `docs/status.md`; the board documents under `docs/` (`architecture.md`, `database.md`, `http-api.md`, `import-and-source.md`, `offline-sync.md`, `mobile.md`, `ui-design.md`, `siteprobe.md`, `development.md`) carry the detailed technical reference, and the forward-looking user plan is `docs/roadmap.md`. These are operational status, not replacements for the guardrails below.

Current data model: Entry and Producer are the core subjects. `Entry.type` supplies classification. Collections (migration `010_collections.sql`) are lightweight user-curated folders of Entries or Producers — the only stored grouping subject; Gallery itself remains a read-time projection of `Entry.type`, never a table. Entry and Producer tags use separate vocabularies. Entry tags always belong to Facets, and Facets always belong to Sections of the same Entry type. See `docs/architecture.md`.

Product priorities:
1. fast daily use
2. tag-first navigation
3. local ownership
4. source independence
5. progressive complexity

Never introduce database-platform features without explicit request. Do not expose database terminology in normal UI. Do not add formula systems, generic tables, project management, PKM features, media playback, downloads, or web-wide crawling.

All schema changes require a new immutable migration. Never change the schema merely to simplify frontend code.

Existing source files must be edited with targeted patches. Never feed paginated, summarized or character-truncated `read_file` output into a full-file overwrite. For any justified whole-file transformation, read complete bytes directly from disk, save a byte-identical recovery copy first, assert the expected original anchors, and reject unexpected shrinkage before writing. Large dirty files must never be restored from HEAD without proving that no uncommitted work would be lost.

Before UI work that depends on new database behavior:
1. add/review the migration;
2. update `db:probe`;
3. add real-SQL integration tests;
4. run `db:doctor`;
5. only then implement UI.

Tests must never touch `.data/library.db`. Use isolated in-memory databases for repository behavior and temporary file databases for WAL, backups, migration fixtures, and corruption/doctor tests.

Provider matching must always be user-directed. Common actions should avoid dialogs.

## Documentation state rule

`docs/` expresses the **latest completed, accepted state only**. A board document describes how the system works and what is done/measured — it must **not** carry pending, unverified or unfinished items, "remaining work" lists, TODOs, or per-change intermediate notes. Acceptance history (what was measured and accepted) may be recorded; *unaccepted* status may not. Where an earlier record conflicts with a later one, the later date governs.

**All intermediate state lives in exactly one place: `WORKLOG.md`** at the repository root — work in progress, to-be-accepted or unverified results, known unfinished pieces, migration notes, next steps. `WORKLOG.md` is **git-ignored and must never be committed or pushed**. When an item becomes accepted and permanent, move its durable content into the correct `docs/` board and delete it from `WORKLOG.md`.

The one exception is `docs/roadmap.md`, which is the forward-looking user plan by design.

Every change must follow this rule.

## Formal release discipline

T³ is on the formal release line. `release.json` is the single source of truth for the product
version, Android `versionCode`, application ID and expected Release signer.

- Every formally distributed or device-installed build with changed bits must use a new semantic
  version and a strictly larger Android `versionCode`. Never publish or install different content
  under an existing version.
- Preserve `com.speechless666.t3.spike` and the existing Release signing identity. Never replace,
  regenerate or fall back from the Release key, and never ship a debug-signed build as formal.
- Build formal artifacts through `Release.bat` / `tools/release/release.ps1`, which freezes one Web
  build into Android and Windows outputs. Never overwrite an existing release directory or
  distribute a directory marked `RELEASE-FAILED.txt`.
- Before calling a release ready, verify the package version/identity, expected signer,
  non-debuggable flag, frozen Web assets and published checksums. Packaging success, installation
  and physical-device acceptance are separate facts and must be recorded as such.
- Android updates use an in-place signed upgrade (`adb install -r` or the shipped installer). Check
  that pending work is zero first; never uninstall, clear app data or change pairing merely to make
  an update pass unless the user explicitly authorizes that destructive migration.
- Keep in-progress release facts only in `WORKLOG.md`. After measured acceptance, update the
  appropriate release/mobile/status documents with the exact version, hashes and verified scope;
  do not present unverified device behavior as accepted.
