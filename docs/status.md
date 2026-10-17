# T³ current status — implemented state

> The live boundary a receiver reads first, stated as the **latest completed, accepted state only**.
> Detailed boards: `architecture.md`, `database.md`, `http-api.md`, `import-and-source.md`,
> `offline-sync.md`, `mobile.md`, `ui-design.md`, `siteprobe.md`, `development.md`.
> The forward-looking user plan is `roadmap.md`; intermediate/not-yet-accepted state is kept in the
> git-ignored `WORKLOG.md` (never part of this document).

## 1. Delivered product surface

### Independent installed libraries (1.0.8 acceptance, 2026-10-13)

The 1.0.8 Demo acceptance used **`D:/Project/T3-1.0.4-windows-x64/TagTraceTrove`**, running Release **1.0.8**. The outer
directory keeps the user's original extraction name. The supplied 1.0.4 payload was moved into its `versions/1.0.4`
slot; existing Demo data was copied and byte-verified before startup. The same library identity, content count and
8785/8786 ports survived migration and a real extraction/merge update to 1.0.5. The former AppData installation was
moved into this tree's `backups/previous-AppData-install-*`; it no longer exists at the old location. Main listeners
kept their original PID. Evidence: this installation's `migration-check.json`.

The later merge/update to 1.0.8 was launched through the installation root's **T3.exe**, which performed the data
backup, version switch and startup automatically. The pre-update backup and running library agree on library ID,
sync epoch and content counts (13 Entries, 4 Producers, 0 Collections). Demo retained 8785/8786 and its name; the
desktop shortcut points to `versions/1.0.8/T3.exe`. Main 8765/8766 listeners retained PID 63408. Evidence:
`.hermes/artifacts/demo-1.0.8-update.json`. Normal installation and merged updates use the root EXE; CMD is optional.

From 1.0.5, Windows ZIP has a fixed `TagTraceTrove` content directory. Default installation is in the extracted tree;
program slots, data and backups remain within that installation. New-package `Install.ps1 -InstallRoot <existing root>`
performs a backup and switches slots. A root-level EXE also installs an extracted/merged newer payload into its own
tree; reopening the same root hands off to the current program without repeating installation or creating a backup.
The package/bootstrap/update path above passed the focused migration check on the user's Windows computer.

The Release installer supports stable per-installation HTTP/TLS ports and named shortcuts. Managed launchers bind
data, pairing files, SiteProbe home and static resources to their own installation; their single-instance mutex and
exit signal derive from the data path. Reopening an instance reuses only that instance; occupied foreign ports are
rejected. Updates inherit the instance identity and ports and create a full backup within that installation.

Before the migration above, installed and checked `T3 Demo` at `%LOCALAPPDATA%/T3-Demo`, HTTP 8785 / TLS 8786, using the actual 1.0.4 Release
executable and packaged runtime. Blank initial Entry query, independent pairing/shortcut, repeated launch, stop,
same-version reinstall with retained data/backup, and restart identity passed. Existing main listeners on 8765/8766
retained their original PID throughout. That location has since been retired as described above. Evidence: the preserved installation's `isolation-check.json`.
Instructions are in `release-installation.md`.

1.0.4 artifact identity: Android code 104, unchanged application ID/Release signer, non-debuggable build. APK SHA256
`ee4b238659ee2cc8f8fe78426df1779d8c2107888b2caa5c8959a29e0d3b1105`; Windows ZIP SHA256
`0674848a826389e4c86841cb9dfeb9f5908408362e46b2213443ba0d86ee7d19`. The measured instance behavior above is Windows.

The delivered desktop/server surface includes:

- Desktop web app: Gallery browsing, Entry detail/editing, Entry creation, entry media (cover/preview + thumbnails),
  Author pages + Directories, Collections, View later, Recently viewed, Random, global Search, tag-first filtering/sort,
  ratings (three classes), usage tracking, hideable / not-hideable partitions, i18n (en / zh-CN), Advanced editing, and an in-app
  SiteProbe import/rule surface.
- Shared server + web packages: `apps/server`, `apps/web`, `packages/shared`, plus the `siteprobe` Python tool and the
  C# tray launcher `T3.exe`.
- Offline library / sync / replay: read-only snapshot, capability-gated offline mutations, an outbox with causal
  ordering, idempotent replay, media replay, and the desktop System page. Full detail is in
  `offline-sync.md`.

### Current source behavior (2026-10-16)

The frozen published baseline is **1.0.14**; the source behavior below is separate from that package:

