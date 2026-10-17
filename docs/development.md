# T³ development board — runtime, commands, launcher, packaging

> How to build, run, test, package and ship T³. Product model is in `architecture.md`; schema workflow in `database.md`;
> offline/sync in `offline-sync.md`; mobile packaging in `mobile.md`.

## 1. Runtime stack

```text
Frontend         Vue 3 + Vite + TypeScript (no UI/CSS framework, hand-written CSS)
Backend          Node.js + TypeScript (Hono HTTP layer)
Database         SQLite + better-sqlite3 (backend-only; no ORM)
Validation       Zod (@t3/shared schemas)
Tests            Vitest (jsdom for web)
Package manager  pnpm 10.15.0
Monorepo         apps/server, apps/web, packages/shared, siteprobe (Python tool), tools/t3-launcher (C#)
```

Only the backend accesses SQLite. Every normal writable connection enables foreign keys, WAL, normal synchronous mode,
and a 5000 ms busy timeout.

## 2. Commands

Root `package.json` scripts:

```text
pnpm build            # build all packages (server tsc + web vite build)
pnpm dev:server       # API dev watch (tsx --watch) at 127.0.0.1:8765
pnpm start:server     # production server (serves API + built web UI)
pnpm test             # Vitest unit/component, excludes *.integration.test.ts
pnpm test:integration # real-SQL integration via vitest.integration.config.ts
pnpm test:triage      # runs both of the above, then re-runs each failing file alone
pnpm lint             # eslint .
pnpm typecheck        # package checks + cross-package integration-test types
pnpm typecheck:integration # typecheck tests/integration with the Vue/browser environment

pnpm db:doctor [path]
pnpm db:probe
pnpm db:backup [databasePath]
pnpm db:restore <backupDir> [databasePath]

pnpm import:site-probe <export-root>/metadata.json [--output canonical.json]
pnpm import:commit <canonical.json> <mapping.json> <database-path> --commit
pnpm import:cursor {status|filter|list|set} ...
pnpm merge:authors [<library.db path>] [--dry-run|--commit]
pnpm media:thumbnails   # resumable existing-assets thumbnail backfill
```

Run repo tests with the **bundled Node 22** the launcher selects (see §5), not whatever `node` is first on PATH.

Package tests stay within their package's TypeScript root. Tests that directly combine server and Web modules live
under `tests/integration/`, use `tsconfig.integration.json`, and run through the same Vitest integration command.
The Web typechecker uses ES modules and Bundler resolution to match Vite and Vue components.

Offline tests distinguish unsubmitted local drafts from immutable submitted/imported requests. Draft tests verify
the final selection and cold reopen; receipt/retry tests explicitly freeze a capture before expecting separate
original envelopes. Restore fixtures preserve the device identity and reset both queue and local-result metadata
when modelling an empty target. Shared fixtures live in each package's `tests/fixtures`, rather than being imported
from test files. Node HTTP fixtures route relative asset reads through their isolated server, since Node fetch has no
document origin to resolve them against.
TLS pairing tests require OpenSSL on the test process PATH and a valid `OPENSSL_CONF`; the formal Windows payload
includes both the executable and its portable configuration.

## 3. Running modes

Two run shapes share the server entry `apps/server/src/http/server-cli.ts` → `startApiServer`:

- **Development** — `pnpm dev:server` (API, tsx watch, `127.0.0.1:8765`) + `pnpm --filter @t3/web dev` (Vite,
  `127.0.0.1:5173`). The web app reaches the API cross-origin via the loopback CORS policy. `T3_DATA_DIR` defaults to
  `.data` under the server package.
- **Production single-process** — `pnpm build` once, then `pnpm start:server`: `createApiApp` receives `staticRoot`
  (default `<repo>/apps/web/dist` when the directory exists; override `T3_STATIC_ROOT`, empty disables) and serves the
  built UI **from the API origin**. `serveStatic` (hono) answers real files first; the `app.notFound` handler returns
  `index.html` for any non-`/api` GET (SPA fallback, client-side routes deep-link) and keeps JSON 404s for unknown
  `/api` routes. `T3_OPEN_BROWSER=1` spawns `cmd /c start` at the origin after listening (Windows only).
