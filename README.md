# T³ — Tag · Trace · Trove

> A local-first personal index for the things you find on the web: works, media, creators, links —
> kept as **your own** data, readable and editable forever, independent of the sites that produced it.

**T³** turns scattered bookmarks and screenshots into a real library: fast daily browsing, tag-first navigation,
and a database you own. Nothing is sent anywhere. No account, no cloud, no lock-in.

`中文说明 → [README.zh-CN.md](README.zh-CN.md)`

---

## ✨ What it does

| | |
| --- | --- |
| 🖼️ **Gallery-first browsing** | Every kind of work lives in its own Gallery. Covers show as depth-stacked cards; no tables, no rows of text. |
| 🏷️ **Tag-first, but structured** | Tags live in **Sections → Facets**, so a tag means the same thing everywhere. Entry tags and Author tags stay in separate vocabularies. |
| 🔎 **Real search & filters** | Global search across works / tags / authors, plus per-Gallery facet filters that *narrow* as you add tags. |
| 👤 **Authors, done properly** | Author pages, per-author works, Directories (fictional folders, without touching the works), alias groups for the same person across sites, and a one-tap "convert to multiple author". |
| ⭐ **Ratings with two sides** | A work's own dimensions *and* the author's own rating, plus the author's works-summary — so a film and its actor don't share one meaningless score. |
| 📁 **Collections** | Lightweight folders for works or authors, one nesting level, with their own NSFW switch. |
| 🕘 **Usage that stays out of the way** | Views, likes and last-viewed are **sort-only**. They never become a filter you have to think about. |
| 🌐 **Import from the web** | Point T³ at a site export and it becomes Entries, Authors, tags and source links — in one transaction, with a review step. |
| 🕷️ **Built-in site crawler** | **SiteProbe** learns a site's layout in your browser, then keeps it updated by itself. Turn any URL into an Entry. |
| 📵 **Works offline (phone)** | An Android app shares the same library: browse, edit, create, add images and merge with no connection, then syncs when you're back. |
| 🌗 **Light / dark, six accents** | Six colour presets, hand-written CSS, no UI framework in sight. |
| 🈶 **Bilingual** | Full English / 简体中文 interface, starting locale follows your device. |
| 🔒 **Local ownership** | SQLite on your machine, assets in a folder you can copy, backups and restore built in. |

## 🧱 The idea

Most tools ask you to organize the way *they* want. T³ asks for almost nothing up front and then gets out of the way:

- **Daily use first.** Clicking should beat configuring. Common actions never open a dialog.
- **Fast tagging over perfect metadata.** A rough tag you'll actually add beats a schema you won't.
- **Source is optional, never identity.** A work is your record, not a URL. The site can vanish; your entry stays.
- **Local ownership.** Your library is a file and a folder. Back it up by copying it.
- **Complexity must be earned.** Features arrive when real use calls for them, not before.

## 🚀 Getting started

### Requirements

- **Windows 10/11** for the tray launcher (the server itself is portable)
- **Node.js 22 LTS** and **pnpm 10** (only for the first build / source runs)
- A modern browser (Chrome/Edge/Firefox). For the phone app: an Android device.

### Run it (source)

```bash
pnpm install
pnpm build              # build server + web once
pnpm start:server       # serve the app at http://127.0.0.1:8765
```

Open `http://127.0.0.1:8765`. Development with hot reload:

```bash
pnpm dev:server                    # API on :8765
pnpm --filter @t3/web dev          # web UI on :5173
```

### Run it (packaged, no terminal)

From the repo root, double-click **`T3.exe`** — a tray launcher that starts the server hidden, opens your browser and
lives in the system tray until you exit. The first launch builds the web UI automatically. `T3.bat` does the same thing
in a console window (close it to stop).

Then use the tray's **Allow phone access (LAN)** toggle to let your phone connect on the same network.

### Your data

Everything lives under `apps/server/.data/` by default:

```text
.data/library.db      the SQLite library
.data/assets/         covers, previews, thumbnails
.data/backups/        whole-library backups
.data/templates/      per-Gallery template files
```

`pnpm db:backup` / `pnpm db:restore <dir>` (or the in-app System page) snapshot and restore the library and its assets
together. It's just files — copy the folder and you're done.

## 📱 The phone app

The Android app is the same UI in a WebView shell, paired to your desktop over the local network with an encrypted,
certificate-pinned connection. It carries a full **offline library**: browse, edit existing works, create new ones with
images, add tags and authors — all without a connection — and it replays everything the moment it's back on the network.

Build it from source (needs the Android SDK + JDK 21). See `docs/mobile.md` for the build/packaging chain and the
device-acceptance history.

## 🕷️ Importing from websites

Two doors, both inside T³:

1. **SiteProbe** — a bundled tool that opens a real browser, lets you click the parts of a page you care about, and
   learns a rule set for that site. Feed it a work URL, an author page or a folder listing.
2. **Import commit** — a reviewed, transactional commit that turns a crawl's output into Entries, Producers, Content and
   source links, with a per-author rating step and no guessing of unmapped fields.

Importing is idempotent: re-running over a site skips what you already have (and remembers each site's work IDs and
update cursors for you).

## 🧰 Everyday commands

```bash
pnpm test              # unit / component tests
pnpm test:integration  # real-SQL integration tests
pnpm typecheck         # TypeScript, all packages
pnpm lint              # ESLint
pnpm db:probe          # verify the schema + core scenarios
pnpm db:doctor         # read-only integrity check
pnpm db:backup         # snapshot library + assets
pnpm import:cursor ... # crawl-cursor status/filter/list/set
pnpm merge:authors     # collapse duplicate author spellings
```

## 🗂️ Repository layout

```text
apps/server/     local API, SQLite, repositories, import, sync
apps/web/        Vue 3 frontend (no UI framework, hand-written CSS)
packages/shared/ Zod contracts shared by both
siteprobe/       the bundled Python crawler/builder tool
tools/           tray launcher (C#) and the font subsetter
spikes/          the Android WebView shell + device probes
docs/            architecture, API, database, offline, mobile, UI, SiteProbe
```

## 📚 Documentation

Start at **[`docs/architecture.md`](docs/architecture.md)** for the data model, or **[`docs/status.md`](docs/status.md)**
for what's implemented right now. `docs/roadmap.md` holds the forward-looking work list.

## 🧭 Status

**In active development — a personal project, built for real daily use.** The desktop app, import pipeline and the
offline-capable Android app all work today; the packaging/update flow and a handful of offline conveniences are the
current frontier (see `docs/status.md`).

## 📄 License

Personal project. See the repository for details.
