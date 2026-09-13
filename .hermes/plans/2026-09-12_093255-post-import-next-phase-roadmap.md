# Post-Import Next-Phase Product Roadmap

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** After the current large-scale import is complete and normal operation is confirmed, turn T³ from a capable collection browser into a practical large-library maintenance and discovery tool without adding infrastructure before measured need.

**Architecture:** Keep the existing local-first Vue 3 + TypeScript + Hono + SQLite architecture. Build the next phase in independent vertical slices: first establish a trustworthy post-import baseline, then add read-only library diagnostics, safe bulk actions, reusable saved views, and deterministic related-work discovery. Source repair and scale infrastructure remain trigger-based rather than automatic roadmap work.

**Tech Stack:** Vue 3, TypeScript, Hono, Zod shared contracts, SQLite via `better-sqlite3`, Vitest, existing `GalleryApp.vue` navigation model and shared `EntryCard.vue`.

---

## 1. Current baseline and planning assumptions

The following are treated as completed and must not be rebuilt:

- Desktop/mobile/LAN baseline, bounded server-side pagination, thumbnails, backup/restore, database doctor.
- Gallery, Author, Search, Tag results, Recent, View later, Random, Collections and Home.
- Transactional import with Source URL idempotency, stable `externalKey` media matching and explicit author review.
- Entry/Author ratings, author aliases/merge, Entry merge, title shortening, multi-author conversion.
- 18comic/Hanime taxonomy generation and deterministic OpenCC `t2s` normalization.
- Workless Authors hidden from discoverable lists while Producer rows remain reusable.
- Entry deletion returning through the same source-aware Back path.

The current import is still running. No new feature work should touch the formal database, change import mappings, or start a migration until import completion and the post-import acceptance gate below.

## 2. Product principles for the next phase

1. Large-library maintenance comes before decorative expansion.
2. Read-only diagnosis precedes bulk mutation.
3. Every batch mutation needs preview, explicit confirmation, one transaction, and a pre-write backup where recovery is not trivial.
4. Reuse existing query contracts and `EntryCard.vue`; do not create parallel list or card systems.
5. Preserve numeric Entry/Producer IDs as identity. Titles and source spellings remain mutable metadata.
6. Keep SQLite and local assets until measured latency or storage thresholds justify more infrastructure.
7. Do not add embeddings, a vector database, cloud sync, external search, or an ORM in this phase.
8. Do not commit or stage on the user's behalf; baseline/feature commits happen only when explicitly requested.

---

## 3. Recommended release order

### Release A — Post-import acceptance and baseline

**Priority:** Mandatory gate before all feature upgrades.

**Objective:** Prove that the imported library is complete, recoverable, internally consistent, and responsive under realistic usage.

#### A1. Freeze a recoverable snapshot

- Finish the import and ensure no importer is still writing.
- Record the final importer summary: attempted, created, skipped-existing, failed and warning counts by source.
- Run `pnpm db:backup` against the formal library.
- Restore that backup into a disposable path and run doctor there; do not test restore by replacing the formal library.
- Keep the pre-upgrade backup until at least one full normal-use cycle has completed.

#### A2. Verify database and media integrity

Run from the repository root using the project-local Node selected by the launcher:

```text
pnpm db:doctor
pnpm media:thumbnails
```

Capture a compact baseline report containing:

- Entry count by Gallery.
- Visible Author count and hidden workless Producer count.
- Entry–Author link count.
- Entries missing Source URL, cover, accepted tags, or Author.
- Collection and View later membership counts.
- Source count by normalized source key.
- Asset directory size and thumbnail coverage.

Do not treat missing optional metadata as corruption. The report distinguishes integrity failures from cleanup opportunities.

#### A3. Measure representative performance

Measure warm and cold latency for:

- Opening Home and one large Gallery.
- Gallery page/filter/sort query.
- Global title search and Tag search.
- Opening a high-work-count Author.
- Opening a large Collection.
- Backup duration and database size.

Store results in `docs/operations/post-import-baseline.md`. These measurements, not the raw Entry count alone, decide whether FTS5 or asset redesign is needed.

