# T³ documentation index

The documentation is organized into a small set of **board documents**, each owning one area, plus the manual plan.
Everything a receiver needs lives in these files.

| Document | Board |
| --- | --- |
| [`status.md`](status.md) | Current implementation boundary, delivered surfaces, remaining work. **Read this first.** |
| [`architecture.md`](architecture.md) | Product/data model: Entry/Producer, Section→Facet layouts, Content, Ratings, Collections, Gallery/Author projections, search, partitions, navigation shell, i18n. |
| [`database.md`](database.md) | SQLite boundary, the full migration inventory, test strategy, backup/restore, data-safety invariants. |
| [`http-api.md`](http-api.md) | HTTP routes + the shared Zod contract boundary (families, query encoding, errors). |
| [`import-and-source.md`](import-and-source.md) | Transactional import commit, crawler cursors, the derived Source library, Source maintenance, relation suggestions, taxonomy aliases. |
| [`offline-sync.md`](offline-sync.md) | Offline library: snapshot/epoch, capability-gated mutations, outbox, media, replay/conflict/idempotency, System page, change-feed status. |
| [`mobile.md`](mobile.md) | The Android/WebView mobile workstream: product boundary, shell, responsive/touch, native transport, pairing/TLS, device acceptance, packaging. |
| [`ui-design.md`](ui-design.md) | Frontend board: design system, UX rules, shared cards, Home page, icons, sort controls, ARIA/motion/i18n, audit dispositions. |
| [`siteprobe.md`](siteprobe.md) | The bundled SiteProbe crawler/builder: adapter contract, Builder pipeline, learned-rule semantics, generic limits, T³ integration. |
| [`development.md`](development.md) | Runtime stack, commands, running modes, the tray launcher and packaging, Node pitfalls, verification discipline, repo layout. |
| [`roadmap.md`](roadmap.md) | **Forward-looking work only** — the manual plan. |

Other artifacts in this folder:

- [`siteprobe/siteprobe-execution-log.md`](siteprobe/siteprobe-execution-log.md) — the SiteProbe running execution log
  (kept in place by explicit instruction; corrections are appended, never overwritten).
- [`adr/README.md`](adr/README.md) — Architecture Decision Records placeholder.

Retired status logs and design/plan documents are archived byte-identically under
`.hermes/archive/docs-pre-consolidation/`.

## User-facing manual

An HTML **operation manual** (feature-by-feature how-to) ships with the web app and is served at
`/manual/zh.html` and `/manual/en.html` — i.e. `http://127.0.0.1:8765/manual/zh.html` and
`.../manual/en.html`, reachable from the desktop browser and the phone app's WebView/browser.
Source: [`apps/web/public/manual/`](../apps/web/public/manual/).
