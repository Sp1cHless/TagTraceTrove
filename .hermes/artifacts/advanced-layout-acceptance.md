# Advanced functions mobile layout repair — bounded acceptance

Status IMPLEMENTING, sole source/test writer deleg_b9201399. Latest released v43 stays frozen; no v44 or current layout PASS claimed yet.

User reported real App right overflow in Tags, Source maintenance and Offline library, including text, fields and buttons. Fix all three, not only shared navigation. Preserve behavior/data/native transport, desktop layout, existing unrelated dirty changes. Production service/data/assets/migrations are outside scope.

## Required layout proof

- Mount and navigate actual GalleryApp → Settings → Advanced functions, preserving production sidebar/content-card/AdvancedEditingPage wrappers. Bare panel width is not accepted as shell proof.
- Reproduce real source browser RED with card inner bounds, not only document scrollWidth. Source min-content overflow can be hidden by an existing clipped wrapper.
- English360/390/430/768; Chinese labels sanity check. Long tags/section/facet names, URLs/source labels and library status/metadata. Exercise tabs, nonempty rows, expand/edit and inputs/buttons. Any disabled/offline states must be labeled and not counted as interactive edit proof.
- No blanket overflow:hidden or text/font shrinking workaround. Allow text/long tokens to wrap and flex/grid children/controls to shrink appropriately; buttons wrap/reflow but remain usable. Existing Author rating-only responsive fix must stay intact.
- Keep empty/nonempty/expanded states distinct. Source/library semantics and physical keyboard/WebView behavior are not inferred from a desktop fixture.

## Delivery

Writer retains complete original bytes with hash-guarded unique targeted patches, scoped diff, executed browser regression, focused component tests/typecheck/lint/diff and a full-byte current checkpoint. Report `.hermes/artifacts/advanced-layout-implementation.md`; expose isolated fixture URL and PID/session so parent can independently inspect then stop it.

Parent owns final source review, current gates, identity increment from verified current43, same-signer v44 APK build/package byte verification, source/APK freeze and status updates. Version prefix/name will describe advanced-layout rather than silently label old package new. App upgrade preserves pairing/metadata/media; no uninstall/Clear or forced library download. Phone verification independent and deferred, not falsely declared PASS.
