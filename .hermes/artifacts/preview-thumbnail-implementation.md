# UUID upload thumbnail implementation — PASS

## Scope and fix
Only `apps/server/src/import/media.ts` and new independent `apps/server/tests/integration/entry-upload-thumbnail.integration.test.ts` changed. Original readers already allowed UUID-qualified names, but the derivative reader rejected the same generated basename. Shared noncapturing managed-stem syntax now joins both regexes: cover / preview / preview-N, optional lowercase hex UUID in the existing 8-4-4-4-12 shape; originals retain their five-extension allowlist and extension capture index 1; derivatives retain exactly 16 lowercase hex digest characters and WebP. No arbitrary filenames, separators, traversal or expanded directory contract. All bytes below the MIME-map declaration match the start backup exactly.

## Real RED → GREEN evidence
- New permanent regression ran before production patch: **1 failed, 2 passed**, exit **1**; exact derivative HTTP GET expected **200**, received **404** at test line 56. Source GET bytes/MIME and production generation/resolution had already succeeded. See `red.log`.
- After patch: **3/3 new tests passed** (initial combined run **5/5** including existing-entry-media).
- Final nearest integrations: **7/7 across 3 files**: new regression 3, existing-entry-media 2, entry-media-order 2 (the four nearest existing cases). See `affected-integration.log`.
- Server no-emit typecheck **exit 0**; affected ESLint **exit 0**. No root build, APK or full-root suite.
- Parent's unchanged `.hermes/tmp/preview-parent-thumbnail-probe.mts` rerun **exit 0**; `originalServed`, `snapshotThumbnailResolved`, `generatedThumbnailServed` all true. Its hardcoded RED-output filename was copied before rerun, GREEN captured separately, then original RED bytes restored.

Tests use a fully migrated in-memory DB, independently generated real PNGs, temporary assets, production ensure/resolve/read helpers, production HTTP app and real random-port TCP listener with finally cleanup. UUID cover/preview/preview-2 and legacy equivalents are served and checked byte-for-byte; thumbnail output is compared to actual Sharp rendering plus decoded WebP size, MIME and immutable cache headers. Malformed UUID/digests/arbitrary filenames are physically present yet return null/HTTP 404. Encoded path traversal and separator escapes are denied even with valid bytes outside the selected directory. No direct filesystem derivative read substitutes for the HTTP GET.

## Commands executed
```sh
export PATH=/c/Users/hzy/AppData/Local/hermes/node:$PATH
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts apps/server/tests/integration/entry-upload-thumbnail.integration.test.ts
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts apps/server/tests/integration/entry-upload-thumbnail.integration.test.ts apps/server/tests/integration/existing-entry-media.integration.test.ts apps/server/tests/integration/entry-media-order.integration.test.ts
npm exec --yes --package=pnpm@10.15.0 -- pnpm --filter @t3/server typecheck
node node_modules/eslint/bin/eslint.js apps/server/src/import/media.ts apps/server/tests/integration/entry-upload-thumbnail.integration.test.ts
# Parent probe executed with the same Node 22 binary:
node apps/server/node_modules/tsx/dist/cli.mjs .hermes/tmp/preview-parent-thumbnail-probe.mts
```

## Backups and verifiable artifact manifest
All paths relative to `D:/Project/TagTraceTrove`.
Start full read_bytes backup: `.hermes/tmp/preview-thumbnail-safe/start/media.ts`, **12845 bytes**, SHA-256 `40986bc12b86b75a8505a6ce8985a114cfef3018dd116a1de9da1598cbb9b0a8`.
Full GREEN source and test bytes and hashes: `.hermes/tmp/preview-thumbnail-safe/green/manifest.json`.
Logs, original parent RED, parent GREEN and exact implementation diff: `.hermes/tmp/preview-thumbnail-safe/`.

- `apps/server/src/import/media.ts`: 13131 bytes, SHA-256 `c21ba0f95ad299038513d40474bda9eee3a120b219bb502a37a2b5ec56e79267`; full-byte copy `.hermes/tmp/preview-thumbnail-safe/green/apps/server/src/import/media.ts`.
- `apps/server/tests/integration/entry-upload-thumbnail.integration.test.ts`: 6973 bytes, SHA-256 `07274fe6443e59c5176f45ae11fa297fa15a38b92c3f35f373d96308af36782a`; full-byte copy `.hermes/tmp/preview-thumbnail-safe/green/apps/server/tests/integration/entry-upload-thumbnail.integration.test.ts`.

## Issues and boundary
The write/patch tools' automatic one-file TypeScript checker reported MSYS `/d/...` path-not-found (TS6053); the actual workspace server typecheck and ESLint both passed. Patch tool also emitted a sibling-write warning, but the full on-disk baseline was read and its supplied SHA verified before the exact-anchor patch; only the intended regex block differs.
No web/native/shared/http app/other production/public handoff/CURRENT modifications. No formal DB/assets/default server, deploy/restart/doctor/probe command, build/APK, git checkout/reset/stash/commit. Parent handles docs/final gates. Bounded named gates PASS: stop here.