**Acceptance gate:**

- Formal import is no longer writing.
- Doctor passes.
- A disposable restore of the final backup passes doctor.
- Thumbnail backfill finishes or has a resumable, documented remainder.
- No unexplained importer failures remain.
- Main read paths work without a reproducible user-visible stall.

**Likely files if a reusable report command is needed:**

- Create: `apps/server/src/database/library-report.ts`
- Create: `apps/server/tests/integration/library-report.integration.test.ts`
- Modify: root `package.json`
- Create: `docs/operations/post-import-baseline.md`

The first run may remain operational/manual. Only add a command if the report is expected to be reused.

---

### Release B — Library Health workbench

**Priority:** First functional upgrade.

**Objective:** Give a large imported library one safe place to find and resolve data-quality gaps.

#### B1. Read-only health summary

Add a `Library health` tab under Advanced editing with bounded counts and paged result groups for:

- Missing Source URL.
- Missing Author.
- Missing cover/preview.
- No accepted Entry Tags.
- Author duplicate candidates from existing exact/separator/dictionary rules.
- Titles eligible for the existing title-shortening planner.
- Workless Producers, shown as retained hidden records rather than errors.
- Source keys/domains and their work counts.

Reuse existing repositories and planners where possible. Do not duplicate merge/title/source logic inside the UI.

**Likely files:**

- Create: `apps/server/src/repositories/library-health-repository.ts`
- Create: `apps/server/tests/integration/library-health.integration.test.ts`
- Modify: `apps/server/src/http/app.ts`
- Modify: `packages/shared/src/schemas/api.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/tests/api-contract.test.ts`
- Modify: `apps/web/src/api/gallery.ts`
- Modify: `apps/web/src/AdvancedEditingPage.vue`
- Modify: `apps/web/src/i18n.ts`
- Modify: `apps/web/tests/gallery-api.test.ts`
- Modify: `apps/web/tests/gallery-app.test.ts`

#### B2. Drill-down without mutation

Each health metric opens a normal paged card/list result. Entry results use `EntryCard.vue`; Author results reuse Author summary cards. Result pages preserve Back, pagination, filters and scroll state.

#### B3. Connect existing safe repair flows

From a diagnostic result, link to existing actions rather than creating new mass-edit behavior:

- Duplicate Author candidate → existing merge preview.
- Long bilingual title → existing title-shortening preview.
- Missing Author/Tags/Source → open the Entry in edit mode, then return to the same diagnostic page.

No “Fix all” button in the first release.

**Tests and validation:**

1. Add repository integration tests for every count and page.
2. Verify SFW/NSFW visibility follows the existing caller context where applicable.
3. Verify opening/editing/returning preserves the health result page.
4. Run full unit, integration, typecheck, lint, build, doctor and `git diff --check`.
5. Browser-QA against a disposable copy of the post-import database.

**Release criterion:** The user can identify the dominant cleanup categories and repair individual cases without SQL or external scripts.

---

### Release C — Safe multi-select and bulk organization

**Priority:** Second functional upgrade, after the health workbench identifies repetitive work.

**Objective:** Reduce repetitive organization for hundreds of imported Entries without enabling high-risk bulk deletion or merge.

#### C1. Shared selection mode

Add an explicit selection mode to Entry-card surfaces:

- Gallery.
- Search Entry results.
- Tag results.
- Author works/Directory contents.
- Collection members.
- Library Health Entry results.

Selection is keyed by numeric Entry ID and scoped to the current surface/query. Normal card navigation remains unchanged outside selection mode. Desktop and mobile both receive discoverable tap/click controls; selection must not rely on hover, long-press or drag.

#### C2. First safe actions

Ship only these actions initially:

1. Add selected Entries to a Collection.
2. Add/remove selected Entries from View later.
3. Add one selected Tag assignment to all selected Entries, after validating the target Gallery/Facet.

Do not include bulk delete, bulk merge, silent type changes or blanket metadata replacement.

#### C3. Transaction boundary