- Galleries support a persisted vertical/horizontal card preference. Horizontal cards show cover left/title right,
  two columns at most, with twice the configured rows. Migration 044 adds only this display preference; its column
  is excluded from offline snapshots/journals, and switching it requires a server connection.
- Image-less online cards show readable Content, then tags, then an initial. URL rows are skipped. Local pending works
  use the same selector; saved offline snapshots keep their original placeholders.
- The Tags mapping catalog is derived from current library tags and mappings, grouped as unmapped/mapped. New tags
  appear without a separate dictionary import. Tag deletion and mapping removal are separate actions.
- SiteProbe supports One/Several annotation, split-member previews, full long-description candidates with explicit
  preview/source-truncation notices, and latest-answer-per-field verification. Running imports/builders/sign-ins can
  be recovered from the panel; a builder can coexist with an installed-adapter import, with export writers serialized.
- Source startup checks Web freshness through one shared guard; the classic Service Worker follows the actual staged
  output directory. Pairing diagnostics add bounded local stage reports and matching desktop attempt IDs without
  credentials. Their installed availability follows the native app version (`mobile.md`).

Response extensions are opt-in (`coverText=1`, `includeTags=1`) so an installed 1.0.14 app retains its original strict
DTOs. The focused mixed-version HTTP integration check on 2026-10-16 passed **2/2**, using in-memory SQL and the current
web API client for both original and extended requests. Full details: `architecture.md`, `http-api.md`, `siteprobe.md`.

## 2. Android / offline device status

The Android shell (Capacitor WebView over the same web bundle) has a deep history of measured device acceptance. The
**current packaged formal release is 1.0.14**, Android versionCode **114**. Its frozen release manifest records the same application ID and expected Release signer.
On 2026-10-13 the user confirmed that mobile acceptance for the 1.0 formal release is complete. This records user
acceptance before the subsequent 1.0.8 packaging; the older per-build measured device results below remain their original historical records.
Before the formal release line, the offline-parity line was
**v49 (`0.0.49-c3-offline-parity`)**, built through a diagnostic series up to **r25**.

- **r25 (2026-10-12)** — USB testing exposed three settlement defects (full-snapshot fallback lacked a reacquired durable
  ACK for tag-layout apply; older accepted cover uploads were incorrectly required to survive later cover replacements;
  the desktop delta cache evicted all baselines before any sessions). Replay now reacquires ACK for every kind, evaluates
  accepted cover/order successors by receipt sequence, and server cache eviction compares age across sessions and
  baselines. Installed `T3-v49-offline-final-state-r25.apk`, SHA256 `2ca92fa4356ca17691e12498d4d496eb80b40c11b306986c570356ff4c12353e`.
  Existing phone work settled **12 → 0**; no conflicts/failures/errors. Real Wi-Fi disconnect/reconnect showed
  offline → syncing → updating → online, auto-advanced saved generations 29 → 31, removed the banner. **No schema
  migration introduced.**
- **r22 (2026-10-12)** — automatic offline UX: reconnects/foreground transitions coalesce into automatic local replay
  then updating the saved copy; first download remains explicit; failed updates stay due for later heartbeats; idle
  heartbeats do not redownload. Progress/error banners are informational and disappear after success. Sync now,
  pending-work export/restore, and manual support/persistence/native-resume controls are **removed**; support and storage
  checks run automatically; diagnostics/copy and blocked-edit review live at the bottom of Offline library.
- **r21 (2026-10-12)** — retained Gallery media refresh: `openEntry` propagates the latest detail media selection to
  retained Gallery/tag/batch card summaries.
- **r16–r20** — offline tag/layout chains (B10 `stable Facet identity is missing` + six isolated failures repaired),
  local final-state (editable drafts vs immutable submissions, `local-final-state.ts`), retained-media and cache fixes.

See `mobile.md` §8 for the full recorded device-pass table, and `offline-sync.md` §9 for the
settlement fixes and §10 for the by-design scope boundaries.

## 2b. Android 1.0.0 release configuration (2026-10-12)

Android now displays **T3**, versionName `1.0.0`, versionCode `100`; the application ID `com.speechless666.t3.spike` is
preserved. A release build uses a **dedicated RSA-3072 signing key** with 10,000-day validity, stored **outside the
checkout** in the user's `.t3/signing/` directory. Gradle reads private signing properties or secret environment
overrides and rejects release tasks with missing credentials; signing files are ignored. Release is non-debuggable
(Capacitor WebView debugging follows that flag; bridge logging is debug-only). Debug builds use a `-dev` version suffix.
No minification or unrelated runtime behavior changed.