- **Packaged entries (repo root)** — `T3.bat` and `T3.exe`.

Source startup through `T3.bat`, the tray launcher, `pnpm dev:server` or `pnpm start:server` first asks
`tools/ensure-web-build.mjs` whether the Web bundle is older than its source/configuration/shared code/lockfile.
A stale bundle is built into `apps/web/dist.staged`; hashed assets are copied before `index.html`, preserving older
hashed files for already-open pages. Installed releases have no Web source tree and keep their frozen bundle.
The worker build follows Vite's actual output directory and emits a classic IIFE, matching registration and the
Chromium 90 build target. Rebuilding Web assets does not reload a running server's TypeScript; backend changes still
require the operator to exit and restart the service.

### Environment variables

```text
T3_HOST=127.0.0.1
T3_PORT=8765
T3_DATA_DIR=.data
T3_DB_NAME=library.db
T3_STATIC_ROOT=        # default <repo>/apps/web/dist when it exists; set empty to disable
T3_OPEN_BROWSER=1      # open the default browser after listening (Windows only)
T3_LOG_LEVEL=debug
T3_ENABLE_LAN=false    # binding outside localhost is rejected unless this is explicitly set
T3_PAIRED_HOST=<lan ip> # the private address the phone dials for encrypted pairing
T3_STATIC_ROOT, VITE_API_BASE_URL (web, build-time API override)
```

The server creates the data directory, opens SQLite, and applies migrations **before** listening. Browser CORS responses
allow localhost and loopback origins only by default.

## 4. Packaged entries and the tray launcher

- **`T3.bat`** — plain console server: port check (already listening → open browser, exit), first-run/`changed-sources`
  `pnpm run build`, then `cd apps\server && call node_modules\.bin\tsx.cmd src\http\server-cli.ts` with
  `T3_OPEN_BROWSER=1`; closing its window stops the server.
- **`T3.exe`** (recommended) — tray launcher in `tools/t3-launcher/` (C# WinForms, net10.0-windows, framework-dependent
  single-file publish via `build-launcher.bat`): starts the server hidden, opens the default browser, stays in the tray
  until Exit. Default launch explicitly binds `127.0.0.1`. The tray's **`Allow phone access (LAN)`** confirms
  trusted-network intent and restarts the owned server with `T3_ENABLE_LAN=true` and `T3_HOST=0.0.0.0`, while health
  checks and `Open T3` stay on localhost. `Mobile addresses` lists every active RFC1918 IPv4 URL and copies the selected
  one; firewall help is manual and Private-network-only. Disabling LAN restarts localhost-only, and Exit kills the server
  process tree. `--lan` and `--no-browser` exist for explicit startup/smoke tests. A second launch while the server is up
  only re-opens the browser and exits. Every start first asks `tools/ensure-web-build.mjs` to rebuild the web UI if its
  sources have moved past the bundle (see the launcher rules below).
- **Icon** — `T3Launcher` carries `tools/t3-launcher/t3.ico` as its application icon and reads its own executable's icon
  for the tray, so the tray and taskbar cannot drift apart. The icon pipeline is generated by
  `apps/server/scripts/generate-icons.mjs` (needs `sharp`; writes the `.ico` itself). See `ui-design.md` §icons.

### Critical launcher rules (hard-won)

- The tray launcher starts the selected Node executable directly with the local **`tsx/dist/cli.mjs`** argument; `T3.bat`
  uses the local `tsx.cmd`. Neither uses `npm exec … pnpm start:server` —
  the npm-exec chain hangs when double-clicked from Explorer (no TTY) and survives window close as orphan node processes;
  this was the real "connection refused" cause on 2026-09-03.
