-- Site crawl identity and update cursors. A site_probe export folder is
-- disposable — the crawler deletes it once the works are in — so an author or
-- folder ingested months ago leaves no local record of what it contained. These
-- two tables live in the library for exactly that reason.
--
--   site_works          one durable row per site-native work id, pointing at
--                       the Entry it became (or already was). This is the
--                       "have we already ingested hitomi.la work 3220586?" map,
--                       and it is what lets a run skip works whose export file
--                       no longer exists.
--   site_crawl_sources  one row per crawled author / folder / search, carrying
--                       the newest work already held for it. The next run reads
--                       that cursor and re-lists only what sorts after it
--                       instead of walking the whole folder again.
--
-- Work identity is global per site while the cursor is per source, because the
-- same work legitimately arrives from several sources (an artist folder and a
-- collection folder both list it). Neither table joins the sync allowlist:
-- they describe the local crawl, not the curated library.
CREATE TABLE site_works (
  source_site TEXT NOT NULL CHECK (trim(source_site) <> ''),
  source_id TEXT NOT NULL CHECK (trim(source_id) <> ''),
  entry_id INTEGER NOT NULL,
  detail_url TEXT,
  work_date TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_site, source_id),
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_site_works_entry
ON site_works(entry_id);

CREATE TABLE site_crawl_sources (
  id INTEGER PRIMARY KEY,
  source_site TEXT NOT NULL CHECK (trim(source_site) <> ''),
  -- 'folder' covers collection / album / tag listings; the kind only labels
  -- which site listing the cursor describes, it never changes the cursor rule.
  source_kind TEXT NOT NULL CHECK (source_kind IN ('artist', 'folder', 'work', 'search')),
  source_ref TEXT NOT NULL CHECK (trim(source_ref) <> ''),
  display_name TEXT,
  source_url TEXT,
  -- Newest work already held for this source. last_seen_order_key is the
  -- forward-only high-water mark a later run compares against; the id and date
  -- beside it are what a crawler actually reads. All three move together.
  last_seen_source_id TEXT,
  last_seen_work_date TEXT,
  last_seen_order_key TEXT,
  crawl_count INTEGER NOT NULL DEFAULT 0 CHECK (crawl_count >= 0),
  first_crawled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_crawled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_site, source_kind, source_ref)
);

CREATE INDEX idx_site_crawl_sources_site
ON site_crawl_sources(source_site, source_kind, source_ref);