- Signed artifact `spikes/001-android-webview-shell/T3-1.0.0.apk`, SHA256
  `fb29d33bc1b32167343462ed55e855c77490ad39a26999cb5c1ce28a865f0bb0`, signer certificate SHA256
  `62916b230436fdff08764004af8acbaf47b225b6f961b137c2479f714acfbb13`, bundle `assets/index-CzDnNPTm.js`.
- Focused release build/identity verification passed: signature, label/version, absence of the debuggable flag, and all
  15 packaged Web files. Manifest `.hermes/artifacts/android-release-1.0.0.json`; key lifecycle / build instructions
  `spikes/001-android-webview-shell/RELEASE.md`.

## 3. Historical release artifacts (frozen build evidence)

| Version | Package / marker | Note |
| --- | --- | --- |
| v43 | `0.0.43-c3-quick-duration-author-filter` | Quick-import duration, author-list rating filter. |
| v44 | `0.0.44-c3-advanced-layout` | Advanced-functions layout overflow (CSS-only). |
| v45 | `0.0.45-c3-media-cache-shards` | Media cache 256-shard FNV-1a; download rate 1.6 → 147 images/min. |
| v46 | `0.0.46-c3-transport-latency` | Native transport latency (openEntry 581 ms → ~130 ms); symptom 2 not reproduced. |
| v47 | icons + boot screen | Two source drawings → all sizes; inline boot screen; starting language follows device. |
| v48 | `0.0.48-c3-cjk-ui-text` | LXGW WenKai app font (Han-only `unicode-range`), Chinese copy pass. |
| v49 | `0.0.49-c3-offline-parity` | Offline parity lanes 01–12; the prior line, superseded by the 1.0.0 release, diagnostic up to r25. |
| 1.0.1 | `T3-1.0.1.apk` | Formal release line. APK SHA256 `1a5cd46fed16cd504fb53a0312cbbef80c534953e3b5431715d7a19f5e523ebb`; installed on the device. |
| 1.0.2 | `T3-1.0.2.apk` | Gallery filter-bar mobile layout: a row's × stays on its first line (long Facet/tag names ellipsise), the Authors row is one line, the head's label and toggle share a line. APK SHA256 `0f8dc3c04d700b2d78ca0e82826a657bfd14cc4c30d5d6445bf37d248c72fb3d`, signer `62916b23…fbb13`; cover-installed over 1.0.1 with data preserved and device-verified (`mobile.md` §8). |
| 1.0.3 | `T3-1.0.3.apk` | Same bar, every row on one line: the rating row's three selects divide the line (a native select no longer sizes to its longest option), the Facet row's tag input shares its line, and a wrapped row's × aligns with the first line. APK SHA256 `0dad307638715bd521d0123f3d610a0190f00cfd1847e5d2ca28e6831338104a`, signer `62916b23…fbb13`; cover-installed over 1.0.2 with data preserved and device-verified (`mobile.md` §8). |
| 1.0.5 | `T3-1.0.5.apk` | Earlier formal artifact, Android code 105. APK SHA256 `2bf0d8a18baa8846aba726f9d5e96075f811749623caa1ffa299ba54ac0dde16`; unchanged Release signer and non-debuggable identity verified. Mobile acceptance for the 1.0 release confirmed by the user on 2026-10-13 (`mobile.md` §8). |
| 1.0.7 | `T3-1.0.7.apk` | Earlier formal artifact, Android code 107. APK SHA256 `7229f788ba3e38fa9931d6a54c2f6bb3fa099d823ed5c9a0dfba2f861075b13d`; formal pipeline verified the unchanged signer and non-debuggable identity. |
| 1.0.8 | `T3-1.0.8.apk` | Earlier packaged formal artifact, Android code 108. APK SHA256 `b59ecd88b52adc2108d9717f7866bd175245c32f69a998c47f2fbff41e011d72`; formal pipeline verified the unchanged signer and non-debuggable identity. |
| 1.0.10 | `T3-1.0.10.apk` | Earlier packaged formal artifact, Android code 110. APK SHA256 `6456814df7b6ac052c3a1a6a57245af86828c02b9eab222484fad51f17e3da95`; unchanged signer, application ID and non-debuggable identity verified. Chromium 90 build target, JS/CSS capability fallbacks and unpaired diagnostic access passed focused tests and four frozen-package browser simulations (`mobile.md`). |
| 1.0.11 | `T3-1.0.11.apk` | Earlier packaged formal artifact, Android code 111. APK SHA256 `8052616de3816dd9542dd8205619e34a4b2ca9e06e9382f0d44544e3c32183f7`; unchanged signer/application ID and non-debuggable identity verified. Windows bootstrap resumes the installer's 0.0.0/null state; installation progress/errors and diagnostic entry points ship together. Focused synthetic recovery and frozen-package checks passed (`development.md`). |
| 1.0.14 | `T3-1.0.14.apk` | Published frozen baseline, Android code 114. Release manifest dated 2026-10-13 records APK SHA256 `b703b4efa1b73af8cf12de03d3a24be0b442cd7f8b0db5de0d86c7fdd30100ad`, application ID `com.speechless666.t3.spike`, expected signer `62916b230436fdff08764004af8acbaf47b225b6f961b137c2479f714acfbb13`. |

