# 18comic / Hanime Traditional-to-Simplified Taxonomy Implementation Plan

> **状态：已完成（2026-09-11）。** Task 1–4 由上一轮完成，Task 5（真实数据 inventory 回填）
> 与文档由下一轮补完并验证；两站测试 29 / 18 通过，导出 metadata 指纹前后一致。
> 当前进度与交接说明见 [`../HANDOFF.md`](../HANDOFF.md)。
> 下方内容保留为原始实施计划。

> **For Hermes:** Execute this plan task-by-task with strict RED → GREEN tests. Do not commit, stage, rewrite history, launch a browser, or fetch live website data. Existing exports are private user data and must remain outside version control.

**Goal:** Give `18comic_vip` the same reviewable taxonomy workflow used by Hitomi, automatically produce Simplified Chinese taxonomy targets from Traditional Chinese source metadata without an LLM, and apply the same deterministic conversion to Hanime while preserving original extracted evidence.

**Architecture:** Keep every site's extractor independent. Each of `18comic_vip` and `hanime1_me` gets its own tiny OpenCC `t2s` wrapper and declares the pure-Python `opencc-python-reimplemented` dependency. Source metadata and taxonomy keys remain the exact site text; only taxonomy canonical values and prefilled `zh_cn` review values are converted to Simplified Chinese. Tag keep/reject policy remains distinct from translation: automatic conversion must not silently decide whether a tag is semantically useful.

**Tech Stack:** Python 3.11, `uv`, `pytest`, `opencc-python-reimplemented`, JSON/CSV, existing per-site offline-first export layouts.

---

## 1. Current Context and Constraints

### Existing Hitomi behavior to mirror

- `hitomi_la/src/tag_policy.py` maintains:
  - `exports/tag_review.csv` with columns `tag,decision,zh_cn`;
  - `taxonomy_dictionary.json.tags.accepted` and `.rejected`;
  - atomic JSON/CSV replacement;
  - accumulation of newly discovered tags without discarding unresolved rows.
- `hitomi_la/src/export_selected.py::build_taxonomy_dictionary()` maintains the full dictionary sections:
  - `series`, `authors`, `characters`, `types`, `tags`.
- Hitomi preserves source spellings as dictionary keys and stores canonical Chinese names as values.
- Hitomi excludes rejected tags and includes only accepted tags in final import metadata. Its manual translation requirement is not copied: 18comic/Hanime `zh_cn` defaults are generated deterministically.

### Existing 18comic behavior

- Parser: `18comic_vip/src/parse_album.py`.
- Stable raw tag evidence already exists as `source_tags_raw`.
- Import persistence: `src/import_core.py`, called by `src/import_album.py` and `src/import_favorite.py`.
- Export forms:
  - `exports/single/<id>/metadata.json`;
  - `exports/favorites_*/items/<id>/metadata.json` plus aggregate `metadata.json`.
- Current real exports contain hundreds of values across 作品、登场人物、分类标签、作者 and no taxonomy file.

### Existing Hanime behavior

- Extractor: `hanime1_me/src/extractor.py`.
- `src/tag_policy.py` already supplies tag review and an offline apply command, but its taxonomy contains only `tags`.
- Existing accepted mappings may contain carefully chosen manual canonical names; non-empty manual values must never be overwritten by OpenCC.
- Existing `source_tags_raw`, raw HTML, titles, authors, and category values are evidence and must remain unchanged.

### Explicit boundaries

- No LLM and no translation API.
- No network access is required after dependencies are installed.
- Do not convert source keys or raw metadata in place. Example: key `漢化` stays `漢化`; taxonomy target becomes `汉化`.
- OpenCC performs script conversion, not semantic translation. It must not transform English/Japanese meaning or invent canonical franchise names.
- User-entered non-empty taxonomy/review values take precedence over generated values.
- Existing accepted/rejected decisions must be preserved.
- Do not automatically delete or overwrite exports while merely generating inventory.
- Do not touch `TagTraceTrove/apps/server/.data/library.db`.

## 2. Output Contract

Both site roots use:

```text
exports/
├─ taxonomy_dictionary.json
└─ tag_review.csv
```

Full taxonomy schema:

```json
{
  "series": {"來源字樣": "简体规范字样"},
  "authors": {"來源字樣": "简体规范字样"},
  "characters": {"來源字樣": "简体规范字样"},
  "types": {"來源字樣": "简体规范字样"},
  "tags": {
    "accepted": {"來源 Tag": "简体 Tag"},
    "rejected": ["被排除的來源 Tag"]
  }
}
```

Rules:

1. Source strings are trimmed, whitespace-normalized, deduplicated case-insensitively, and preserved as keys.
2. New non-tag canonical values default to `OpenCC('t2s').convert(source)`.
3. Existing non-empty canonical values are retained exactly.
4. New unresolved tags enter `tag_review.csv` with blank `decision` and OpenCC-prefilled `zh_cn`.
5. Accepting a tag with blank `zh_cn` falls back to OpenCC output; an explicitly edited `zh_cn` wins.
6. Rejecting a tag removes it from accepted and preserves it in rejected.
7. Unresolved tags remain in raw evidence but are not silently treated as accepted when the explicit policy is applied.
8. JSON and CSV writes use temporary files followed by replacement.

## 3. Implementation Tasks

### Task 1: Add deterministic conversion wrappers and dependencies

**Objective:** Provide one offline Traditional→Simplified primitive per independent site.

**Files:**
- Modify: `D:/Project/Dataextracted/site_probe/18comic_vip/pyproject.toml`
- Modify: `D:/Project/Dataextracted/site_probe/18comic_vip/uv.lock`
- Create: `D:/Project/Dataextracted/site_probe/18comic_vip/src/text_normalization.py`
- Modify: `D:/Project/Dataextracted/site_probe/hanime1_me/pyproject.toml`
- Modify: `D:/Project/Dataextracted/site_probe/hanime1_me/uv.lock`
- Create: `D:/Project/Dataextracted/site_probe/hanime1_me/src/text_normalization.py`
- Tests: per-site taxonomy test files described below.

**Steps:**
1. Add failing tests for representative conversion:
   - `漢化 → 汉化`
   - `無碼 → 无码`
   - `絕區零 → 绝区零`
   - ASCII/Japanese values remain unchanged.
2. Run each test and confirm failure because the module/dependency does not exist.
3. Add `opencc-python-reimplemented` through each site's `uv` project so both `pyproject.toml` and `uv.lock` are synchronized.
4. Implement a module-level `OpenCC('t2s')` instance and `to_simplified(value: object) -> str`.
5. Run the focused tests and confirm pass.

### Task 2: Build the 18comic full taxonomy and review engine

**Objective:** Add a Hitomi-compatible full taxonomy inventory and explicit tag-review workflow without mutating source evidence.

**Files:**
- Create: `D:/Project/Dataextracted/site_probe/18comic_vip/src/taxonomy.py`
- Create: `D:/Project/Dataextracted/site_probe/18comic_vip/tests/test_taxonomy.py`

**Required API:**

```python
load_tag_policy(exports_root: Path) -> dict
refresh_taxonomy(exports_root: Path, records: list[dict]) -> dict
apply_policy_to_record(record: dict, policy: dict) -> dict
apply_review_to_exports(exports_root: Path) -> dict
```

**Steps:**
1. RED: test first inventory from records containing Traditional 作品、登场人物、分类标签、作者.
2. Assert full section keys and source→Simplified mappings.
3. Assert pending `tag_review.csv` rows are deterministic/alphabetical and have `zh_cn` prefilled.
4. GREEN: implement normalization, loading, sorting, atomic writes, full-section accumulation, and pending review generation.
5. RED: test accept/reject decisions, including:
   - accepted blank `zh_cn` gets OpenCC fallback;
   - custom non-empty `zh_cn` is preserved;
   - rejected tags are removed from accepted;
   - prior manual mappings survive refresh.
