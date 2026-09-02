# T³ product plan

> Current plan. This document supersedes the earlier collection-first and generic field/value design.

## Product definition

T³ is a lightweight, local-first, tag-first personal index. It optimizes for fast daily browsing, tagging, source independence, and local ownership. It is not a generic database, PKM, project manager, media player, downloader, or crawler.

## Core subjects

- Entry: a work or collected item, categorized directly by `Entry.type`.
- Producer: a creator linked many-to-many with Entries.
- There is no Collection entity. Entry types such as manga, game, movie, novel, or recipe provide top-level browsing categories.

## Tag behavior

Entry tags and Producer tags use separate vocabularies. Similarity or autocomplete in one pool must not leak into the other. Producer search may use tags from the Producer's related Entries through joins.

Entry tags are organized by a type-level visual layout:

```text
Section
  └─ Facet
       └─ Tag assignments
```

A Section is a visible dashed divider. It never owns a Tag directly. If no visible Facet label is wanted, the Section contains an unnamed Facet; the UI hides its label and does not allocate a separate visual position. Dragging a Tag changes its Facet assignment.

Examples:

```text
Basic information
  Game:      [RPG] [Action]
  Character: [Amiya] [Kal'tsit]

Review
  (unnamed): [Favorite] [Worth replaying]
```

## Content

Content is outside the Section/Facet layout.

- An Entry can have ordered content rows. `content_type` is a free text label; the body is stored in `content`. Short reviews and source URLs are examples, not an enum.
- A Producer has one simple `content` field for its important short review or note.

## Author experience

`Producer` remains the internal domain and API name, but all normal product UI calls it `Author`. Once the first Producer exists, an `Author` destination appears alongside the type-derived Galleries; it is a navigation page, not another persisted Gallery or Entry type.

The Author detail page uses one unified information card. Its upper portion shows the Author's basic information in the same visual language as Entry detail. Author Tags use the independent Producer Tag vocabulary and sit directly below the basic fields behind a single `+ Tag` control; Authors have no Section or Facet layout. The scalar Author Content note follows the Tags inside the same information card rather than appearing in a separate Entry-style Content card.

Below the information card, the Author's linked works use the same cards as a Gallery and open the corresponding Entry detail. The list is paginated at 25 visible cards per page. Tag filtering is deferred.

Edit mode adds presentation-only Directories for organizing an Author's work cards without changing Entry classification or adding a grouping property to Entry. A `+ Directory` action sits at the upper-right of the work-card area. Dropping one loose work card onto another creates a Directory, and dropping a work card onto an existing Directory moves it inside. The interaction and merge feedback should resemble mobile app-icon folder creation. A Directory has only a title and description, opens to its own view with an Edit action at the upper-right, and uses up to the first three contained work covers as its composite cover. Directory persistence is Author-page UI organization, not a new Entry domain relationship.

## Daily UX

1. Gallery before table.
2. Fast tagging over perfect metadata.
3. Click before dialog.
4. Common actions avoid settings screens.
5. Source is optional and never Entry identity.
6. Complexity must be earned by real use.

## Technical boundary

SQLite is owned by the local backend through explicit SQL and `better-sqlite3`. The frontend never opens SQLite. Schema work proceeds in this order:

```text
immutable migration
→ db:probe
→ real-SQL integration tests
→ db:doctor
→ API
→ product UI
```

The authoritative schema description is `docs/current-architecture.md`; the executable schema is `apps/server/src/database/migrations/001_initial.sql`.
