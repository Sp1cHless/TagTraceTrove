# DB doctor

`pnpm db:doctor [optional-database-path]` runs SQLite integrity and foreign-key checks plus the Section/Facet and Entry-tag placement invariants. A provided file is opened read-only; no path uses a disposable migrated database.
