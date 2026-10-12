# Web UI and component sandbox

The Web entry point is now the database-backed `GalleryApp.vue` product page. It talks only to the local HTTP API; the frontend never opens SQLite directly.

Run the API and Web app in separate terminals:

```text
pnpm start:server
pnpm --filter @t3/web dev
```

Current product behavior:

- Gallery navigation is derived from `Entry.type`;
- creating an Entry with a new type makes a new Gallery appear;
- Gallery Entries can be filtered by cycling Tags through include, exclude, and neutral states;
- Entry cards open read mode from the card body and edit mode from a separate action on the card's right edge;
- Entry detail reads the composed Producer, Section/Facet/Tag, and Content structure without mutation controls;
- edit mode adds Sections below the information board, Facets below their Section, and Tags inside their Facet;
- Sections stack vertically behind dashed dividers, while each Facet occupies a left label column separated from its Tags by a lighter dashed rule;
- the required unnamed Facet keeps its left column blank, so its Tags read visually as direct children of the Section;
- Entry Tags can be dragged between Facets or removed inline while edit mode is active.

The earlier persistence-free visual components remain available as isolated building blocks:

- light and dark theme tokens in `apps/web/src/styles/theme.css`;
- rounded rectangular `TagChip`;
- `TagBoard` with native drag-and-drop reordering and in-memory removal;
- `TagSandbox.vue` for visual experimentation.

Their tests remain persistence-free. Product behavior is tested through the `GalleryApi` boundary, while real persistence behavior is covered by server HTTP integration tests against migrated SQLite databases.