- **Node runtime selection**: before starting the server, both entries probe project-local, Hermes, and PATH Node
  runtimes by opening an in-memory `better-sqlite3` database, then give the compatible runtime PATH precedence — this
  prevents Explorer's newer system Node from loading an incompatible native module.
- `T3.bat` writes `netstat` to a temporary file before applying one `/c:` `findstr` pattern; piping directly into a
  space-separated `findstr` expression can falsely treat any listening port as T3.
- Both packaged entries **load the server sources once at start**, so server-side code changes need a restart: unlike
  `pnpm dev:server` (tsx watch) there is no reload, and rebuilding only the web UI leaves a fresh bundle talking to an
  older server.
- The other half of that pair is the **bundle must never be older than its source**. A browser holding the previous
  front end talks to the current API and rejects a field it does not know, so the symptom is a schema error in the page
  (`unrecognized_keys` on a *response*) rather than anything the person can act on. `tools/ensure-web-build.mjs` owns
  that decision, so the `.bat` file, the tray launcher, `pnpm dev:server` and `pnpm start:server` cannot disagree about
  it; it rebuilds only when a Web source, `packages/shared/src`, the build configuration or the lockfile is newer than
  `apps/web/dist/index.html`, and it stages the build and publishes it with `index.html` last so it stays correct with a
  server already serving that directory. An installed payload ships no Web sources, so there the same call is a no-op.
- `T3.bat` also advertises the private address (finds the first RFC1918 IPv4) into `T3_PAIRED_HOST` unless already set, so
  encrypted pairing works from a packaged plain launch.

## 5. Node runtime and version pitfalls

Test, lint, typecheck, and build commands must run on the same project-local Node the launcher selects (currently the
**Hermes runtime, Node 22**). A newer system Node (26+) defines its own global `localStorage` getter, which the vitest
`jsdom` environment does not override, so every jsdom test touching `window.localStorage` fails with `Cannot read
properties of undefined (reading 'clear')` — a runtime mismatch, not a code fault. Put the bundled POSIX path first on
PATH before running repo tests.

`better-sqlite3` is built for Node 22; the shell's default `node` may be v26, producing dozens of bogus failures.

Windows/Git-Bash notes: `grep -P` and heredocs have environment quirks; native Android Gradle runs need the bundled
**Adoptium JDK 21** first on PATH (Oracle JDK 25 class files are unreadable to Robolectric 4.14.1) and must be invoked via
`cmd //c`.

## 6. Verification discipline

```text
pnpm test
pnpm test:integration
pnpm db:probe
pnpm db:doctor
pnpm lint
pnpm typecheck
pnpm build
```

### Reading the failure count

The two suite commands are separate on purpose, and the number a **single pool** prints is not the truth about
the code. The integration files each open a real SQLite file, a jsdom window and a temp directory, so when every
file runs in one pool the heavy ones lose their timing and fail on assertions nobody touched. Measured
2026-10-17: `pnpm test` reported 3 failures and `pnpm test:integration` 19 — and of those 22, **one** still failed
when its file ran alone; the other 21 passed alone and also passed in a group of five.

So: never report a pool's failure list as a code problem, and never start reading twenty failures one by one.
Run `pnpm test:triage` (the same two suites, then each failing file on its own) and report only the files it
marks `RED ALONE`; the rest are the pool. A bare `vitest run` with the default config is the worst case of all —
it loads `*.integration.test.ts` **and** the unit files into one pool that is tuned for neither.

No database-backed product UI is valid until the `db:probe`/doctor gates pass (see `database.md` §3). The product
boundary (`AGENTS.md`) governs scope: no generic schema builder, formula system, tables-as-product, PKM, media playback,
downloads, or web-wide crawling.

