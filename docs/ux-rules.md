# UX rules

- Daily use first.
- Fast tagging over perfect metadata.
- Gallery before table.
- Click before dialog.
- Template before schema builder.
- Source is optional and never Entry identity.
- Complexity must be earned by real usage.
- Entry card stacks preserve each cover/preview's natural aspect ratio; page depth comes from perspective, side rotation, and offsets—not square padding or cropping.
- All work cards (Gallery, Recently viewed, View later, Collection members, tag results) reuse the shared `EntryCard.vue`; never re-implement card layout per page.
- Sidebar entries are top-priority navigation: clicking any entry must switch views immediately from any depth.
- A back button returns to the view the user actually came from, never to a blank or default page.
- Pages split per Gallery use connected tabs — the active tab's edge joins the content panel, like a real browser tab.
- Mode switches (★ / ♥ / 👍 and similar) are toggles: clicking the active mode again exits it.
- New views must not render before their data is ready; load first, switch after, so no intermediate page flashes.
- Usage stats (views / likes / last viewed) are sort-only annotations, never numeric filter conditions.
- Mobile is responsive Web, not a separate native product or browser-specific fork; use standards and feature detection rather than user-agent branches.
- Chrome is the primary real-device browser, not an implementation dependency.
- Final mobile parity includes every existing non-import function, including creation, editing, organization, and deletion; site-probe folder and batch import remain desktop-only.
- No essential action may depend only on hover, long-press, or HTML5 drag-and-drop. Long-press may be a shortcut, but a discoverable tap path is mandatory.
- Destructive mobile actions use the same two-step arm/confirm pattern as desktop.
- Mobile touch targets should normally be at least 44×44 CSS pixels, and pages must not introduce viewport-level horizontal overflow.
- Card navigation uses directional scroll state: a newly opened detail/folder starts at the top, while Back restores the exact scroll position, pagination, active tab, sort/filter context, and immediate parent path. Nested Author/Directory/Entry and Collection/Entry paths preserve each level independently.
- The top-bar Back control invokes the same hierarchy as each page's local Back and is disabled on Home; Entry and Author details keep a fixed 44×44 lower-right control for scrolling to the current page top.

If a common action needs a settings dialog, redesign it.