6. GREEN: implement decision application and policy output.
7. RED: test `apply_policy_to_record()`:
   - preserves source category keys and `source_tags_raw` spellings;
   - excludes rejected tags from `source_tags_raw`;
   - writes only accepted source tags to `分类信息.分类标签`;
   - leaves 作品、登场人物、作者、作品类型 unchanged.
8. GREEN: implement the minimal record rewrite.
9. RED: build temporary `single/*` and `favorites_*/items/*` exports; verify offline apply updates item metadata and favorite aggregate consistently without network access.
10. GREEN: implement deterministic export discovery, rewrite item records atomically, rebuild aggregate `items`, and return counts.

### Task 3: Integrate 18comic taxonomy refresh into extraction

**Objective:** Ensure every completed extraction updates the shared taxonomy inventory and uses the reviewed tag policy.

**Files:**
- Modify: `D:/Project/Dataextracted/site_probe/18comic_vip/src/import_album.py`
- Modify: `D:/Project/Dataextracted/site_probe/18comic_vip/src/import_favorite.py`
- Modify if a common hook is cleaner: `D:/Project/Dataextracted/site_probe/18comic_vip/src/import_core.py`
- Modify: `D:/Project/Dataextracted/site_probe/18comic_vip/tests/test_import_v2.py`
- Create: `D:/Project/Dataextracted/site_probe/18comic_vip/应用Tag审核.bat`

**Steps:**
1. RED: verify a built album record updates taxonomy and applies an existing accepted/rejected policy before persistence.
2. GREEN: use the common taxonomy root `ROOT / 'exports'` in both single and favorite flows.
3. Preserve interruption safety: each completed favorite item must remain persisted before moving to the next item; taxonomy refresh must not require re-fetching completed HTML/media.
4. Add the offline BAT wrapper equivalent to Hanime/Hitomi, invoking `uv run python -m src.taxonomy`.
5. Test that CLI exposes `--output-root` and performs no network operation.

### Task 4: Extend Hanime taxonomy to full sections and automatic Simplified targets

**Objective:** Preserve Hanime's current review/apply workflow while removing manual Traditional→Simplified transcription.

**Files:**
- Modify: `D:/Project/Dataextracted/site_probe/hanime1_me/src/tag_policy.py`
- Modify: `D:/Project/Dataextracted/site_probe/hanime1_me/tests/test_tag_policy.py`
- Modify if needed: `D:/Project/Dataextracted/site_probe/hanime1_me/tests/test_extractor.py`

**Steps:**
1. RED: change expected first-refresh output from tags-only taxonomy to all five sections and assert automatic mappings for Traditional series/characters/authors.
2. RED: assert pending tag rows receive generated `zh_cn`.
3. RED: assert accepted mappings with empty values are filled using OpenCC while existing non-empty manual mappings remain unchanged.
4. GREEN: generalize taxonomy writing while preserving unknown top-level keys for forward compatibility.
5. RED: verify offline `apply_review_to_exports()` rebuilds full taxonomy and rewrites playlist item/summary/CSV tags consistently.
6. GREEN: update the existing offline pass with no network behavior.
7. Keep metadata category source spellings unchanged; only taxonomy canonical values change.

### Task 5: Backfill real exports safely

**Objective:** Produce useful current taxonomy artifacts without risking the user's raw exports.

**Steps:**
1. Run an inventory-only refresh over existing 18comic and Hanime metadata to accumulate full taxonomy and review rows.
2. Before any metadata rewrite, report pending tag counts and confirm that the pass is inventory-only.
3. Do not auto-apply unresolved 18comic tag decisions to existing metadata in the same pass.
4. For Hanime, preserve all existing accepted/rejected decisions and manual non-empty canonical mappings; fill only missing canonical values and newly discovered inventory values.
5. Validate JSON shape, no duplicate casefolded source keys, no empty canonical value for automatically generated non-tag mappings, and representative conversions.
6. Do not open the generated CSV/JSON automatically.

## 4. Test and Verification Commands

Run from each site directory:

```bash
uv sync --extra dev
uv run pytest -q
```

Focused RED/GREEN examples:

```bash
# 18comic
uv run pytest tests/test_taxonomy.py -q
uv run pytest tests/test_import_v2.py tests/test_parse_album.py -q

# Hanime
uv run pytest tests/test_tag_policy.py tests/test_extractor.py -q
```

Static checks after implementation:

```bash
uv run python -m src.taxonomy --help        # 18comic
uv run python -m src.tag_policy --help      # Hanime
```

Programmatic real-export verification must assert:

- both taxonomy files parse as UTF-8 JSON;
- top-level keys are exactly/preservingly compatible with `series/authors/characters/types/tags`;
- tag policy has `accepted` object and `rejected` array;
- every generated canonical Traditional-Chinese target equals the OpenCC conversion unless a previous manual non-empty mapping overrides it;
- raw `metadata.json` source values remain unchanged during inventory-only backfill;
- no network calls and no browser launches occurred.

T3 compatibility verification:

```bash
npm exec --yes --package=pnpm@10.15.0 -- pnpm vitest run apps/web/tests/taxonomy-dictionary.test.ts
```

Run from `D:/Project/TagTraceTrove`, followed by workspace typecheck and `git diff --check` after roadmap/task-1 documentation changes.

## 5. Data, Compatibility, and Migration Impact

- No T3 database migration.
- No extractor export schema version bump: source records keep their current fields.
- Taxonomy top-level schema becomes consistent across Hitomi, 18comic, and Hanime.
- Existing tags-only Hanime taxonomy is upgraded in place while preserving decisions and custom mappings.
- Existing raw HTML/media are never touched.
- Existing metadata rewrite is explicit via the apply-review command; taxonomy inventory generation alone is non-destructive.
- `uv.lock` changes are expected in both site subprojects.

## 6. Risks and Mitigations

1. **OpenCC is orthographic, not semantic.**
   - Mitigation: preserve manual non-empty values and source keys; do not use it for English meaning.
2. **Region-specific wording may not match the user's preferred canonical name.**
   - Mitigation: generated values are editable; manual values always win.
3. **Automatic conversion could accidentally mutate evidence.**
   - Mitigation: conversion is restricted to taxonomy/review targets; tests compare raw metadata before/after inventory refresh.
4. **Applying an empty policy could erase visible tags from existing exports.**
   - Mitigation: real-data backfill is inventory-only; metadata rewrite happens only through the explicit apply command after decisions exist.
5. **Favorite aggregate and item metadata can drift.**
   - Mitigation: offline apply rewrites item files first, then reconstructs aggregate `items` deterministically; tests cover both.
6. **Existing Hanime manual mappings could be overwritten.**
   - Mitigation: non-empty existing/manual target wins over OpenCC; tests include `SPY×FAMILY`-style custom mapping.
7. **Cross-site abstraction could couple independent tools.**
   - Mitigation: duplicate only the tiny wrapper and dependency declaration per site; do not introduce a shared runtime package.

## 7. Rollback

- Code rollback: remove new modules/dependencies and restore touched per-site files; no database state is involved.
- Artifact rollback: taxonomy/review writes are atomic. Existing private exports should be backed up or hash-snapshotted before explicit apply; inventory-only generation can be removed by deleting the two generated root artifacts.
- If an apply pass fails, stop before fetching anything; restore affected metadata from the pre-apply snapshot and retain raw HTML/media.

## 8. Handoff Acceptance Criteria

- [ ] 18comic has full taxonomy + review generation integrated with single and favorite extraction.
- [ ] Both 18comic and Hanime use deterministic OpenCC `t2s`, with no LLM/API.
- [ ] Source keys/raw extraction remain unchanged.
- [ ] New pending tags have prefilled Simplified `zh_cn` but no implicit semantic decision.
- [ ] Existing manual translations and accepted/rejected decisions survive.
- [ ] 18comic offline apply handles single and favorite item/aggregate layouts.
- [ ] Hanime taxonomy contains full sections, not only tags.
- [ ] Both per-site test suites pass.
- [ ] T3 taxonomy parser compatibility test passes.
- [ ] Real export inventory pass succeeds without network/browser use or metadata rewrite.
- [ ] No files are committed or staged by Hermes.