**Verification must happen at the layer the user touches.** Source-level checks have hidden a stale web build, a broken
UI gate, and a stale *process* (the live port answering 400 `unrecognized_keys`). After changing server code, remember
the deployed entry point loads sources once (no watch) and the live server migrates on a `/api/sync/capabilities` poll but
keeps its pre-change request schemas until a restart — re-measure against the listener's start time, and don't restart
the server yourself.

## 7. Testing strategy (summary)

- Isolated in-memory / temp-file SQLite for repository, migration, WAL, backup, and doctor behavior; tests never touch
  `.data/library.db`.
- Web tests: Vitest + jsdom + `@vue/test-utils` + `fake-indexeddb` for offline behavior.
- Native Android: Robolectric JVM tests, run in per-class forks (a shared-process Robolectric SQLite crash is known).
- Integration suites must declare realistic timeouts for large payloads (6–17 MB delta payloads need up to 60 s).
- Test expectations must come from **measurement**, not from assuming what a component does.

## 8. Build & release chain (offline/Android)

The Android app and desktop share one Web build through `Release.bat` / `tools/release/release.ps1`.
`release.json` owns the version and Android versionCode/signing identity. Windows ZIP includes the self-contained
launcher and portable Node/Python/Chromium/OpenSSL dependencies. Installation keeps data separate from versioned
programs, backs it up before updates and retains it during ordinary uninstall. Release key configuration is implemented.
See `release-installation.md` for prerequisites and Windows/Android lifecycle instructions; broader clean-machine GUI
acceptance is still separate from the isolated lifecycle/runtime check.

The 1.0.10 pipeline's frozen source fingerprint covers the Web compatibility build helper and
dependency manifest, Android `prepare-web.mjs` and Capacitor configuration in addition to the
existing Web/server/shared/native/release sources. The same Web build feeds both packages.
The completed pipeline verified versionCode 110, unchanged application ID/Release signer,
non-debuggable APK, frozen inputs and path budget. The focused package check compared all
18 Android Web files and six publication checksums and exercised four browser capability
scenarios (`mobile.md`, browser compatibility section).

The release entry automatically increments the patch version and Android code, preserving the app and signer identity.
Prior release metadata establishes their minimums; occupied version directories are skipped. Configuration is saved after
dependency checks, with its byte-identical recovery copy under `.releases`. Failed builds retain their allocated version,
so a normal retry advances again. `-KeepVersion` supports a manually prepared new major/minor release, still requiring
monotonic version/code. An exclusive build lock prevents concurrent version allocation. The focused Windows PowerShell
5.1 versioning check passed for increment/retry, existing metadata, identity retention, recovery bytes, manual version and
changed-configuration rejection; the release scripts parsed under the same runtime.

From 1.0.7, runtime materialization hoists shared Node packages to the server's `node_modules`; conflicting physical
versions retain local overrides. Ordinary dependency depth no longer adds directory depth. The focused layout check
installed the actual materialized graph through Windows PowerShell 5.1 in an isolated version slot and exercised SQLite,
jsdom, sharp, QR, tsx, shared code and an in-memory HTTP app. Conflicting-version fixtures retained both resolutions;
the longest Node relative path was 118 characters and the installed test path was 217. The final 1.0.7 payload's maximum
relative file path is 142 characters. Packaging rejects paths above 145; installation uses a 12-character staging suffix
and rejects excessive complete file/directory paths before modifying installation data.

From 1.0.8, the optional `InstallRoot` parameter is defaulted inside the script body. Windows PowerShell 5.1 can bind
an advanced script's `$PSScriptRoot` default as empty when invoked through `-File`, although invocation with `&` works.
The focused runtime check covers both default in-place `-File` installation and an explicit destination, followed by
the installed dependency/runtime exercise. The actual Demo root EXE merge/update to 1.0.8 also completed its backup,
slot switch, startup and shortcut update while retaining identity, content counts, ports and the original main PID.

