# Migrations

`001_initial.sql` is the reviewed SQLite baseline. `applyAllMigrations()` records each version, filename, and SHA-256 checksum in `schema_migrations`; applied files become immutable after merge.
