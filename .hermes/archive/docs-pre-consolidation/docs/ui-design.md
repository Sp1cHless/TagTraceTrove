# T³ UI Design Board

The single consolidated reference for T³'s frontend: architecture, design system, UX
rules, shared components, the Home page, the icon spec, sort/mode controls, tooltips
/ARIA/motion/i18n, the external-AI plan format, and the audit dispositions that still
govern behaviour.

This file absorbs the durable content of:

- `docs/ui-overview.md` — architecture index and external-AI plan contract
- `docs/ux-rules.md` — the UX rule list
- `docs/T3-Homepage-Design-Guide.md` — Home design/implementation guide
- `docs/T3-UI-and-Icon-Brief.md` — UI adjust brief + icon art brief + sort/tooltip/ARIA rules
- `docs/ui-sandbox.md` — how to run the web UI and what the product page does
- `docs/deep-audit-disposition.md` — whole-library audit A/B/C disposition list
- `docs/t3-homepage-sample.html` — mockup, read only for concrete layout/structure facts

Superseded design drafts, dated micro-fix narrative, the user's raw requirement text and
restatements have been dropped; final decisions and their reasons are kept. Statements
about present-day source (`theme.css`, `EntryCard.vue`, `HomePage.vue`, `icons.ts`,
`GalleryApp.vue`, `i18n.ts`) were verified against the working tree when this file was
written; where the implementation has moved past an older brief, both are noted.

All file paths are relative to `apps/web/` unless stated otherwise. Line counts are
approximate snapshots for sizing review only — never a stable API.

## Table of contents