Independent Windows startup diagnostics use `tools/release/Diagnose.cmd` and `Diagnose.ps1`;
the support archive runs without the launcher or application UI. The focused Windows PowerShell
5.1 check on 2026-10-13 covered an intact 1.0.10 payload (6,971 manifest files present and a
successful in-memory native dependency query), an incomplete installation record, missing/outside
manifest paths, and default-folder binding in a path containing spaces. Each produced a report;
the published EXE bytes were unchanged and no installation data directory was created. Evidence:
`.hermes/tmp/startup diagnostics 01ed748b0e07474799a22730561b01b5/`.

The r2 support tool displays each diagnostic stage and reuses the shipped `Read-T3Manifest`
and `Assert-T3Stopped` functions without running `Install.ps1`. Its focused check verified all
6,971 1.0.10 payload hashes and preserved their bytes; synthetic intact/corrupted payloads
respectively reported the original preflight pass and exact damaged filename. Original installer
fixtures with no real EXE/service/database also exercised Unicode/space/ampersand/bracket paths,
long destinations, injected WMI/shortcut failures and an interrupted-install retry that retained
its temporary data sentinel. Evidence: `.hermes/tmp/install failure cases 5aa8ca91a9db4ebfae3ee92326df89e4/`
and `.hermes/tmp/startup diagnostics 4ca64b081d124a3898fdef43f858b17c/`.

### Interrupted installation recovery (1.0.11, 2026-10-13)

The launcher treats the installer's `0.0.0` / null-current-directory initialization record as
a retryable bootstrap state before resolving paths. Completed same-version records hand off;
new payloads install; malformed, foreign and non-initial empty records remain rejected. Early
startup exceptions and hidden installer output go to `t3-startup.log`; installation stages,
file progress and contextual copy errors go to `t3-install.log`, with user/temporary fallbacks.
Optional desktop shortcut failure logs a warning after stable entry points are installed.

The focused recovery check exercised the reported null record, completed/upgrade selection,
invalid records and startup logging. A synthetic installer fixture forced a copy collision,
retained its initialization record, recorded the failed filename/stage, then retried successfully
without changing its temporary data sentinel. Shortcut rejection was nonfatal and diagnostics
were copied to the stable root. No real service, EXE or database was started in these fixtures.
Evidence: `.hermes/tmp/install recovery ee2c65a7339e43edaf35e17370917710/`.

The formal 1.0.11 pipeline verified versionCode 111, unchanged application ID/Release signer,
non-debuggable APK, frozen inputs and path budget. The publication check verified six checksums,
18 Android Web files and recovery/diagnostic files in the Windows ZIP. Evidence:
`.hermes/artifacts/release-1.0.11-verification.json`.

## 9. Repository layout

```text
apps/server/src/
  database/{migrations,queries,seed,doctor}
  http/                 app.ts, server.ts, server-cli.ts, system-routes.ts
  import/               commit.ts, site-probe.ts, preview.ts, crawl-state-cli.ts, cli.ts, merge-producers-cli.ts
  repositories/         one concern each (see architecture.md §6)
  routes/  services/  sync/  taxonomy/  templates/
  siteprobe/            T³-side SiteProbe job/route integration
  source-maintenance/{adapters,catalogs}
apps/web/src/
  GalleryApp.vue (+ pages: Home/Author/Entry/Collections/Search/Recent/ViewLater/Random/AdvancedEditing/AddEntry)
  api/  offline/  sw/  stores/  components/{entry,tags,fields,filters,collection,sources,icons}
  i18n.ts  navigation-memory.ts  armable.ts  theme in styles/theme.css
packages/shared/src/schemas/   api.ts, suggestions.ts, import.ts, sync.ts, siteprobe.ts, pending-work.ts, ...
siteprobe/                     the Python crawler tool (see siteprobe.md)
tools/t3-launcher/             T3.exe (C# tray launcher) + contract tests
tools/fonts/                   subset-wenkai.py
templates/                     built-in Gallery template JSON (common-template.json)
spikes/001-android-webview-shell/   Android/Capacitor shell + device probes
```
