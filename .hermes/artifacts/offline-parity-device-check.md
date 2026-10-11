# Ordinary offline adaptation — consolidated device evidence

This register belongs to the new filtered sequential extension, not historical v40–v44 acceptance. No per-feature user test is a progression gate. Implementations and automated evidence are tracked separately in offline-parity-implementation-board.md; no device PASS is inferred from SQL/IDB/browser/JVM tests.

| Group | Scope | Implementation | Device evidence |
|---|---|---|---|
| D1 | Entry/Author/Collection deletion, standalone Author create and Collection common tags; related counts/navigation and pending-work retention | IN PROGRESS / NOT YET ACCEPTED | UNVERIFIED |
| D2 | New Gallery/type, partition change, Entry rating-dimension delete and author conversion | NOT IMPLEMENTED IN THIS EXTENSION | UNVERIFIED |
| D3 | Author works merge including Source choice and relevant relations/media behavior | NOT IMPLEMENTED IN THIS EXTENSION | UNVERIFIED |
| D4 | Tag/Section/Facet changes plus ordinary template/layout actions | NOT IMPLEMENTED IN THIS EXTENSION | UNVERIFIED |
| D5 | Occupied-cover replacement and Quick create-to-edit, cold cache reuse | NOT IMPLEMENTED IN THIS EXTENSION | UNVERIFIED |
| D6 | Known-offline local errors/no implicit business HTTP, unavailable controls, reconnect and final queue recovery | NOT IMPLEMENTED IN THIS EXTENSION | UNVERIFIED |

Meaningful grouped release only after automatic gates and actual APK/signature/Web-byte verification. Install over existing app without uninstall/Clear/re-download. Formal-library deployment remains a separate authorized operation; never infer that source implementation updates the running desktop service or schema. Preserve native pinning/authentication, exact sealed work and existing cache. Actual phone/WebView/PluginCall/Keystore/touch/OS behavior remains unverified until observed against the matching new build.