1. [Frontend architecture & constraints](#1-frontend-architecture--constraints)
2. [Design system (theme.css, accents, light/dark)](#2-design-system)
3. [UX rules](#3-ux-rules)
4. [Key files](#4-key-files)
5. [Shared components & cards](#5-shared-components--cards)
6. [Home page](#6-home-page)
7. [Icons & icon spec](#7-icons--icon-spec)
8. [Sort / mode controls](#8-sort--mode-controls)
9. [Tooltips, ARIA, motion, i18n](#9-tooltips-aria-motion-i18n)
10. [External-AI plan format & division of labour](#10-external-ai-plan-format--division-of-labour)
11. [Audit dispositions](#11-audit-dispositions)

---

## 1. Frontend architecture & constraints

- Vue 3 `<script setup>` + Vite + TypeScript. **No** UI framework, CSS framework, icon
  library, font CDN or third-party runtime UI dependency. All styling is hand-written CSS.
- The Web entry point is the database-backed `GalleryApp.vue` product page. It talks
  **only** to the local HTTP API; the frontend never opens SQLite directly.
- Run for development (API and web in separate terminals):

  ```text
  pnpm start:server
  pnpm --filter @t3/web dev
  ```

- `styles/theme.css` defines light/dark, surfaces, borders, shadows, accent and the Tag
  palette. Components only ever **read variables**; they never hardcode theme colors.
- `[data-accent]` supplies six palettes — blue, teal, violet, rose, amber, green.
- All SFC `<style>` blocks are **scoped**, so class names do not leak across components.
  A few deliberate exceptions are defined globally in `theme.css` (shared buttons, the
  connected-tab strip, `.icon-button`/`.icon-tooltip`, the entry-card base) precisely
  because many pages would otherwise duplicate them.
- All visible copy lives in `src/i18n.ts` as flat en / zh-CN dictionaries; the two key
  sets are **forced equal by test** (`apps/web/tests/i18n.test.ts` asserts
  `Object.keys(messages.en)` equals `Object.keys(messages['zh-CN'])`).
- Destructive operations use the two-step arm/confirm pattern in `src/armable.ts`. Native
  `window.confirm` is forbidden.
- `GalleryApp.vue` owns the mutually-exclusive full-page views and the source-restore
  ("which view did the user come from") logic. Any shell change must preserve the
  sidebar's top priority and Back context.

### 1.1 Routing reality

There is **no Vue Router** in the app (the `src/router/` directory holds only a
`.gitkeep`). "Routing" is the view ladder inside `GalleryApp.vue`: `isHomeView` is the
fallback when no Gallery / Entry / other page is active, `showHome()` returns to it, and
`navigation-memory.ts` holds ephemeral per-view state (pages, per-page state) that must
survive a detail drill-down because child pages are intentionally remounted by the
ladder. The user-visible routing contract (root opens Home, never a first-Gallery
redirect; Back returns to Home) is stated in [§6](#6-home-page).

### 1.2 Desktop visual-task constraints

These apply to desktop visual upgrades that do **not** change behaviour:

1. Only touch `apps/web` Vue / CSS / i18n; do not touch server, shared, schema or API.
2. Do not add UI frameworks, CSS frameworks, fonts or icon CDNs.
3. Do not remove or rename `data-testid`, and do not change button behaviour semantics.
4. Colors go through `theme.css` variables only; danger red and rating gold are the only
   semantic-color exceptions.
5. New copy must supply both en and zh-CN.
6. Work-card visuals are changed only in `components/EntryCard.vue`.
7. Check light/dark, all six accents, and existing desktop widths.

Mobile is **not** a pure-visual task: it may add a responsive shell, touch-equivalent
controls and feature-detected behaviour, but must keep domain semantics, test anchors,
shared cards and desktop features. Mobile detail lives in the mobile handoff docs.

### 1.3 Mobile-related facts (responsive web, not a native fork)

- The unified mobile breakpoint is **44rem**. Below it the sidebar becomes a closable
  drawer supporting an overlay, Escape, Browser Back and safe-area insets.
- Every former drag/drop organization path has an explicit tap equivalent; desktop drag
  still exists but is never the only entry.
- `EntryCard` media uses `LazyCardImage` (see [§5](#5-shared-components--cards)).
- Settings, detail toolbars, the Facet filter, Advanced editing, Add Entry/Author and
  pagination are all adapted to narrow screens and 44px touch targets.
- Final mobile scope is every existing **non-import** function; site-probe folder/batch
  import stay desktop-only.
- Chrome is the primary real-device browser, but user-agent / Chrome-only adaptation is
  forbidden.

---

## 2. Design system

Source of truth: `apps/web/src/styles/theme.css` (approximately 568 lines). Theming is
applied by `[data-theme='light']` / `[data-theme='dark']` and `[data-accent='<name>']`
attribute selectors on the root element, plus `color-scheme`.

### 2.1 Base scale tokens

```css
/* Type */
--font-size-app-title: 24px;       /* application-level title 24px/600 */
--font-size-page-title: 32px;      /* current page title 32px/700 */
--font-size-section-title: 16px;   /* section title 16px/600 */
--font-size-body: 16px;            /* body & controls 16px/400 */
--font-size-secondary: 14px;       /* secondary text 14px/400 */

/* Six-step spacing scale: 4 / 8 / 12 / 16 / 24 / 32 */
--space-1: 4px;  --space-2: 8px;  --space-3: 12px;
--space-4: 16px; --space-6: 24px; --space-8: 32px;

/* Radii: panel / card / control; short tags stay pill-shaped */
--radius-panel: 18px;  --radius-card: 14px;  --radius-control: 10px;

--control-min-height: 40px;   /* buttons, inputs, selects */
--icon-button-size: 44px;     /* icon-only hit area; icon drawn at 20px */
--icon-display-size: 20px;

--transition-duration: 150ms; /* color/border/opacity transitions only */

/* One soft shadow for panels, a stronger independent one for overlays */
--shadow-panel: 0 0.5rem 1.5rem rgb(15 23 42 / 6%);
--shadow-overlay: 0 0.75rem 2rem rgb(15 23 42 / 14%);
```

Typography rules: local system font stack kept; form controls inherit the font; titles
line-height 1.2, body/secondary 1.5; controls center by padding + min-height rather than a
fixed text-container height. Internal component gaps are usually 8–16px, section gaps
24px, main panel padding 24px.

Shadows: main panels use a single low-strength soft shadow; inner form groups take **no**
shadow; overlays/menus may use the stronger independent shadow token.

### 2.2 Color variables

Semantic roles exist per theme: page background, panel/surface, muted surface, hover
surface, primary text, secondary/muted text, subtle border, strong border, accent,
accent-hover, text-on-accent, selected background (`--accent-soft`), and focus ring.
Light and dark are defined separately; every accent is checked in both. Neutral colors are
only faintly tinted; danger red and rating gold stay semantic.

Base **light** (`[data-theme='light']`):

| token | value |
| --- | --- |
| `--page-background` | `#f4f6fa` |
| `--surface` | `#ffffff` |
| `--surface-muted` | `#f7f8fb` |
| `--surface-hover` | `#eef1f6` |
| `--text-primary` | `#172033` |
| `--text-muted` | `#687288` |
| `--border-subtle` | `#d8dde8` |
| `--border-strong` | `#b6bed0` |
| `--accent` | `#5361d5` |
| `--accent-hover` | `#4552c5` |
| `--tooltip-background` | `#172033` |
| `--tooltip-foreground` | `#f4f6fa` |
| `--tag-background` | `#eef0ff` |
| `--tag-border` | `#cfd4ff` |
| `--tag-border-hover` | `#929bfa` |
| `--tag-text` | `#343e95` |
| `--tag-remove-hover` | `#daddff` |

Base **dark** (`[data-theme='dark']`):

| token | value |
| --- | --- |
| `--page-background` | `#11141b` |
| `--surface` | `#1a1f29` |
| `--surface-muted` | `#151922` |
| `--surface-hover` | `#222836` |
| `--text-primary` | `#edf1f7` |
| `--text-muted` | `#9da7b9` |
| `--border-subtle` | `#343b49` |
| `--border-strong` | `#4d566a` |
| `--accent` | `#929bfa` |
| `--accent-hover` | `#a8afff` |
| `--tooltip-background` | `#edf1f7` |
| `--tooltip-foreground` | `#11141b` |
| `--tag-background` | `#292f48` |
| `--tag-border` | `#444d78` |
| `--tag-border-hover` | `#7782d7` |
| `--tag-text` | `#e0e3ff` |
| `--tag-remove-hover` | `#3a4265` |

### 2.3 Accent presets — six palettes, pure hue rotation

`[data-theme][data-accent='<name>']` retints `--accent`, `--accent-hover`, the tag palette
and the faintly-tinted neutrals (page background, borders). **Every retint is a pure hue
rotation — saturation and lightness stay at the blue defaults, so nothing changes depth.**
`blue` is the default and needs no override. The `[data-accent]` rules are placed after
the theme blocks so they win the cascade.

| palette | accent (light) | accent-hover (light) | accent (dark) | accent-hover (dark) |
| --- | --- | --- | --- | --- |
| `blue` (default) | `#5361d5` | `#4552c5` | `#929bfa` | `#a8afff` |
| `teal` | `#0f766e` | `#0c5f59` | `#2dd4bf` | `#5eead4` |
| `violet` | `#7c3aed` | `#6d28d9` | `#a78bfa` | `#c4b5fd` |
| `rose` | `#be123c` | `#9f1239` | `#fb7185` | `#fda4af` |
| `amber` | `#b45309` | `#92400e` | `#fbbf24` | `#fcd34d` |
| `green` | `#15803d` | `#166534` | `#4ade80` | `#86efac` |

Each preset also overrides the family-tinted neutrals (`--tag-background`,
`--tag-border`, `--tag-border-hover`, `--tag-text`, `--tag-remove-hover`,
`--page-background`, `--surface`, `--surface-muted`, `--border-subtle`) to keep the same
hue, at the same depth as blue. Do not assume contrast is identical after the hue
rotation — verify each palette in both themes.

### 2.4 Icon-state and derived semantics

Defined once for both themes; accent-tinted values use `color-mix` so the six presets
retint automatically:

```css
--icon-default: var(--text-primary);
--icon-muted: var(--text-muted);
--icon-disabled-opacity: 0.42;
--icon-control-bg: transparent;
--icon-control-hover-bg: var(--surface-hover);
--icon-control-active-bg: color-mix(in srgb, var(--accent) 12%, var(--surface));
--icon-control-border: transparent;
--icon-control-active-border: var(--accent);
--icon-focus-ring: var(--accent);
--focus-ring: var(--accent);
--accent-soft: color-mix(in srgb, var(--accent) 12%, var(--surface));
```

### 2.5 Optional image-background layer (rules fixed, feature not built)

The layering is fixed as: **background image → full-page light/dark scrim → content panel
→ text and controls.** The image is blurred at the bottom layer only; individual controls
or cards must not each run a backdrop blur. Panels are opaque by default; when an image
background is enabled the initial design value is 94% panel-background opacity, raised to
fully opaque if real-background readability demands it. Opacity applies to the panel
background color only — never to the panel container's `opacity`. Background and accent
may be chosen independently; the first automatic palette match only maps onto the existing
six presets and manual override is kept. Full dynamic palette generation is deferred.
This stage adds no setting and no upload UI.

### 2.6 Contrast requirements

- Normal text: at least **4.5:1**.
- Necessary non-text visual information (control outlines, state markers): at least
  **3:1**. Purely decorative dividers need not be uniformly darkened.
- Secondary/helper text must stay clearly readable — never express "secondary" with
  overly faint text; hierarchy is carried by title, position and spacing together.
- Check light/dark × six accents; desktop widths 1024 / 1440 / 1920 CSS px; long Chinese,
  long English, and keyboard focus.

---

## 3. UX rules

The canonical UX rule list. These are decisions, not suggestions.

- Daily use first.
- Fast tagging over perfect metadata.
- Gallery before table.
- Click before dialog.
- Template before schema builder.
- Source is optional and never Entry identity.
- Complexity must be earned by real usage.
- Entry card stacks preserve each cover/preview's natural aspect ratio; page depth comes
  from perspective, side rotation, and offsets — **not** square padding or cropping.
- All work cards (Gallery, Recently viewed, View later, Collection members, tag results)
  reuse the shared `EntryCard.vue`; never re-implement card layout per page.
- Sidebar entries are **top-priority navigation**: clicking any entry must switch views
  immediately from any depth.
- A back button returns to the view the user actually came from, never to a blank or
  default page.
- Pages split per Gallery use **connected tabs** — the active tab's edge joins the content
  panel, like a real browser tab.
- Mode switches (★ / ♥ / 👍 and similar) are **toggles**: clicking the active mode again
  exits it.
- New views must not render before their data is ready; load first, switch after, so no
  intermediate page flashes.
- Usage stats (views / likes / last viewed) are **sort-only annotations**, never numeric
  filter conditions.
- Mobile is responsive Web, not a separate native product or browser-specific fork; use
  standards and feature detection rather than user-agent branches.
- Chrome is the primary real-device browser, not an implementation dependency.
- Final mobile parity includes every existing non-import function, including creation,
  editing, organization, and deletion; site-probe folder and batch import stay
  desktop-only.
- No essential action may depend only on **hover, long-press, or HTML5 drag-and-drop**.
  Long-press may be a shortcut, but a discoverable tap path is mandatory.
- Destructive mobile actions use the same two-step arm/confirm pattern as desktop.
- Mobile touch targets should normally be at least **44×44 CSS px**, and pages must not
  introduce viewport-level horizontal overflow.
- Card navigation uses **directional scroll state**: a newly opened detail/folder starts
  at the top, while Back restores the exact scroll position, pagination, active tab,
  sort/filter context, and immediate parent path. Nested Author/Directory/Entry and
  Collection/Entry paths preserve each level independently.
- The top-bar Back control invokes the same hierarchy as each page's local Back and is
  **disabled on Home**; Entry and Author details keep a fixed 44×44 lower-right control
  for scrolling to the current page top.

If a common action needs a settings dialog, redesign it.

---

## 4. Key files

Line counts are approximate and drift; use them only to size upload/review. ★ marks the
files most relevant to desktop visual work.

| File | Approx. lines | Role |
| --- | ---: | --- |
| `apps/web/src/styles/theme.css` ★ | ~568 | Global colors, spacing, radii, shadows, theme + accent variables |
| `apps/web/src/GalleryApp.vue` ★ | ~6068 | App shell, sidebar, header, Settings, Gallery & Entry detail, view ladder |
| `apps/web/src/AuthorPage.vue` ★ | ~2695 | Author list/detail, filtering, rating, Directory |
| `apps/web/src/components/EntryCard.vue` ★ | ~79 | The single work card + media stack |
| `apps/web/src/AdvancedEditingPage.vue` ★ | ~1955 | Dictionaries, author merge, uncategorized tags, templates, author aliases |
| `apps/web/src/AddEntryPage.vue` ★ | ~2206 | Manual creation, folder import, batch import |
| `apps/web/src/components/FacetFilterBar.vue` ★ | ~1097 | Facet/Author/Rating/Usage filtering and sorting |
| `apps/web/src/CollectionsPage.vue` ★ | ~1219 | Entry/Author Collections and one level of subfolders |
| `apps/web/src/RandomPage.vue` ★ | ~440 | Works / Authors / Tags random recommendation |
| `apps/web/src/ViewLaterPage.vue` ★ | ~444 | SQLite-shared Entry/Author View later; independent pagination; one-time merge of legacy localStorage |
| `apps/web/src/RecentViewPage.vue` ★ | ~365 | Recently viewed |
| `apps/web/src/SearchPage.vue` | ~714 | Global search |
| `apps/web/src/HomePage.vue` | ~440 | Home welcome page (see [§6](#6-home-page)) |
| `apps/web/src/components/TagCombobox.vue` | ~207 | Typable tag combobox |
| `apps/web/src/components/AppIcon.vue` | ~42 | The single SVG icon outlet |
| `apps/web/src/components/IconButton.vue` | ~36 | Pure icon button wrapper |
| `apps/web/src/components/icons.ts` | ~101 | Icon vocabulary (`IconName` + inline SVG markup) |
| `apps/web/src/i18n.ts` | ~2256 | en / zh-CN copy boundary (flat dictionaries) |
| `apps/web/src/stores/preferences.ts` | ~211 | Entry/Author View later sync store, plus device-local prefs (NSFW, rows, accent) |
| `apps/web/src/entry-media-stack.ts` | ~57 | Cover/preview stack geometry |
| `apps/web/src/armable.ts` | ~42 | Two-step arm/confirm destructive pattern |
| `apps/web/src/navigation-memory.ts` | ~25 | Per-view ephemeral navigation state |
| `apps/web/index.html` | ~43 | Web entry and viewport |

The earlier persistence-free sandbox (`TagSandbox.vue`, `components/tags/TagChip.vue`,
`TagBoard.vue`) is **not** a product-page visual source. Product behaviour is tested
through the `GalleryApi` boundary; real persistence is covered by server HTTP integration
tests against migrated SQLite databases.

---

## 5. Shared components & cards

### 5.1 `EntryCard.vue` — the single work card

`components/EntryCard.vue` is the **only** work card. Gallery, Recently viewed, View
later, Collection members, Random, Search and tag results must all reuse it. Visual source
of truth is the Gallery grid card (stacked covers + title + type + optional note).

Interface:

```ts
interface EntryCardEntry {
  id: number;
  title: string;
  type: string;
  coverRef: string | null;
  previewRefs: readonly string[];
}

props: {
  api: { assetUrl(path: string): string };
  entry: EntryCardEntry;
  note?: string | null;        // optional muted footnote (e.g. view count)
  pressed?: boolean;           // selection state for edit-mode cards
  mainClass?: string;          // optional legacy hook for parent styling
}
emits: { open: [] }
slot: 'corner'
```

- The card body is a `<button class="entry-card-main">` carrying
  `data-testid="shared-entry-card"`, `:data-entry-id`, and `:aria-pressed="pressed"`.
  It emits `open`; the parent owns navigation.
- The media stack uses `entryStackLayers(entry)` from `entry-media-stack.ts`, rendered
  through `LazyCardImage`, with per-layer geometry from `entryStackLayerStyle(index, n)`.
  The stack keeps each cover's natural aspect ratio; depth comes from perspective
  (`perspective: 28rem`), side rotation and offsets — no cropping to squares.
- Empty stack falls back to a single-letter placeholder using the tag palette.
- `note` renders under the type as `data-testid="shared-card-note"`.
- A `corner` slot lets a page add a corner control without changing the shared media
  layout.
- The global `.entry-card` / `.entry-meta` base in `theme.css` lets components without
  their own copy (e.g. Collection folders) inherit the same look; a page's scoped copy
  wins when present.

### 5.2 `LazyCardImage.vue` — deferred indexed media

`components/LazyCardImage.vue` is the card/pager image component. Rules:

- Real URLs are assigned **only after** `IntersectionObserver` approval (rootMargin
  `240px 0px`); observing disconnects after first intersection. Card geometry is reserved
  before load so no layout shift occurs.
- Decoding is async; `loading="eager"` (the observer does the real gating) with
  `decoding="async"`.
- Bytes are served through the offline cached-media object-URL layer where available; a
  cache miss falls back to the network address.
- `refreshToken` re-reads bytes with `cache: 'no-cache'` via an object URL (media is
  addressed by position, so the same URL may serve different bytes after an edit).
- `keepLastOnSrcChange` keeps the previous picture visible while the next loads — used by
  the paged viewer so it never collapses between pages; cards use the default (clear first).
- `alt` is applied only once loaded; until then the image is hidden via `visibility`.

### 5.3 Global shared UI (defined in `theme.css` on purpose)

- Connected-tab strip: `.recent-tab-shell` / `.recent-tabs` / `.recent-tab` /
  `.recent-tab-active` / `.recent-tab-count` / `.recent-tab-drop` / `.recent-tab-panel`.
  Shared across Recently viewed, View later, Collections, Random and the Author type
  filter — one shared look, no per-page variants. At ≤44rem the strip becomes
  horizontally scrollable and tabs become 44px tall.
- Action buttons: `.primary-button` (solid accent), `.secondary-button` (neutral surface +
  border), `.danger-button` (semantic red `#a12626`), `.add-button`, `.text-button`,
  `.back-button`; shared field control `.secondary-input` / `.field-label`; shared
  `.eyebrow` / `.muted` typography helpers.
- Add-to-collection trigger + dropdown: `.add-to-collection`, `.add-to-collection-menu`
  (floats, uses `--shadow-overlay`, `menu-in` animation, `.drop-up` when near the
  viewport bottom), `.add-to-collection-option` (`:disabled`/`.is-member` show accent).
- `.icon-button` and `.icon-tooltip` (see [§9](#9-tooltips-aria-motion-i18n)).
- `.entry-card` / `.entry-card-main` / `.entry-meta` / `.entry-usage-note` base.

Button semantics: primary actions use the solid accent background; ordinary actions use a
neutral surface + border; selected items use the light accent background plus an explicit
marker. Preserve existing action priority — do **not** turn every button into a primary
button. Hover is a slight background change, pressed deepens it, keyboard focus is a
separate 2px visible outline; selected and focused states must never be the same state.

---

## 6. Home page

Home replaces the old "default into the first Gallery / legacy empty Gallery" behaviour.
Home is **not** a statistics dashboard — it is a lightweight, welcoming entry that returns
the user to content. Implementation lives in `HomePage.vue` (rendered by the
`GalleryApp.vue` view ladder as the fallback view).

### 6.1 Goals and non-goals

Goals:

1. Opening the Web shows Home first, not the first Gallery.
2. Browser Back to the root path returns Home, not a legacy empty Gallery or the first
   Gallery.
3. Home is "welcome + recent content"; statistics are only ambient.
4. Simple data is shown by automatic rotation, not a row of KPI cards.
5. With no data, Home becomes an onboarding / empty state that leads to the first Entry.
6. No large backend change; reuse existing Gallery/Entry/last-view/history APIs.

Non-goals: no full dashboard; no trend charts, pie charts, weekly/monthly reports or
leaderboards; no unrelated new features; no UI framework or heavy animation library for
Home; the root route must not masquerade as a Gallery.

### 6.2 Structure

```text
App Shell
  Galleries                                  Search  Settings
Home Panel
  Hero
    eyebrow + greeting
    H1  "Welcome back — what will you look at today?"
    subtitle
    [Add a new entry]                 ┌───────────────┐
                                      │ one ambient    │
                                      │ fact at a time │
                                      │      ● ─ ─     │
                                      └───────────────┘
    ─────────────────────────────────────────────────
  Recently viewed   [Entry] [Entry] [Entry] [Entry]
  Recent galleries  [Gallery] [Gallery] [Gallery]
```

The core idea is "welcome page + continue entry", not a data center.

### 6.3 Hero

- Default title: **"Welcome back — what will you look at today?"**
- Default subtitle: "Continue where you left off, or add something new to your
  collection."
- Primary action: `Add a new entry` — calls the existing Entry create handler / route.
- Secondary action (optional): `View all galleries` — may be omitted if the sidebar is
  already direct enough. (The shipped Home hero shows only the primary CTA.)
- Optional local-time greeting switches only the eyebrow/helper text, not the main title:
  morning 05:00–12:00, afternoon 12:00–18:00, evening otherwise. i18n keys:
  `greeting.morning` / `greeting.afternoon` / `greeting.evening`.

### 6.4 Ambient summary (not a stat card)

Home must **not** show `248 Entries | 12 Galleries | 36 Views | 8 Added Today`. Instead the
hero's right side shows one line at a time, cycling roughly every **5.2 s** (guide says
~5–6 s):

1. `Now holding 248 entries`
2. `You have 12 galleries`
3. `Recently viewed "XXX"`

Transition: `opacity 0 → 1` and `translateY(6px) → 0`, ~300ms (guide: 280–340ms). No
marquee, no infinite horizontal ticker. Three short segment/dot indicators sit at the
bottom; each is a button that jumps to that item and restarts rotation.

Data contract:

```ts
interface HomeSummary {
  entryCount: number;
  galleryCount: number;
  recentViews: RecentEntry[];
}
```

Do not build an analytics warehouse for Home.

Rotation behaviour (ambient, not a notification — no continuous `aria-live`):

- Pause on hover over the card.
- Pause while focus is inside the rotation control.
- Pause while `document.hidden`.
- Under `prefers-reduced-motion: reduce`, **stop** automatic rotation.
- `@vueuse/core` helpers (`useIntervalFn`, `useDocumentVisibility`,
  `usePreferredReducedMotion`) may be used only if it is already installed; do not add a
  dependency just for Home.

### 6.5 Recently viewed

- Desktop shows only **3–4** Entries.
- Each card keeps only: cover, title, type / Gallery, relative time ("just now",
  "yesterday", "3 days ago"). No full tags / rating / metadata on Home.
- Reuse the existing latest-view / last-view data; if the system can already sort by
  latest view, do not build a second history store.
- Small data set: filter `lastViewedAt`, sort descending, `slice(0, 4)`. Large libraries
  must not full-load — reuse the API's sort + limit.

### 6.6 Recent galleries

- Home shows only 3 galleries: the most recently opened (if that state exists), else the
  first three in existing order (`galleryList.slice(0, 3)`).
- Do not add a pinned/favorite Gallery feature for Home.

### 6.7 Empty state

Condition:

```ts
const isEmptyHome = computed(() => !loading.value && summary.value.entryCount === 0);
```

Entry-centric, not Gallery-centric. Copy: **"Add your first entry."** / "This will grow
into your collection home — recently viewed, galleries, small touches. For now, it all
starts with one record." Primary: `Add the first entry`; secondary: `Create gallery`. If
Entry must currently belong to a Gallery, the buttons still call the existing create flow
— do not implement new creation logic in Home.

Shipped Home also has a dedicated **NSFW-filtered** empty state
(`data-testid="home-nsfw-hidden"`) for the case where the server has entries but every
Gallery is filtered out; its primary action reveals NSFW content.

### 6.8 Root route

The durable requirement, independent of routing mechanism:

```text
/                     Home
/galleries/:galleryId Gallery
/entries/:entryId     Entry detail
```

The old behaviour ` / → first Gallery ` or ` / → legacy empty Gallery ` must go. Gallery
must be entered explicitly. In this codebase there is no router path table; Home is the
GalleryApp fallback view (`isHomeView`, `showHome()`), with no first-Gallery redirect.
Note: path strings above are conceptual — always read the real routing mechanism rather
than copying example paths.

### 6.9 Browser Back / Forward acceptance

```text
Open web            → Home
Home   → Gallery A
Back                → Home
Home   → Gallery A → Entry detail
Back                → Gallery A
Back                → Home
```

Must **never** happen again: `Back → random first Gallery`, or
`Back → legacy Create Gallery empty page`.

### 6.10 Components and data adapter

- Do not over-split. First version: `pages/HomePage.vue`, plus (optionally)
  `components/HomeAmbientSummary.vue` and `components/HomeRecentEntries.vue`; the gallery
  preview may stay inline in `HomePage.vue`. (Shipped: everything is inline in
  `HomePage.vue`.)
- If `EntryCard.vue` exists, reuse its compact variant — never fork a second full EntryCard.
- `HomePage.vue` must not scatter API calls. Use a thin adapter:

  ```ts
  interface HomeData {
    entryCount: number;
    galleryCount: number;
    recentViews: EntrySummary[];
    galleryPreview: GallerySummary[];
  }
  ```

  If sources are independent, `Promise.allSettled([...])` so a failed `recentViews` does
  not blank the whole page.

### 6.11 Loading / error / responsive / motion

- No full-screen spinner. Hero title and CTA appear immediately; ambient uses a one-line
  skeleton; recent uses fixed-height skeleton cards.
- Partial request failure degrades locally ("Unable to load recently viewed right now.")
  — never replace the whole page with `Failed to load Home`.
- Responsive: desktop ≥1024 → hero copy ~65% / ambient ~35%, recent 4 cards; tablet → hero
  stacks, recent 2 columns; mobile → welcome → CTA → ambient → recent. Prefer CSS Grid /
  media queries, not JS width checks. (Shipped breakpoint: hero stacks and recent drops to
  2 columns at ≤64rem, gallery grid to 1 column.)
- Motion: only (1) ambient fade + translateY ~300ms, (2) entry hover `translateY(-2px)`
  ~150ms, (3) CTA reuses existing button hover/pressed. **No** hero parallax, continuous
  floating, infinite bounce, autoplay card carousel, background particles, or count-up
  number animation.
- Relative time prefers the project's existing date util; otherwise
  `new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })` for "just now", "12 minutes
  ago", "yesterday", "3 days ago".
- Copy principle: numbers must not become KPIs. Not `248 / ENTRIES`; but
  "Now holding **248** entries", "You have **12** galleries", `Recently viewed "XXX"` —
  data reads as part of a welcome, not a report.

### 6.12 Implementation order and tests

Order: (1) audit the routing (root route, first-gallery redirect, legacy empty Gallery,
the source of Back-to-empty-Gallery) before touching UI; (2) static HomePage (hero,
ambient/recent/gallery placeholders); (3) fix the root route and test Back/Forward first;
(4) connect data (entryCount, galleryCount, recentViews, galleryPreview); (5) add ambient
rotation (Vue `<Transition>` + 5.2s timer); (6) wire the empty Home onboarding; (7) only
after confirming no route/test depends on it, remove the legacy empty Gallery.

Test checklist:

- **Routing**: fresh load `/` → Home; Back to `/` → Home; refresh `/` → Home; Gallery URL
  refresh → same Gallery; Entry URL refresh → same Entry; no auto-open of the first Gallery.
- **Data**: 0 / 1 entry; 0 / 1 Gallery; empty recentViews; recentViews API error; large counts.
- **UI**: 1024 / 1440 / 1920; light / dark; six accents; long Chinese / long English.
- **Interaction**: ambient rotates; hover pauses; hidden tab pauses; reduced motion
  simplifies/stops rotation; recent card uses the existing route; CTA uses the existing
  create handler.

### 6.13 Final acceptance criteria

1. The first thing seen on opening the Web is Home.
2. Home does not depend on a "first Gallery" existing.
3. Back no longer drops into a legacy empty Gallery.
4. Hero is the first visual layer, not a statistic.
5. Statistics appear one at a time, lightly auto-rotated.
6. Recent View is the main "continue" entry.
7. No content → naturally becomes "add your first entry" onboarding.
8. A single Home API failure does not make the whole page unusable.
9. No heavy library is added.
10. Gallery / Entry existing business semantics are not changed.

Component relationship:

```text
App
└── view ladder (no Vue Router)
    ├── HomePage
    │   ├── (optional) HomeAmbientSummary
    │   ├── (optional) HomeRecentEntries
    │   └── gallery preview / navigation
    ├── GalleryPage
    └── EntryPage
```

The root/fallback view no longer carries any Gallery fallback.

---

## 7. Icons & icon spec

Design direction: warm neutral backgrounds, soft panels, thin borders, light shadows and a
restrained theme accent. Icons must unify the interface while staying light, everyday and
easy to understand. Keep the Vue 3 + Vite + TS + hand-written CSS architecture; add no UI
framework, icon library, font or CDN.

### 7.1 Confirmed icon functions

The following semantics were confirmed by the user and are authoritative. The brief's
original 12-icon list used these names; **the shipped vocabulary (see 7.4) resolves some
of them to different names**, noted in the last column.

| Function | Icon (brief) | Control type | Shipped name |
| --- | --- | --- | --- |
| Sort by likes | `thumb-up` | sort-state button | `thumb-up` |
| Sort by view count | `eye` | sort-state button | `view-count` (bar-chart replacement) |
| Sort by latest view | `history` | sort-state button | `history` (plain clock face) |
| Add one like on the entry detail page | `thumb-up` | repeatable action button | `thumb-up` |
| Open the Collection dropdown / add to Collection | `folder` / `folder-plus` | menu trigger | `folder` / `folder-plus` |
| Add to View later | `clock-later`, then `clock-check` on success | action button; whether it can be undone is decided by existing code | `view-later` / `view-later-check` |
| Search | `search` | input prefix or icon-only button | `search` |
| Edit current content | `edit` | icon-only button | `edit` |
| Open settings | `settings` | icon-only button | `settings` |
| Toggle theme | `moon` / `sun` | icon-only button | `moon` / `sun` |

Heart and Star are **no longer** the icons for the view-count / latest-view sorts. Unless a
real Favorite or Rating feature appears, do not draw or wire Heart and Star.

`history` has exactly one fixed use here: latest view (sort by most recent view time). It
does not auto-appear in the sidebar or other pages. Plain `clock-later` means View later
only; the two must be clearly different in shape — `clock-later` is a full single-circle
clock face, `history`'s outer contour is a return arrow.

Plus, Close, Check, Chevron, User, Shuffle and similar previously guessed icons are not on
the mandatory draw list. The implementation may keep existing simple CSS/SVG geometry, and
only add icons when a code audit confirms a real function needs one.

### 7.2 Art rules

- Soft geometric outline icons: clear, rounded, regular, mildly friendly — no emoji, no
  illustrative detail.
- Logical canvas 24×24; the main shape sits within roughly the central 20×20.
- Stroke width uniformly **2 logical px**, round caps and joins; default is outline.
  A second-shape "state variant" exists only when a state genuinely needs it (e.g.
  `clock-check`).
- Masters use opaque black artwork on a genuinely transparent background; black is only
  the delivery color — runtime coloring is via `currentColor`.
- No gradients, shadows, 3D, textures, skin tones, colored emoji, glow, decorative
  sparkles, text, numbers, or enclosing button/scene. Do not draw a checkerboard
  background and do not produce an icon sheet.
- Must remain recognizable at 20px. The image generator outputs a 1024×1024 transparent
  PNG master; the integrating agent cleans it into a concise 24×24 inline SVG.
- Draw `thumb-up` first as the reference for stroke weight, corner roundness and visual
  weight; every later icon is compared against the approved master at the same canvas
  proportion and weight.
- SVG in components uses `currentColor` only; never hardcode theme colors.

### 7.3 Per-icon shape requirements (the 12-icon draw list)

| File | Shape requirement |
| --- | --- |
| `thumb-up.png` | Upright thumb and simplified palm, short rounded wrist; no nail, palm lines or skin detail. Shared by the sort button and the like button. |
| `eye.png` | Horizontal eye outline with a central round pupil; not sharp; no lashes, brow or realistic eyeball detail. Used for view count. |
| `history.png` | A counter-clockwise return arrow around a simplified clock, face with only two short hands; arrow and face are one whole. Used for latest view. |
| `folder.png` | Single-layer folder outline, short rounded top tab; no file or text detail. |
| `folder-plus.png` | Same body as `folder`, small plus at bottom-right; plus must not occlude the folder outline. |
| `clock-later.png` | Clear round clock face with two hands; may carry a very small rightward continuation hint but no return arrow (to avoid confusion with `history`). |
| `clock-check.png` | Same body as `clock-later`, short check at bottom-right, sized like `folder-plus`'s mark. |
| `search.png` | Standard magnifier, light ring/handle proportions; rounded handle end. |
| `edit.png` | Simplified pencil at ~45°, may carry one short writing line; no paper, box or complex tip. |
| `settings.png` | Six-tooth rounded gear, single center hole; wide, few teeth so it does not blur into a circle at 20px. |
| `moon.png` | Simple crescent, smooth inner/outer arcs; no stars. |
| `sun.png` | Center circle plus eight equal short rays with rounded ends; same visual area as `moon`. |

General prompt for the image generator: one icon at a time, replacing `[ICON_SPEC]` with the
row above. The first `thumb-up` needs no reference; later icons attach the approved
`thumb-up` (or a member of the group) as reference. Prompt text (verbatim intent):

```text
Create ONE functional interface icon for T³, a calm personal collection app.
The interface uses warm off-white backgrounds, clean panels, soft corners,
subtle borders and restrained accent colors.

ICON TO DRAW: [ICON_SPEC]

Use a soft geometric outline style with precise simple geometry, rounded line
caps and joins, consistent optical weight, and very few internal details.
Design on a logical 24 × 24 grid. Keep the main shape within approximately
20 × 20 units, centered optically, with a consistent 2-unit stroke. It must
remain clear when displayed at 20 px.

Use opaque black artwork with clean antialiased edges on a genuinely transparent
background. Match the attached approved reference icon in scale, stroke weight,
corner softness and visual density.

No text, numbers, labels, emoji styling, gradients, shadows, 3D effects,
textures, decorative sparkles, surrounding button, panel or scene. Do not draw
a checkerboard background and do not create an icon sheet.

Deliver one square transparent PNG master at 1024 × 1024.
```

### 7.4 Shipped icon vocabulary

`components/icons.ts` is the single icon vocabulary; `AppIcon.vue` is the single SVG
outlet. The type is currently:

```ts
type IconName =
  | 'thumb-up' | 'view-count' | 'history'
  | 'view-later' | 'view-later-check'
  | 'shuffle' | 'reorder' | 'back' | 'arrow-up'
  | 'folder' | 'folder-plus' | 'search' | 'homepage' | 'exchange'
  | 'menu' | 'close' | 'edit' | 'settings' | 'sun' | 'moon'
  | 'expand' | 'collapse' | 'add' | 'delete';
```

Each entry is hand-traced 24×24 outline markup (2-unit stroke, round caps/joins), colored
at runtime via `currentColor`. Semantics fixed by the user (2026-09):

- `view-count` is the approved **bar-chart** replacement for the eye master.
- `view-later` keeps the counter-clockwise return arrow; `history` is the plain clock
  face — the two must stay distinguishable at 20px.
- `view-later-check` keeps the same return-arrow body with a check replacing the clock
  hands (the "added to View later" state).

Masters live in `apps/web/icon/` as PNGs (e.g. `thumb-up.png`, `view-count.png`,
`history.png`, `view-later.png`, `folder.png`, `folder-plus.png`, `search.png`,
`homepage.png`, `exchange.png`, `expand.png`, `collapse.png`, `delete.png`, plus
`*-fill.png` variants). `homepage`, `exchange`, `expand`, `collapse` and `delete` were
traced from approved masters beyond the original 12.

### 7.5 `AppIcon.vue`

The single SVG outlet. Interface:

```ts
export type IconName = /* see 7.4 */;

props: { name: IconName; size?: 16 | 20 | 24 }  // default 20
```

It always outputs `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`,
`stroke-width="2"`, round caps/joins, `aria-hidden="true"` and `focusable="false"`, and
renders the markup via `v-html`. The accessible name belongs to the parent button — never
add a `<title>` to the SVG.

### 7.6 `IconButton.vue`

Lightweight wrapper for icon-only buttons:

```ts
props: { icon: IconName; label: string; active?: boolean; disabled?: boolean; size?: 16 | 20 | 24 }
```

Root is a native `<button type="button" class="icon-button">` with
`:class="icon-button--${icon}"`, `:data-active`, `:disabled`, `:aria-label="label"`, an
`AppIcon`, and `.icon-tooltip` whose copy **is the same `label`**. Undeclared attributes
(`data-testid`, `aria-pressed`, `aria-expanded`, `aria-controls`, listeners) fall through
to the root button, so pages keep their existing wiring.

---

## 8. Sort / mode controls

### 8.1 Functional model

The three sort icons are one sort-selection group:

- `thumb-up` = sort by like count
- `view-count` (brief: `eye`) = sort by view count
- `history` = sort by latest view

Usually only one is active at a time. If the existing code allows "none selected", keep the
none state. Clicking another button changes the sort mode and refreshes the list. Whether
clicking the **already-active** button reverses direction or restores the default follows
existing logic — this spec adds no new direction behaviour.

All three buttons must share **exactly** the same container size, state colors and switch
animation. Active is expressed mainly through the button background, border and icon color,
**not** by making some icon filled. That way Eye/History need no forced filled version and
Thumb-up does not look heavier than the other two.

The shipped implementation uses class `recent-mode-button` with `recent-mode-active`
(toggle: clicking the active button again clears it, e.g. `mode = mode === 'mostViewed' ?
null : 'mostViewed'`) in `RecentViewPage.vue`, `ViewLaterPage.vue` and `AuthorPage.vue`,
with a `shuffle` icon for Random mode.

### 8.2 State and color table

| State | Icon color | Background | Border | Motion |
| --- | --- | --- | --- | --- |
| Default | `--icon-muted` | transparent or panel background | `--border` | none |
| Hover | `--accent` | `--surface-hover` | `--border-strong` | icon scales 1 → 1.04 in 120ms |
| Pressed | `--accent` | `--accent-soft` | `--accent` | icon compresses to 0.94, restores on release |
| Active | `--accent` | `--accent-soft` | `--accent` | one 160ms pop on entry, then static |
| Focus-visible | keep state color | keep current background | keep current border | plus 2px `--focus-ring`, offset 2px |
| Disabled/loading | `--icon-muted` | keep current background | `--border` | opacity 0.42, no animation |

Active also shows a 3px dot at the bottom-center of the button, colored `--accent`. Dot +
container background together express the state, so it is not color-only. Switching sort
must not move the three buttons and must not animate the result cards broadly; the existing
loading state continues to signal data refresh.

The built CSS defines `@keyframes sort-icon-selected` (0.94 → 1.06 → 1, 160ms) and applies
it to `.recent-mode-button.recent-mode-active .app-icon`; `IconButton` uses
`@keyframes icon-state-pop` (0.9 → 1.08 → 1, 180ms) on `[aria-pressed='true']`.

### 8.3 Suggested wiring (structure)

State names and handlers must map onto existing code; this only fixes the shape:

```ts
type SortMode = 'likes' | 'views' | 'latestView';

const sortOptions = [
  { value: 'likes',      icon: 'thumb-up', labelKey: 'sort.likes' },
  { value: 'views',      icon: 'eye',      labelKey: 'sort.views' },
  { value: 'latestView', icon: 'history',  labelKey: 'sort.latestView' },
] as const;
```

```vue
<div class="sort-icon-group" role="group" :aria-label="t('sort.groupLabel')">
  <button
    v-for="option in sortOptions"
    :key="option.value"
    class="sort-icon-button"
    type="button"
    :aria-pressed="sortMode === option.value"
    :aria-label="t(option.labelKey)"
    @click="setSortMode(option.value)"
  >
    <AppIcon :name="option.icon" :size="20" />
    <span class="sort-active-dot" aria-hidden="true" />
    <span class="icon-tooltip" aria-hidden="true">{{ t(option.labelKey) }}</span>
  </button>
</div>
```

If the buttons still carry visible text, keep it and drop the tooltip; if they become
icon-only, keep both `aria-label` and tooltip. Tooltip shows after ~400ms hover; keyboard
focus shows it immediately.

### 8.4 Switching animation

```css
@keyframes sort-icon-selected {
  0% { transform: scale(0.94); }
  65% { transform: scale(1.06); }
  100% { transform: scale(1); }
}

.sort-icon-button[aria-pressed='true'] .app-icon {
  animation: sort-icon-selected 160ms ease-out;
}
```

If Vue re-triggers the animation because the button keeps `aria-pressed="true"`, add a
temporary `.just-selected` class only when the sort mode actually changes — never a
continuous looping animation.

### 8.5 Entry-detail Like button (distinct from sort)

The like button shares the `thumb-up` graphic but its interaction is completely different:

- The sort button selects a sorting mode — a persistent active state.
- The entry-detail Like is a **repeatable action**: each click adds one like; it is not an
  on/off toggle, so it must **not** set `aria-pressed` and must never stay selected after
  the first click.
- Keep the `Like` copy and current like total if present. As an icon-only button use a
  localized `aria-label` ("Like this entry" / "点赞此作品") plus tooltip.
- Every click replays a short feedback, including rapid repeated clicks; after the
  animation the button returns to normal.
- How the like total updates, optimistic updates, and failure handling all follow existing
  business code. The visual animation must not pretend the server accepted the like.

Recommended motion: pointer-down shrinks the icon to 0.90 in 70ms; on click the icon rises
2px and scales to 1.10 in 180ms then returns; the icon briefly turns `--accent` (~260ms)
then reverts; a nearby like number plays a slight 160ms scale-up, optionally with a `+1`
that rises 6px and fades over 360ms. `+1` is purely visual and must not enter the
assistive-tech announcement queue. To replay on every click, use an incrementing key or
re-add the animation class (shipped: `.like-icon-feedback` with `@keyframes
like-icon-feedback` + `like-color-flash`, 260ms). Do not swallow rapid clicks waiting for a
previous animation.

### 8.6 Collection button & dropdown

`folder` is the Collection base graphic; `folder-plus` is the "add to Collection" menu
trigger on the entry detail page.

- Trigger carries `aria-haspopup="menu"`, `:aria-expanded="collectionMenuOpen"` and
  `aria-controls`.
- Closed: normal foreground; hover: accent; menu open: accent icon, `--accent-soft`
  background, accent border.
- After opening, the trigger still shows `folder-plus`. An entry can join multiple
  Collections, so the trigger itself uses no `aria-pressed` and never becomes a permanent
  filled folder.
- How the list marks items already containing the entry follows existing checkbox /
  selected / disabled logic; no new Check icon is required.
- Icon click feedback: 100ms `scale(0.94)` then restore.
- Dropdown appears below / lower-right of the button; `transform-origin` points at the
  trigger. Enter: 150ms `opacity 0 → 1` and `translateY(-4px) → 0`; exit: ~100ms reverse.
- Animation must not change the menu's final size or push page content; keep it floating.
  Click-outside, Escape, and close-on-select keep their existing behaviour.

### 8.7 View later Clock

On the entry detail page the Clock means "add this entry to View later". It is **not**
latest view; latest view is always `history`.

Prefer reading an existing `isInViewLater` or equivalent state:

- If add/remove is supported: not-in shows `view-later`; in shows `view-later-check`,
  accent color, light accent background and `aria-pressed`; clicking again runs the
  existing remove logic.
- If only "add" exists: no `aria-pressed`; on success temporarily switch to
  `view-later-check` for ~700ms, then whatever the existing data state dictates. Do not add
  remove functionality yourself.
- During a request keep the existing loading/disabled logic; the icon may lower opacity
  but must not spin forever.
- Success feedback is one 180ms pop; failure restores `view-later` and uses the existing
  error message.

Clock vs History: `view-later` is a full single-circle clock face; `history`'s outer
contour is the return arrow. Distinguishable at 20px without a tooltip.

### 8.8 Search, Edit, Settings, theme toggle

Icon-only versions lower first-glance recognition, so all get a tooltip, an `aria-label`
and a 44×44 click area.

- **Search** — input-embedded `search` is decorative (`aria-hidden="true"`); default
  `--icon-muted`, becomes `--accent` on `:focus-within`. A separate submit button may also
  use `search` but its parent button needs "Search" ARIA + tooltip. Focus changes color
  only; the magnifier must not shift, to avoid input jitter.
- **Edit** — default `--icon-default`; hover turns accent and the pencil rotates ~5°
  counter-clockwise in 130ms, restoring on leave. Click immediately restores the angle,
  then runs the existing edit handler / route; it has no pressed/selected state.
- **Settings** — hover rotates the gear ~20° clockwise in 160ms, restoring on leave, never
  spinning continuously. If it opens a modal, use `aria-haspopup="dialog"` +
  `aria-expanded` and keep the button accent while open; if it is a route page, treat it
  as an ordinary navigation link.
- **Sun / Moon** — the icon shows the theme the click will enter: light theme shows Moon
  with ARIA "Switch to dark theme"; dark theme shows Sun with ARIA "Switch to light
  theme". Both occupy the same 20×20 area. Switching: 180ms fade-out + slight shrink +
  rotate, then fade-in the new icon; the button container does not rotate or resize. Theme
  color switching itself uses existing logic; the animation must not delay the actual theme
  update nor cause a white flash.

---

## 9. Tooltips, ARIA, motion, i18n

### 9.1 Icon-button + tooltip rules

`components/AppIcon.vue` is the only SVG outlet; a lightweight `IconButton.vue` wraps
icon-only buttons. Tooltip copy is the same `label` used for `aria-label`.

Tooltip: fixed small panel — 12px font, `6px 8px` padding, 6px radius, single line;
positioned below the button by default, flipping to lower-left near the viewport's right
edge. It must not capture mouse events, must not take part in layout, and must not replace
`aria-label`. Mouse hover shows it after ~400ms; keyboard `focus-visible` shows it
immediately; it closes on leave/blur. On `@media (hover: none)` the tooltip is hidden
(`display: none`).

Shipped CSS: `.icon-tooltip` uses `--tooltip-background` / `--tooltip-foreground`, opacity
transition `120ms ease 400ms`, and `transition-delay: 0ms` on `:focus-visible`.

### 9.2 General icon-button CSS (state model)

```css
.icon-button {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  padding: 0;
  color: var(--icon-default);
  background: var(--icon-control-bg);
  border: 1px solid var(--icon-control-border);
  border-radius: 10px;
  cursor: pointer;
  transition: color 150ms ease, background-color 150ms ease, border-color 150ms ease;
}
.icon-button:hover:not(:disabled) { color: var(--accent); background: var(--icon-control-hover-bg); }
.icon-button[data-active='true'],
.icon-button[aria-pressed='true'],
.icon-button[aria-expanded='true'] {
  color: var(--accent);
  background: var(--icon-control-active-bg);
  border-color: var(--icon-control-active-border);
}
.icon-button:focus-visible { outline: 2px solid var(--icon-focus-ring); outline-offset: 2px; }
.icon-button:disabled { opacity: var(--icon-disabled-opacity); cursor: not-allowed; }
```

`data-active` is used **only** for a container that has no suitable native ARIA state but
must stay visually active. Sorting prefers `aria-pressed`; menus prefer `aria-expanded`.
Never add incorrect ARIA to an ordinary action button just to reuse this CSS.

### 9.3 Motion table

| Function | Trigger | Animation | Duration | Enduring state? |
| --- | --- | --- | --- | --- |
| Sort | switch to new sort mode | icon 0.94 → 1.06 → 1, color/background transition | 160ms | yes, until sort mode changes |
| Entry Like | every click | compress, rise 2px, scale, settle; optional `+1` fade | 180–360ms | no, returns to normal |
| Collection | open menu | button brief compress; menu fade-in + 4px rise | 100–150ms | only while the menu is open |
| View later | add success | Clock slight pop, optionally swap to Clock-check | 180ms | decided by existing membership state |
| Search | input focus | icon color transition | 150ms | while focused |
| Edit | hover | pencil rotate ~−5° | 130ms | no |
| Settings | hover | gear rotate ~20° | 160ms | no; while a modal is open, color only |
| Theme | switch | Sun/Moon fade-out + shrink + rotate, cross-fade in | 180ms | new icon persists |

All motion affects only `transform`, `opacity`, color and border, and must not cause
layout reflow. Add:

```css
@media (prefers-reduced-motion: reduce) {
  .app-icon, .icon-button, .icon-tooltip, .collection-menu,
  .like-icon-feedback {
    animation: none !important;
    transition: none !important;
    transform: none !important;
  }
}
```

(The shipped reduced-motion block covers `.app-icon`, `.icon-button`, `.icon-tooltip`,
`.like-icon-feedback`, `.recent-mode-button`, `.theme-icon-swap`, `.add-to-collection-menu`
and `.entry-card`.)

### 9.4 ARIA + i18n keys

Reuse existing keys; when adding, add en and zh-CN together. The brief's naming contract
(flat keys, `a11y.*` for accessible names):

| key | en | zhCN |
| --- | --- | --- |
| `sort.groupLabel` | Sort entries | 作品排序 |
| `sort.likes` | Sort by likes | 按点赞数排序 |
| `sort.views` | Sort by view count | 按浏览次数排序 |
| `sort.latestView` | Sort by latest view | 按最近查看排序 |
| `a11y.likeEntry` | Like this entry | 点赞此作品 |
| `a11y.addToCollection` | Add to collection | 加入合集 |
| `a11y.addViewLater` | Add to view later | 加入稍后查看 |
| `a11y.removeViewLater` | Remove from view later | 移出稍后查看 |
| `a11y.search` | Search | 搜索 |
| `a11y.edit` | Edit | 编辑 |
| `a11y.openSettings` | Open settings | 打开设置 |
| `a11y.switchToDark` | Switch to dark theme | 切换至深色主题 |
| `a11y.switchToLight` | Switch to light theme | 切换至浅色主题 |

Rules: an icon inside a button that also has visible text is decorative. An icon-only
button must have both a localized `aria-label` and a visible tooltip. Tooltips must not be
hardcoded English.

Shipped keys to be aware of (flat dictionaries in `src/i18n.ts`):

- Sort/group: `sort.groupLabel`, `sort.random`, `sort.likes/views/latestView` (contract),
  and the current mode labels `recent.lastViewed` / `recent.mostViewed` / `recent.mostLiked`.
- Tabs: `tabs.reorder`, `tabs.done`, `tabs.ordering`, `tabs.moveEarlier`, `tabs.moveLater`.
- A11y present: `a11y.likeEntry`, `a11y.addToCollection`, `a11y.draggableTags`.
- Theme: `theme.switch` ("Switch to {theme} theme"), `theme.dark`, `theme.light`.
- Home: `home.nav`, `home.eyebrow`, `greeting.morning/afternoon/evening`, `home.title`,
  `home.subtitle`, `home.cta.newEntry`, `home.ambient.*`, `home.recent.*`, `home.galleries.*`,
  `home.empty.*`, `home.filtered.*`, `home.time.justNow`.

i18n mechanics: the default locale (with no stored value) is `zh-CN`; the choice is
persisted under `localStorage` key `t3.locale`; `apps/web/tests/i18n.test.ts` enforces that
`messages.en` and `messages['zh-CN']` expose the identical key set.

### 9.5 Implementation order for icon work

1. Find the real components/state/handlers for the three Sort buttons, detail Like,
   Collection, View later, Search, Edit, Settings, Theme; record the mapping — never infer
   function from the current emoji name.
2. Create `AppIcon.vue` and the first batch of `IconName`s; clean the SVG paths from the
   image masters into a few clean paths — do not auto-trace into many fragment paths.
3. Create or consolidate `IconButton.vue`, the tooltip, and the shared theme variables.
4. Wire the three Sort buttons first and verify sorting is unchanged; then the detail
   actions; finally replace Search, Edit, Settings and the theme toggle.
5. Add localized ARIA copy and tooltips; preserve original `data-testid`, events and routes.
6. Run the full front-end tests and build; check light/dark × six accents, plus keyboard,
   200% zoom and `prefers-reduced-motion`.

Acceptance focuses on: the three Sort states are clear and not distinguished by icon
fill; the detail Thumb-up gives short feedback on every click without becoming permanently
selected or swallowing rapid clicks; the Collection button is active only while its menu is
open and Clock vs History do not blur at 20px; Heart and Star are removed from those two
wrong semantics and unconfirmed icons are not force-wired; every icon-only button has an
accurate tooltip and ARIA; all colors follow theme variables and all motion is fully off
under the reduced-motion preference.

---

## 10. External-AI plan format & division of labour

Plans handed to an executing agent must be mechanically applicable item by item:

```markdown
## Phase N: <phase name>

### Edit 1 — apps/web/src/...
- Locate: existing selector / fragment
- Change to: full replacement block
- Reason: one sentence stating the goal
- Responsive widths: affected breakpoints
- Behaviour protected: testids / events / Back semantics that must survive
```

Requirements:

- Every edit is self-contained: give the anchor fragment and the complete replacement
  block. No "make it more modern overall" descriptions.
- No whole-file rewrites; the variable layer is the exception, but existing variables and
  all six accents must be preserved.
- New variables and i18n keys must list their full definitions.
- Reference to a file not uploaded must be flagged `[needs upload]`.
- A mobile plan must state, item by item, the touch path and the mouse/keyboard equivalent
  path — CSS alone is not enough.
- End with the affected pages, the desktop regression surface, and the acceptance
  viewports.

Suggested division of labour: a desktop visual project proceeds variables baseline →
core components → page tweaks. A mobile project is split independently into:

1. LAN run shape.
2. Responsive shell and main browsing path.
3. Search / Recent / View later / Random / Collections.
4. General touch selection / move modes.
5. Full create, edit, organise and delete.
6. Advanced editing.
7. Image performance and real-device regression.

Mobile must not be mixed into a single desktop beautification task, and the executing
agent must never be asked to decide product scope on the fly during implementation.

---

## 11. Audit dispositions

Source: the whole-library deep audit (`.zcode/workflow-drafts/深审存量.json`). This is a
**decision document** — grouped and prioritised by user impact / data safety / change
risk, independent of the original severity. "Deferred" is not a claim that no defect
exists. ID format: `C<n>` = confirmed-list index, `P<n>` = pending-list index (array order,
from 01). Of the 79 `confirmed` entries, 1 is marked `reproduced=false`; the 25 `pending`
entries are treated here as "candidates needing disposition". Original evidence lives in
the JSON's `finding` / `confirmation`; line numbers are audit-time positions and must be
checked against the current working tree before use. Any fix must be scoped on its own and
regression-tested; the report must never be used as a one-shot refactor spec.

### A. Handle first — blocks main use, writes wrong data, or trusts bad input

| ID | Problem / entry point | Disposition |
| --- | --- | --- |
| C24 | `usageSort` + Author `ratingSort` combined caused a SQL bind-parameter error and list failure | **Fixed**: bind the rating params only when rating sort is actually in effect. HTTP integration RED(500) → GREEN(200); 5 in-file and full-gate tests pass. |
| P03 | Non-ASCII tag ordering differed between SQL and JS, causing a permanent offline `entry.tags.set` conflict | **Fixed**: current tags now use the same ordering as the passed baseline. RED conflict → GREEN applied. |
| P11 | LAN HTTP is a non-secure context, so `crypto.subtle` is unavailable and offline snapshot download/update failed | **Fixed**: when `subtle` is missing, use a local SHA-256 check (integrity is not skipped); tampered snapshots are still rejected. |
| C55 + C56 | Generic SiteProbe review threw a `TypeError` on write; once fixed, selection could still lose its listing context | **Fixed**: the write no longer passes the bad argument; review metadata keeps the full ref/listing. Selection-download regression passes; 30 Python tests pass. |
| C33 | Source maintenance stamped an Entry-level catalog ID onto candidates, risking a wrong source being approved | **Fixed**: per-candidate identity is preserved and the origin ID is kept as evidence only; regression confirms it is never auto-selected. |
| C08 | `db:restore`'s default path depended on the start directory and could restore to the wrong DB | **Fixed**: backup/restore default to the server package's `.data/library.db`; explicit paths stay relative to the call directory. Path test passes; the real library was not touched. |
| C19 | When the thumbnail failed during cover replacement, the old cover had already been overwritten | **Fixed**: render the new thumbnail successfully before replacing; an isolated render-failure test confirms the old cover/DB reference survives. |
| C75 | Creating an Entry succeeded but upload failed, and retry created a duplicate | **Fixed**: keep the created ID and the remaining media, offer a media-only retry button. RED/GREEN regression; Gallery 163 tests pass. |
| C13 + C39 | A child-process stdin error / an escaped Source-maintenance job exception could exit the server | **Fixed**: C13 swallows EPIPE on an already-closed login gate; C39 catches job exceptions, pauses the run and records the error. Both RED/GREEN. |
| C32 | Template export used an unconstrained `entryType` and could write outside the template directory | **Fixed**: write and list paths reject path separators / illegal filename characters. Real SQL/file test RED then GREEN. |
| C61 + P06 | SiteProbe review / Builder pages embedded site content directly in `<script>`, so `</script>` could break the page or inject script | **Fixed**: review, annotation page and card-picker encode `<` before embedding JSON in script. Three real-payload regressions RED then GREEN; SiteProbe suite 343/343. P06 was a pending candidate, reproduced in-page here. |
| P09 | Builder sweep cleanup could delete concurrently-created session directories it did not own | **Fixed conservatively**: no session is auto-deleted by time difference anymore. Concurrent-session-retention RED/GREEN and SiteProbe 344/344. Cost: sweep-generated sessions need manual cleanup until a trustworthy ownership marker exists. |

### B. Handle alongside the related feature — no standalone large refactor

- **Sync / offline**: C02 (legacy View later ID migration); C65 (cached `capabilities`
  faked online — **fixed**: the SW does not intercept `capabilities`, RED/GREEN); C66
  (epoch-switch race); P12/P13/P15 (offline author visibility and filter semantics); P16
  (cross-tab snapshot race — raise priority before shipping a multi-device / multi-tab
  offline flow). P14 (search-semantics drift) — first decide whether the product requires
  equivalence, then decide whether to fix.
- **Import / media**: C17 (skipped entries cannot receive media); C18 (artist cursor
  misalignment); C20/C21 (concurrent preview, batch externalKey linkage); C57 (shrinking
  selection accumulated the manifest — **fixed**: selection reuses the original
  `_accumulate`, RED/GREEN); P23 (auto-resume after review). Cover these together in the
  next import-flow acceptance round.
- **Source maintenance**: C34 (**fixed**: after awaiting backup, re-verify run / decision /
  Entry snapshot and URL ownership inside the write transaction; concurrent
  commit/cancel/change-decision regressions pass); C35 (**fixed**: the production adapter
  and catalog rate-limit signals enter the pause branch; HTTP 429/503/509 and soft-ban 403
  fixture regressions pass); C36 (form keyword placeholder); C37 (O(n²)); C38 (**fixed**:
  review treats the same URL held by both the target and another Entry as a conflict, in
  line with commit; RED/GREEN). Re-evaluate the rest before the feature sees regular
  high-frequency use.
- **UI error feedback / recovery**: C63 (a non-JSON error response dropped its status code
  — **fixed**: error responses keep `ApiError.status`, RED/GREEN client tests); C69
  (**fixed**: clear the old list and filter options before switching Gallery and show the
  error on failure; RED/GREEN, Gallery 164 pass); C76 (**fixed**: all Author-works load
  entry points catch request failure, drop mismatched old cards and show the error;
  RED/GREEN, Author 24 pass); P22 (restored page number resets); P24 (Home shows an empty
  library on load failure). Do targeted fixes only when touching the corresponding page /
  error handling.
- **Dictionaries / tags**: C25/C26 (orphan tags left after rename) — handle only once they
  are proven to affect candidate display; P05 (Builder limit inconsistent with annotation)
  — raise earlier if an adapter is being generated.

### C. Deferred / accepted current limits — escalate only with real triggering evidence

No "clear the report" patching. Includes documentation and copy drift (C01/C05-C07),
low-frequency error codes / duplicate routes / log-file collision (C03/C04/C14/C15),
uncommon CLI and extreme inputs (C09-C11, C22-C23, C27-C29, C40-C43, C48-C54, C58-C60,
C62, C64, C67-C68, C70-C74, C77-C79, P01-P02, P04, P07-P08, P10, P17-P21, P25). C16
(unbounded backup accumulation): observe disk usage first, do **not** auto-delete backups.
P14 (search policy) and P24 (Home error display) are already listed under B; escalate on
real problems.

C30's review result is `reproduced=false` and is not listed as a defect to fix. Candidates
not explicitly named in A/B remain in the original JSON — that is not an exclusion. If one
reproduces in real use, involves production data, or touches a security boundary, re-raise
it. When fixing any item, read its evidence/confirmation from the original report, add a
failing regression, then make the minimal change.