Current Windows ZIP: `T3-1.0.14-windows-x64.zip`, published SHA256
`ab3f6ed14f2751bbe0a16b7e6dfe8c4be30c2e615094cb4aebad4c49ceb1e301`.
The frozen manifest and published `SHA256SUMS.txt` under `.releases/1.0.14/` define this baseline.

Earlier Windows ZIP: `T3-1.0.11-windows-x64.zip`, SHA256
`1e44d93018781574d1379d0f365a0bc31b42a356e3af535c17ef7c9a217f2929`.
The 1.0.11 formal pipeline completed frozen-input, identity, signature, path-budget and checksum checks;
six published checksums, 18 APK Web files and the Windows recovery/diagnosis payload were verified.
The 1.0.8 Demo acceptance above is a historical installation record, separate from later package metadata.

Earlier Windows ZIP: `T3-1.0.10-windows-x64.zip`, SHA256
`ad3dba40d62428bea699e14f3496e8c78526c370bf37eccdee90b0bd92c9e44b`.
The 1.0.10 formal pipeline completed its frozen-input, signature, identity, path-budget and checksum steps;
the focused package check verified six published checksums and all 18 APK Web files. The Demo installation
above remains on its measured 1.0.8 state.

Earlier Windows ZIP: `T3-1.0.8-windows-x64.zip`, SHA256
`b174209bbfef091ed3e0ac53b23186cbec7db3bb3a475dea82bb7f969d5797fe`. The default Windows PowerShell 5.1
installation path is initialized after parameter binding; the focused runtime check exercised both direct `-File`
default installation and explicit destination installation. The actual merged EXE update is recorded above.
The 1.0.8 formal pipeline completed its frozen-input, signature, identity, path-budget and checksum steps.

Earlier Windows ZIP: `T3-1.0.7-windows-x64.zip`, SHA256
`a754db3ee4700fc55dcb5e1b062e67657763be4048e0f3a21454e965aed8159b`. Its dependency layout fixes the 1.0.6 Explorer
path-length failure; all payload-relative file paths are at most 142 characters, giving a longest planned Demo staging
file path of 219. Isolated installation/runtime and incompatible-version checks are recorded in `development.md` §8.
The 1.0.7 formal pipeline completed its frozen-input, signature, identity, path-budget and checksum steps.

Historical Windows ZIP: `T3-1.0.5-windows-x64.zip`, SHA256
`1d7f7a43d4b8973bf2e75c78fec4ddac6490ed5344cef13355c52a09c4022ec4`. The 2026-10-13 focused publication check
verified all six published checksums, the APK identity/signature/non-debuggable flag, fixed ZIP directory and the
absence of personal-data/signing paths. Runtime inputs matched the package's source fingerprint using the packaging
script's Windows PowerShell 5.1, before the subsequent documentation-only correction of the uninstall path.
See `release-installation.md` for the correction to the unchanged 1.0.5 bundled installation guide.

The signer certificate has been identical across the v43–v49 chain; those builds used the **debug keystore**. A
dedicated release key now exists (§2b). The formal line uses that Release identity, so the two chains cannot
upgrade into each other in place.

## 4. Not a core-plan gap

Existing-media replacement (including occupied-cover offline replacement), new Gallery/type, destructive subject
delete/merge, taxonomy/templates, and Import/Source batch are **online-only** by design and are not counted as missing
offline coverage. A fine-grained local conflict editor, an optional pure-browser PWA, a resident/auto-start service, and
continuing tasks after force-stop are neither delivered nor required defaults.

## 5. Working agreements that still govern changes

- One writer per file; targeted patches only; full-byte backups with SHA guards for large/whole-file transformations.
- Never touch the formal `apps/server/.data/library.db` or `assets/` without explicit authorization.
- Don't restart the desktop server yourself; the user restarts via the tray (Exit → launch) when needed.
- Every claim about behavior must be measured at the layer the user touches (see `development.md` §6).
