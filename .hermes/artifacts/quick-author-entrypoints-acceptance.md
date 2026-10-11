# Quick import duration / Author-list rating filter — bounded follow-up

Status: INVESTIGATED; sole production/test writer deleg_1a921ba7 implementing actual-entrypoint verification. No new gates, APK or device PASS yet. v42 remains the previously frozen delivered artifact. Parent owns read-only/docs/final gates/identity/package only.

## Latest source semantics confirmed

- Quick import here means AddEntryPage manual composer, not generic remote/batch Import or Source. New duration is a text field parsed to integer seconds, local error blocks submission, blank omits the optional payload key. GalleryApp already supplies it to all three create paths. Current facts row = Pages / Date / Duration; View later separate, labels no longer say optional, flex-end alignment is intentional. Existing stub-based component coverage and old backend duration tests are not complete new-caller proof.
- Author LIST ratings are exclusively author_self, not Entry effective/inherited ratings or producer works summary. All eligible Authors' anchor Gallery dimensions are offered even before scores exist. Default added condition is gt 3, null row sends no condition/sort; first selected dimension sets descending primary order, chosen existing list sort breaks ties, including seeded random. Unrated removes star selector; duplicate names include Gallery; navigation memory preserves rows. Current stored anchor takes priority over derived works Gallery for list/option partition.
- Source gap observed: offline listAuthorFilterOptions still requires a non-null rating value; it hides fresh dimensions and the + Rating affordance. Offline list query still filters Gallery by linked works and does not explicitly reject non-self dimensions; compare with current SQL before fixes.

## Finite acceptance

1. Actual Quick import UI → production facade → cold store → typed application HTTP → isolated migrated SQL: invalid no queue, parsed value/0/blank, pending reads and cold reopen, retry original body, final snapshot/ACK; preserve presets and optional old envelopes.
2. Actual AuthorPage + Rating → production facade: fresh unrated dimension visible; default gt 3, unrated, duplicate names, first-row primary sort, remove/reset and navigation persistence.
3. Offline versus application HTTP/SQL query parity for relevant slots/options/conditions: anchor differing from works, class/unknown-slot refusal, zero/half/null, AND, secondary/seeded sort, totals/pages, Gallery and visibility filters.
4. Pending overlay dimensions/values/anchor changes immediately update available filters and results; cold persistence is durable adapter proof, not phone process survival.
5. Render actual production Vue components at 360/430/768 CSS viewports in an isolated fixture with injected test API/storage, no official endpoint/assets. Controls reachable, no accidental document/control overflow, facts row acceptable, rating dropdown/row usable. jsdom is not layout proof; actual browser is not Android/WebView evidence.
6. Focused/static gates plus whole-byte checkpoint. Parent bounded review, full default/integration/native/build and increasing same-signer APK only after sole writer stops.

## Protected boundary

No reads/touch/migration of official database/assets; no default probe/doctor/server/service/deploy/restart. No migrations, reset/stash/HEAD replacement or commit. Full-byte backups, unique targeted patches, expected hashes and original line endings. No uninstall/Clear, default whole-media download or re-running historical phone register. Existing v41/v42 physical device checks remain independently deferred. All fixtures disposable and cleanup-owned; credentials never printed.
