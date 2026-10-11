# Parent actual-shell browser review — Quick import / Author filters

Status: actual-shell browser RED found; no production patch applied by parent while sole writer deleg_395b31e0 active. Existing independent-component Author bounds are insufficient.

Scope: injected throw-only API and isolated IDB at 127.0.0.1:18742, `/health` verified isolated=true / productionApi=false. This is actual Chromium/source Vue, not hardware. No default API/assets read.

## Independently verified

- All nine first-worker checkpoint hashes match live bytes at handoff. Scoped start→green diff reviewed: self-only dimensions, unscored options, anchor Gallery eligibility, fail-closed wrong class/id, whole-author NSFW visibility, anchor SQL guard, and client-Vue integration plugin. No migrations/payload/native changes.
- Quick import actual GalleryApp at 360/430: fields stacked, 44px height, all input bounds inside viewport. 768: facts aligned. Fullwidth `13：25` accepted by production text input. In actual 360 browser form, invalid value displayed `Use h:mm:ss, mm:ss, m:ss, ss or s` and isolated store `.list()` length stayed 0. After valid input/submit, queue held durationSeconds=805 and expected test title, no alert. Initial diagnostic used nonexistent `.listOutbox()` and failed; corrected to real store `.list()`. This is a harness failure, not an app defect.
- Independent AuthorPage 360/430/768 exposes fresh unrated slot; choosing `unrated` removes stars selector. Browser console after normal interactions: zero JS errors; Vite debug logs only.

## Actual-shell visual defect RED

Repro: in real GalleryApp fixture, open navigation → Authors → Rating; narrow iframe CSS viewport to 360. This preserves actual sidebar/card wrappers rather than mounting AuthorPage bare. Document client/scroll width=345 (desktop scrollbar), iframe innerWidth=360.

Measured rating row left=25 right=362.734375 width=337.734375; dimension select width40.40625; operator right208.78125; stars right321.15625; remove button left328.34375 right362.734375. Content-card clipping hides the remove control and shrinks the dimension field to nearly only its arrow. Screenshot captured in browser_vision tool at this exact state. Bare AuthorPage previous result fit because it had the full 360px rather than the production card's inner width.

At actual-shell430 before narrowing: row bounds25..390, no viewport overflow. Need preserve wider layout and recheck actual-shell768 as well.

Source cause: `.author-list-filter-row` flex single-line, first label flexible but minimum content + two intrinsic select widths + delete/gaps cannot fit narrower actual card. Mobile override only max-width100%, no responsive row arrangement.

Proposed UNAPPLIED targeted repair after writer stops: add a dedicated rating-row class, retain original tag-row class; phone-width CSS grid with full-width dimension label above operator/stars/delete, minimum-zero select tracks and 44px delete target; unrated operator spans both select tracks. Do not globally change unrelated tag filters or rating-board editing. Validate bounds against content card, not only viewport, in the actual shell at360/430/768, rated/unrated and multi-row states. Observe browser RED→GREEN and add reproducible browser regression, not a jsdom layout claim.

Physical phone, actual IME/keyboard/tap and OS/Keystore/WebView remain UNVERIFIED. Parent source edits only after current worker explicitly stops; full gates/package remain pending.