- Validate the complete ID set and target before writing.
- Use one transaction per submitted action.
- Return affected/skipped counts.
- Idempotent membership actions report already-present items as skipped, not errors.
- Tag assignment must reject mixed Galleries unless each Entry resolves to a valid compatible Facet.

**Likely files:**

- Create: `apps/server/src/repositories/bulk-entry-repository.ts`
- Create: `apps/server/tests/integration/bulk-entry.integration.test.ts`
- Modify: `apps/server/src/http/app.ts`
- Modify: `packages/shared/src/schemas/api.ts`
- Modify: `apps/web/src/components/EntryCard.vue`
- Create: `apps/web/src/components/BulkEntryToolbar.vue`
- Modify: the existing page components only to provide selection context and callbacks.
- Add focused component/API/navigation tests.

**Release criterion:** A repeated 20–100 item organization task can be completed from the UI with previewable scope and no destructive action.

---

### Release D — Saved Views (dynamic smart folders)

**Priority:** Third functional upgrade.

**Objective:** Let frequently reused large-library queries become named navigation destinations without copying static Collection membership.

#### D1. Persist validated query definitions

Save only the existing bounded Entry query shape:

- Entry type/Gallery.
- Facet Tag conditions.
- Author IDs.
- Rating sort/filter mode.
- Usage sort.
- Entry sort.
- SFW/NSFW behavior explicitly recorded or inherited by a documented rule.

Never persist arbitrary SQL or raw client expressions.

#### D2. New model

Prefer a dedicated `saved_entry_views` table rather than overloading static Collections. Suggested fields:

- `id`, `title`, `description`, `sort_order`.
- Versioned validated JSON query payload.
- Created/updated timestamps only if they are actually shown or used.

This is the first likely new migration after 013. Follow migration → probe → repository integration → doctor → API → UI.

#### D3. UI

- `Save current view` from Gallery/filter results.
- `Saved Views` sidebar group.
- Rename/reorder/delete in explicit edit mode.
- Opening a Saved View uses the existing Gallery/query/card/pagination stack.
- Static Collections remain manual membership; Saved Views remain dynamic. The UI must not blur the distinction.

**Likely files:**

- Create: `apps/server/src/database/migrations/014_saved_entry_views.sql`
- Create: `apps/server/src/repositories/saved-view-repository.ts`
- Create matching migration/repository/HTTP/shared/web tests.
- Create: `apps/web/src/SavedViewsPage.vue` only if the existing Gallery shell cannot cleanly host it.
- Modify: `GalleryApp.vue`, `api/gallery.ts`, `i18n.ts`, relevant docs.

**Release criterion:** A named view always reflects current library membership and reproduces the saved filter/sort state after restart.

---

### Release E — Deterministic related-work discovery

**Priority:** Fourth functional upgrade; only after imported metadata density is measured.

**Objective:** Make the larger library easier to explore from an Entry without external AI or opaque embeddings.

#### E1. Eligibility gate

Proceed only if the baseline shows enough structure—for example, most Entries have an Author or several accepted Tags. If metadata is too sparse, prioritize cleanup instead.

#### E2. Explainable ranking

For an open Entry, rank same-visible-boundary candidates using deterministic weighted overlap:

- Same Author: strongest signal.
- Shared character/series Tags: strong signal.
- Other shared Tags: moderate signal.
- Same Gallery/type: eligibility/context, not sufficient alone.
- Optional rating proximity: weak tie-breaker.

Exclude the current Entry, hidden NSFW partitions and deleted/stale IDs. Return a bounded page with short explanations such as `Same Author` or `3 shared Tags`.

#### E3. UI

Add a compact `Related works` section near the bottom of Entry detail using `EntryCard.vue`. It must not delay the main detail response; load separately and tolerate an empty result.

**Likely files:**

- Create: `apps/server/src/repositories/related-entry-repository.ts`
- Create: `apps/server/tests/integration/related-entry.integration.test.ts`
- Modify HTTP/shared/web API contracts.
- Modify `GalleryApp.vue` or extract the Entry detail related section if needed.

**Release criterion:** Recommendations are fast, deterministic, explainable and visibly better than random on a representative sample.

