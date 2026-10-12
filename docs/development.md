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
pnpm lint             # eslint .
pnpm typecheck        # tsc --noEmit across packages

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
  only re-opens the browser and exits. First run builds the web UI automatically.
- **Icon** — `T3Launcher` carries `tools/t3-launcher/t3.ico` as its application icon and reads its own executable's icon
  for the tray, so the tray and taskbar cannot drift apart. The icon pipeline is generated by
  `apps/server/scripts/generate-icons.mjs` (needs `sharp`; writes the `.ico` itself). See `ui-design.md` §icons.

### Critical launcher rules (hard-won)

- ⚠ Both packaged entries start the server via the workspace-local **`tsx.cmd`**, NEVER `npm exec … pnpm start:server` —
  the npm-exec chain hangs when double-clicked from Explorer (no TTY) and survives window close as orphan node processes;
  this was the real "connection refused" cause on 2026-09-03.
- **Node runtime selection**: before starting `tsx.cmd`, both packaged entries probe project-local, Hermes, and PATH Node
  runtimes by opening an in-memory `better-sqlite3` database, then give the compatible runtime PATH precedence — this
  prevents Explorer's newer system Node from loading an incompatible native module.
- `T3.bat` writes `netstat` to a temporary file before applying one `/c:` `findstr` pattern; piping directly into a
  space-separated `findstr` expression can falsely treat any listening port as T3.
- Both packaged entries **load the server sources once at start**, so server-side code changes need a restart: unlike
  `pnpm dev:server` (tsx watch) there is no reload, and rebuilding only the web UI leaves a fresh bundle talking to an
  older server.
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

The Android app and the desktop share the same web bundle. Preparation chain and identity checks (versionCode, marker,
signer, packaged-web byte comparison) are documented in `mobile.md`. Release-signing decision (a stable release keystore
vs. the current debug keystore) is an open roadmap item.

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
