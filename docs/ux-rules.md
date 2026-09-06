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

If a common action needs a settings dialog, redesign it.
