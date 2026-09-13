import type { T3Database } from '../database/connection.js';
import {
  sourceCandidateSchema,
  sourceMaintenanceItemRecordSchema,
  type SourceInvalidState,
  type SourceMaintenanceItemRecord,
  type SourceMaintenanceItemStateFilter,
  type SourceMaintenanceRunCounts,
  type SourceMaintenanceRunRecord,
  type SourceMaintenanceRunStatus,
  type SourceStatusRecord,
} from '@t3/shared';

/** Persisted workflow state for Source invalidation maintenance. All stored
 * JSON is parsed back through the shared schemas; nothing is trusted blindly. */

interface RunRow {
  id: number;
  origin_source_key: string;
  target_origin: string;
  adapter_key: string;
  status: SourceMaintenanceRunStatus;
  mark_origin_invalid: number;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  run_id: number;
  entry_id: number;
  entry_title_snapshot: string;
  origin_urls_json: string;
  query_titles_json: string;
  candidates_json: string;
  decision: SourceMaintenanceItemRecord['decision'];
  selected_url: string | null;
  evidence_json: string;
  error_text: string | null;
  updated_at: string;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function itemFromRow(row: ItemRow): SourceMaintenanceItemRecord {
  const candidates = parseJson<unknown[]>(row.candidates_json, []).map((candidate) => (
    sourceCandidateSchema.parse(candidate)
  ));
  return sourceMaintenanceItemRecordSchema.parse({
    entryId: row.entry_id,
    entryTitleSnapshot: row.entry_title_snapshot,
    originUrls: parseJson<string[]>(row.origin_urls_json, []),
    queryTitles: parseJson<string[]>(row.query_titles_json, []),
    candidates,
    decision: row.decision,
    selectedUrl: row.selected_url,
    errorText: row.error_text,
    updatedAt: row.updated_at,
  });
}

function runCounts(database: T3Database, runId: number): SourceMaintenanceRunCounts {
  const rows = database.prepare(`
    SELECT candidates_json, query_titles_json, decision, error_text
    FROM source_maintenance_items
    WHERE run_id = ?
  `).all(runId) as Array<{ candidates_json: string; query_titles_json: string; decision: string; error_text: string | null }>;

  const counts: SourceMaintenanceRunCounts = {
    total: rows.length,
    processed: 0,
    matched: 0,
    ambiguous: 0,
    noMatch: 0,
    errors: 0,
  };
  for (const row of rows) {
    const candidates = parseJson<unknown[]>(row.candidates_json, []).map((candidate) => (
      sourceCandidateSchema.safeParse(candidate)
    )).filter((result) => result.success).map((result) => result.data);
    // A processed item always carries query variants, a decision, candidates
    // or an error; untouched skeleton rows have none of those.
    const visited = row.decision !== 'pending'
      || candidates.length > 0
      || row.error_text !== null
      || parseJson<string[]>(row.query_titles_json, []).length > 0;
    if (!visited) continue;
    counts.processed += 1;
    if (row.error_text !== null) counts.errors += 1;
    const bands = candidates.map((candidate) => candidate.band);
    if (bands.includes('exact-safe') || bands.includes('strong-review')) counts.matched += 1;
    if (bands.includes('ambiguous') || bands.includes('conflict')) counts.ambiguous += 1;
    if (candidates.length === 0 && row.error_text === null) counts.noMatch += 1;
  }
  return counts;
}

function runFromRow(database: T3Database, row: RunRow): SourceMaintenanceRunRecord {
  return {
    id: row.id,
    originSourceKey: row.origin_source_key,
    adapterKey: row.adapter_key,
    targetOrigin: row.target_origin,
    status: row.status,
    markOriginInvalid: row.mark_origin_invalid === 1,
    counts: runCounts(database, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Status overlay -------------------------------------------------------+

export function getSourceStatus(
  database: T3Database,
  sourceKey: string,
): SourceStatusRecord | null {
  const row = database.prepare(`
    SELECT source_key, state, note, updated_at
    FROM source_statuses
    WHERE source_key = ?
  `).get(sourceKey) as { source_key: string; state: SourceInvalidState; note: string | null; updated_at: string } | undefined;
  if (!row) return null;
  return {
    sourceKey: row.source_key,
    state: row.state,
    note: row.note,
    updatedAt: row.updated_at,
  };
}

export function listSourceStatuses(database: T3Database): SourceStatusRecord[] {
  const rows = database.prepare(`
    SELECT source_key, state, note, updated_at
    FROM source_statuses
    ORDER BY source_key
  `).all() as Array<{ source_key: string; state: SourceInvalidState; note: string | null; updated_at: string }>;
  return rows.map((row) => ({
    sourceKey: row.source_key,
    state: row.state,
    note: row.note,
    updatedAt: row.updated_at,
  }));
}

export function setSourceStatus(
  database: T3Database,
  sourceKey: string,
  state: SourceInvalidState,
  note?: string,
): SourceStatusRecord {
  const existing = getSourceStatus(database, sourceKey);
  database.prepare(`
    INSERT INTO source_statuses (source_key, state, note, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(source_key) DO UPDATE SET
      state = excluded.state,
      note = excluded.note,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    sourceKey,
    state,
    note === undefined ? existing?.note ?? null : note === '' ? null : note,
  );
  return getSourceStatus(database, sourceKey)!;
}

// --- Runs -----------------------------------------------------------------+

export interface CreateRunInput {
  originSourceKey: string;
  adapterKey: string;
  targetOrigin: string;
  markOriginInvalid: boolean;
  settings: Record<string, unknown>;
}

export function createRun(database: T3Database, input: CreateRunInput): SourceMaintenanceRunRecord {
  const result = database.prepare(`
    INSERT INTO source_maintenance_runs (
      origin_source_key, target_origin, adapter_key, status,
      mark_origin_invalid, settings_json
    ) VALUES (?, ?, ?, 'draft', ?, ?)
  `).run(
    input.originSourceKey,
    input.targetOrigin,
    input.adapterKey,
    input.markOriginInvalid ? 1 : 0,
    JSON.stringify(input.settings),
  );
  return getRun(database, Number(result.lastInsertRowid))!;
}

export function getRun(database: T3Database, runId: number): SourceMaintenanceRunRecord | null {
  const row = database.prepare(`
    SELECT * FROM source_maintenance_runs WHERE id = ?
  `).get(runId) as RunRow | undefined;
  return row ? runFromRow(database, row) : null;
}

export function listRunsByStatus(
  database: T3Database,
  status: SourceMaintenanceRunStatus,
): SourceMaintenanceRunRecord[] {
  const rows = database.prepare(`
    SELECT * FROM source_maintenance_runs WHERE status = ? ORDER BY id
  `).all(status) as RunRow[];
  return rows.map((row) => runFromRow(database, row));
}

export function updateRunStatus(
  database: T3Database,
  runId: number,
  status: SourceMaintenanceRunStatus,
): void {
  database.prepare(`
    UPDATE source_maintenance_runs
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, runId);
}

export function deleteRun(database: T3Database, runId: number): void {
  database.prepare('DELETE FROM source_maintenance_runs WHERE id = ?').run(runId);
}

// --- Items ----------------------------------------------------------------+

export interface UpsertItemInput {
  entryId: number;
  entryTitleSnapshot: string;
  originUrls: string[];
  queryTitles?: string[];
  candidates?: SourceMaintenanceItemRecord['candidates'];
  decision?: SourceMaintenanceItemRecord['decision'];
  selectedUrl?: string | null;
  errorText?: string | null;
}

export function upsertItem(
  database: T3Database,
  runId: number,
  input: UpsertItemInput,
): SourceMaintenanceItemRecord {
  database.prepare(`
    INSERT INTO source_maintenance_items (
      run_id, entry_id, entry_title_snapshot, origin_urls_json,
      query_titles_json, candidates_json, decision, selected_url, evidence_json, error_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
    ON CONFLICT(run_id, entry_id) DO UPDATE SET
      entry_title_snapshot = excluded.entry_title_snapshot,
      origin_urls_json = excluded.origin_urls_json,
      query_titles_json = excluded.query_titles_json,
      candidates_json = excluded.candidates_json,
      decision = excluded.decision,
      selected_url = excluded.selected_url,
      error_text = excluded.error_text,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    runId,
    input.entryId,
    input.entryTitleSnapshot,
    JSON.stringify(input.originUrls),
    JSON.stringify(input.queryTitles ?? []),
    JSON.stringify(input.candidates ?? []),
    input.decision ?? 'pending',
    input.selectedUrl ?? null,
    input.errorText ?? null,
  );
  return getItem(database, runId, input.entryId)!;
}

export function getItem(
  database: T3Database,
  runId: number,
  entryId: number,
): SourceMaintenanceItemRecord | null {
  const row = database.prepare(`
    SELECT * FROM source_maintenance_items WHERE run_id = ? AND entry_id = ?
  `).get(runId, entryId) as ItemRow | undefined;
  return row ? itemFromRow(row) : null;
}

export function patchItem(
  database: T3Database,
  runId: number,
  entryId: number,
  patch: { decision?: SourceMaintenanceItemRecord['decision'] | undefined; selectedUrl?: string | null | undefined },
): SourceMaintenanceItemRecord | null {
  const existing = getItem(database, runId, entryId);
  if (!existing) return null;
  database.prepare(`
    UPDATE source_maintenance_items
    SET decision = ?,
        selected_url = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE run_id = ? AND entry_id = ?
  `).run(
    patch.decision ?? existing.decision,
    patch.selectedUrl === undefined ? existing.selectedUrl : patch.selectedUrl,
    runId,
    entryId,
  );
  return getItem(database, runId, entryId);
}

export function listItemEntries(
  database: T3Database,
  runId: number,
): Array<{ entryId: number; decision: SourceMaintenanceItemRecord['decision']; selectedUrl: string | null }> {
  return (database.prepare(`
    SELECT entry_id, decision, selected_url
    FROM source_maintenance_items
    WHERE run_id = ?
    ORDER BY entry_id
  `).all(runId) as Array<{ entry_id: number; decision: SourceMaintenanceItemRecord['decision']; selected_url: string | null }>)
    .map((row) => ({ entryId: row.entry_id, decision: row.decision, selectedUrl: row.selected_url }));
}

export function listRunItems(
  database: T3Database,
  runId: number,
  page: number,
  pageSize: number,
  state: SourceMaintenanceItemStateFilter = 'all',
): { items: SourceMaintenanceItemRecord[]; total: number } {
  const all = (database.prepare(`
    SELECT * FROM source_maintenance_items WHERE run_id = ? ORDER BY entry_id
  `).all(runId) as ItemRow[]).map((row) => itemFromRow(row));

  const filtered = all.filter((item) => {
    if (state === 'all') return true;
    if (state === 'pending') return item.decision === 'pending';
    if (state === 'accepted') return item.decision === 'accept';
    if (state === 'skipped') return item.decision === 'skip';
    return item.decision === 'conflict' || item.decision === 'error'
      || item.candidates.every((candidate) => candidate.band === 'no-match' || candidate.band === 'error');
  });
  const start = (page - 1) * pageSize;
  return {
    items: filtered.slice(start, start + pageSize),
    total: filtered.length,
  };
}
