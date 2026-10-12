# T³ current status — implementation boundary and remaining work

> The live boundary a receiver reads first. Detailed boards: `architecture.md`, `database.md`, `http-api.md`,
> `import-and-source.md`, `offline-sync.md`, `mobile.md`, `ui-design.md`, `siteprobe.md`, `development.md`.
> Forward-looking work only lives in `roadmap.md`.

## 1. Delivered product surface

Everything in the current scope is implemented, tested and accepted on the desktop/server side:

- Desktop web app: Gallery browsing, Entry detail/editing, Entry creation, entry media (cover/preview + thumbnails),
  Author pages + Directories, Collections, View later, Recently viewed, Random, global Search, tag-first filtering/sort,
  ratings (three classes), usage tracking, SFW/NSFW partitions, i18n (en / zh-CN), Advanced editing, and an in-app
  SiteProbe import/rule surface.
- Shared server + web packages: `apps/server`, `apps/web`, `packages/shared`, plus the `siteprobe` Python tool and the
  C# tray launcher `T3.exe`.
- Offline library / sync / replay: read-only snapshot, capability-gated offline mutations, an outbox with causal
  ordering, idempotent replay, media replay, and the desktop System page. Full detail and the remaining gaps are in
  `offline-sync.md`.

## 2. Android / offline device status

The Android shell (Capacitor WebView over the same web bundle) has a deep history of measured device acceptance. The
latest packaged line is **v49 (`0.0.49-c3-offline-parity`)**, built through a diagnostic series up to **r25**.

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

See `mobile.md` §8 for the full recorded device-pass table and the checklists, and `offline-sync.md` §9–10 for the
settlement fixes and remaining gaps.

## 3. Historical release artifacts (frozen build evidence)

| Version | Package / marker | Note |
| --- | --- | --- |
| v43 | `0.0.43-c3-quick-duration-author-filter` | Quick-import duration, author-list rating filter. |
| v44 | `0.0.44-c3-advanced-layout` | Advanced-functions layout overflow (CSS-only). |
| v45 | `0.0.45-c3-media-cache-shards` | Media cache 256-shard FNV-1a; download rate 1.6 → 147 images/min. |
| v46 | `0.0.46-c3-transport-latency` | Native transport latency (openEntry 581 ms → ~130 ms); symptom 2 not reproduced. |
| v47 | icons + boot screen | Two source drawings → all sizes; inline boot screen; starting language follows device. |
| v48 | `0.0.48-c3-cjk-ui-text` | LXGW WenKai app font (Han-only `unicode-range`), Chinese copy pass. |
| v49 | `0.0.49-c3-offline-parity` | Offline parity lanes 01–12; current line, diagnostic up to r25. |

The signer certificate has been identical across the v43–v49 chain; the **debug keystore** is still in use — a stable
release keystore decision is an open item (see `roadmap.md`).

## 4. Remaining implementation / release work

- Offline: exhaustive gestures / background lifecycle still unverified; the change-feed ack is deliberately withheld until
  complete snapshot/journal parity; incremental client materialization and atomic local cursor activation remain TODO.
- Offline: some pending vocabularies (new Tag / Facet creation) remain unfinished; several delete/merge operations stay
  online-only by design.
- Release: decide a stable release keystore and the upgrade/rollback path; prepare the packaging/update/uninstall flow.
- Formal deployment needs separate authorization and a safe backup/migration/assets integration (never operate the
  formal library by default).

## 5. Not a core-plan gap

Existing-media replacement (including occupied-cover offline replacement), new Gallery/type, destructive subject
delete/merge, taxonomy/templates, and Import/Source batch are **online-only** by design and are not counted as missing
offline coverage. A fine-grained local conflict editor, an optional pure-browser PWA, a resident/auto-start service, and
continuing tasks after force-stop are neither delivered nor required defaults.

## 6. Working agreements that still govern changes

- One writer per file; targeted patches only; full-byte backups with SHA guards for large/whole-file transformations.
- Never touch the formal `apps/server/.data/library.db` or `assets/` without explicit authorization.
- Don't restart the desktop server yourself; the user restarts via the tray (Exit → launch) when needed.
- Every claim about behavior must be measured at the layer the user touches (see `development.md` §6).
