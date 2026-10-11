# Offline adaptation backlog after user exclusions

## Current user-defined scope

- Advanced functions page operations are not required to work offline.
- Siteprobe-related Import operations are not required to work offline. This includes the current Files/folder/metadata JSON/batch flows, which use imports/site-probe/preview or preview-path and server commit. Selecting local files does not make that pipeline independent of siteprobe.
- Ordinary Quick manual Entry creation remains in offline scope.
- Interpret the exclusion by actual UI entry point, not by shared API name: ordinary Entry/Gallery controls remain in scope even if similar template/layout operations exist inside Advanced functions.
- This is a summary, not implementation authorization. Existing supported local operations do not become newly implemented or forcibly disabled by this document.

## Functional adaptation still needed outside those exclusions

| Ordinary entry point | Remaining adaptation |
|---|---|
| Entry detail | Delete Entry |
| Authors main/add/detail pages | Standalone Author creation and Author deletion; distinct from supported create-by-name-and-link-to-Entry |
| Collections | Delete Collection and bulk common-tag application; ordinary create/rename/NSFW/order/member edits already have local paths |
| Gallery / ordinary manual creation | New Gallery/type and changing a Gallery's SFW/NSFW partition; local show/hide-NSFW preference is already supported |
| Entry ratings | Delete Entry rating dimension; Author counterpart already has an offline override |
| Entry author controls | Multi-author conversion |
| Author works | Merge works, including source selection/preparation before final confirm; Advanced producer merge is excluded |
| Entry tag/Section/Facet controls | Entry tag rename; Section create/rename/delete; Facet delete/reorder. Tag assignment/move/removal and eligible Facet creation already have local paths |
| Ordinary Entry/Gallery template/layout controls | Save/apply Gallery template and apply common tag layout; Advanced Templates tab itself is excluded |
| Entry media | Replace an occupied cover/existing media replacement; empty-cover assignment and preview append/delete/order have existing support |
| Quick manual Entry create | Create and immediately enter editing/template editing currently fails closed offline; ordinary create is already local conditional on saved Gallery/snapshot/capabilities |

## Cross-cutting work, not new feature groups

- Strict known-offline reads: missing local row or local read error must not trigger implicit online fallback (offline-api.ts:1560-1610).
- Ordinary Content editor option loading currently requests listContentKinds before falling back to built-ins (GalleryApp.vue:2332-2344).
- Media reorder reads previous media metadata before the offline branch, and a missing local Entry can invoke online.getEntry (offline-api.ts:1349-1359,4424-4426).
- Cache misses need a local uncached/unavailable state, not source-URL fallback presented as a server error (LazyCardImage.vue:50-76).
- Missing capability/snapshot/stable identity remains a local fail-closed condition, but availability labels/reasons should be visible before attempting the action; preserve cached bytes and unsynced work.

## Still connected, not an offline adaptation backlog

Pairing/revocation, explicit reconnect/sync, refreshing metadata, and downloading absent media cannot actually complete without connectivity. Unsupported/connected actions still need local availability messaging; intentional reconnect probes must not be blanket-disabled. Advanced-functions exclusions remove their adaptation requirement, not the requirement to prevent misleading server-error feedback.

## Evidence boundary

Based on the read-only current-tree audit in offline-parity-audit.md, both reader handoffs and parent caller verification. Files import route verified in apps/web/src/api/gallery.ts:799-839. Quick create-and-edit restriction verified in GalleryApp.vue:3064-3066 and AddEntryPage.vue:1291-1298. No production/test/migration/APK changes or formal data/service access for this summary. This is not a physical-device acceptance report.
