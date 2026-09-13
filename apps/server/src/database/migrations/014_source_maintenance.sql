-- Source invalidation maintenance: group-level status annotations plus the
-- durable review workflow state. Derived Content rows remain the only source
-- membership; these tables never hide, replace or delete old URLs. Runs and
-- items persist network results and human decisions so a server restart can
-- resume the same review instead of re-fetching silently.

CREATE TABLE source_statuses (
  source_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('active', 'invalid')),
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE source_maintenance_runs (
  id INTEGER PRIMARY KEY,
  origin_source_key TEXT NOT NULL,
  target_origin TEXT NOT NULL,
  adapter_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'running', 'paused', 'review', 'committed', 'cancelled', 'failed')
  ),
  mark_origin_invalid INTEGER NOT NULL DEFAULT 0 CHECK (mark_origin_invalid IN (0, 1)),
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE source_maintenance_items (
  run_id INTEGER NOT NULL,
  entry_id INTEGER NOT NULL,
  entry_title_snapshot TEXT NOT NULL,
  origin_urls_json TEXT NOT NULL,
  query_titles_json TEXT NOT NULL DEFAULT '[]',
  candidates_json TEXT NOT NULL DEFAULT '[]',
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (
    decision IN ('pending', 'accept', 'skip', 'conflict', 'error')
  ),
  selected_url TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error_text TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, entry_id),
  FOREIGN KEY (run_id) REFERENCES source_maintenance_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_source_maintenance_items_decision
ON source_maintenance_items(run_id, decision);