---

## 4. Conditional tracks — do not schedule until triggered

### Track F — Source maintenance

Trigger when real source URLs begin failing or a known site changes domain.

Then implement:

1. Read-only source inventory by stable source key/hostname.
2. Rate-limited availability scan with explicit start/stop and per-domain controls.
3. Preview-only domain/path replacement plan.
4. Backup plus one-transaction Content rewrite with before/after report.
5. No automatic disabling or rewriting from a failed transient request.

This activates the existing deferred `失效 Source 批量维护` roadmap item.

### Track G — Search scaling

Trigger only when measured representative p95 search latency becomes user-visible (for example, consistently above roughly 150–250 ms) at the real library size.

Then evaluate SQLite FTS5 for title and normalized Tag/Author text. Keep structured Facet/Author/Rating filters as SQL joins; do not replace them with FTS. Do not introduce Elasticsearch or another service.

### Track H — Asset scaling

Trigger near the existing 10–20 GB media threshold or when backup/thumbnail duration becomes operationally painful.

Evaluate in order:

1. Content-hash duplicate report.
2. Safe deduplicated derived thumbnails.
3. Incremental asset backup manifest.
4. Precomputed ETags/streaming only if profiling shows benefit.

Never deduplicate originals without a restore-tested migration plan.

### Track I — Portable export/share

Keep deferred until there is a real destination or exchange workflow. When activated, export Entry/Author/Collection subsets into a versioned archive compatible with the canonical import model, including a manifest and copied assets. Do not design generic cloud sync speculatively.

---

## 5. Suggested sequencing and decision gates

| Order | Deliverable | Why now | Gate to continue |
|---|---|---|---|
| 0 | Post-import backup, doctor, baseline | Protect the newly built library | Restore-tested snapshot and no unexplained import failures |
| 1 | Library Health (read-only first) | Large imports create cleanup work | User can identify and inspect real gaps |
| 2 | Safe bulk organization | Health/normal use reveals repetitive actions | At least one repeated multi-item workflow is confirmed |
| 3 | Saved Views | Repeated queries become common at scale | User has recurring filter combinations worth naming |
| 4 | Related works | Dense metadata can support discovery | Representative results are useful and explainable |
| Conditional | Source repair / FTS5 / asset redesign / export | Expensive or risky without evidence | Their explicit operational threshold is met |

Recommended next implementation target after import acceptance: **Release B, Library Health workbench**. It produces the most information for deciding whether bulk tools, saved views, source maintenance, or performance work should come next, while its first slice is read-only and low-risk.

---

## 6. Quality and rollout contract for every release

1. Use RED → GREEN → REFACTOR for each repository/API/UI behavior.
2. Destructive QA uses a disposable database copied or seeded for that test; never the formal library.
3. Run focused tests first, then:

```text
pnpm test
pnpm test:integration
pnpm typecheck
pnpm lint
pnpm build
pnpm db:doctor

git diff --check
```

4. Validate browser navigation, loading, empty/error states, desktop, phone width, light/dark and at least the default plus one alternate accent.
5. Confirm the formal listening PID and health endpoint before deployment; do not restart T³ during an active import.
6. Update `docs/current-architecture.md`, API/database docs and `docs/roadmap.md` only after the corresponding behavior is implemented and verified.
7. Stop each release after its acceptance criteria pass. Do not silently expand into the next release.

## 7. Risks and trade-offs

- A health dashboard can become an unbounded “fix everything” project. Keep its first release read-only and reuse existing planners.
- Bulk actions increase blast radius. Start with additive/idempotent actions and exclude bulk deletion/merge.
- Saved Views add schema and navigation complexity. Keep their payload versioned and restricted to the existing query contract.
- Related-work ranking is only as good as metadata density. Do not compensate for sparse data with embeddings before cleanup is attempted.
- FTS5 and media deduplication are attractive premature optimizations. Require measured thresholds.
- The current large uncommitted worktree should be treated as one completed baseline under user control before overlapping feature edits begin; no agent should stage, commit, reset or rewrite it without explicit authorization.
