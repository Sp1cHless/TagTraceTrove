import type { T3Database } from '../database/connection.js';

export interface EntryUsageRecord {
  viewCount: number;
  /** ISO 8601 UTC timestamp of the most recent view; null = never viewed. */
  lastViewedAt: string | null;
  likeCount: number;
}

export interface ProducerUsageRecord extends EntryUsageRecord {
  producerId: number;
}

export interface UsageFilterCondition {
  field: 'views' | 'lastViewed' | 'likes';
  operator: 'eq' | 'gt' | 'lt';
  /** views/likes: non-negative integer; lastViewed: yyyy-mm-dd (UTC date). */
  value: number | string;
}

export interface UsageSort {
  field: 'views' | 'lastViewed' | 'likes';
  direction: 'desc' | 'asc';
}

/** Likes are unlimited and re-clickable: each call adds one. */
export function likeEntry(database: T3Database, entryId: number): EntryUsageRecord {
  const entry = database.prepare('SELECT 1 FROM entries WHERE id = ?').get(entryId);
  if (!entry) {
    throw new Error('entry not found');
  }
  return database.transaction(() => {
    database.prepare(`
      INSERT INTO entry_usage (entry_id, view_count, like_count, updated_at)
      VALUES (?, 0, 1, CURRENT_TIMESTAMP)
      ON CONFLICT (entry_id) DO UPDATE SET
        like_count = entry_usage.like_count + 1,
        updated_at = CURRENT_TIMESTAMP
    `).run(entryId);
    const row = database.prepare(
      'SELECT view_count, last_viewed_at, like_count FROM entry_usage WHERE entry_id = ?',
    ).get(entryId) as { view_count: number; last_viewed_at: string | null; like_count: number };
    return {
      viewCount: row.view_count,
      lastViewedAt: row.last_viewed_at,
      likeCount: row.like_count,
    };
  })();
}

/**
 * Records one view: upserts the per-Entry usage row, creating it lazily on
 * the first view. Called when the user actually opens the source URL.
 */
export function recordEntryView(
  database: T3Database,
  entryId: number,
): EntryUsageRecord {
  const entry = database.prepare('SELECT 1 FROM entries WHERE id = ?').get(entryId);
  if (!entry) {
    throw new Error('entry not found');
  }
  return database.transaction(() => {
    database.prepare(`
      INSERT INTO entry_usage (entry_id, view_count, last_viewed_at, updated_at)
      VALUES (?, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), CURRENT_TIMESTAMP)
      ON CONFLICT (entry_id) DO UPDATE SET
        view_count = entry_usage.view_count + 1,
        last_viewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        updated_at = CURRENT_TIMESTAMP
    `).run(entryId);
    const row = database.prepare(
      'SELECT view_count, last_viewed_at, like_count FROM entry_usage WHERE entry_id = ?',
    ).get(entryId) as { view_count: number; last_viewed_at: string | null; like_count: number };
    return { viewCount: row.view_count, lastViewedAt: row.last_viewed_at, likeCount: row.like_count };
  })();
}

export function getEntryUsage(database: T3Database, entryId: number): EntryUsageRecord {
  const row = database.prepare(
    'SELECT view_count, last_viewed_at, like_count FROM entry_usage WHERE entry_id = ?',
  ).get(entryId) as { view_count: number; last_viewed_at: string | null; like_count: number } | undefined;
  return row
    ? { viewCount: row.view_count, lastViewedAt: row.last_viewed_at, likeCount: row.like_count }
    : { viewCount: 0, lastViewedAt: null, likeCount: 0 };
}

/**
 * Author-side usage is derived: views are the sum over the Author's works and
 * the last view is their most recent timestamp. Authors without any viewed
 * work report 0 / null.
 */
export function getProducerUsage(database: T3Database, producerId: number): EntryUsageRecord {
  const row = database.prepare(`
    SELECT SUM(usage.view_count) AS view_count, MAX(usage.last_viewed_at) AS last_viewed_at,
           SUM(usage.like_count) AS like_count
    FROM entry_producers AS relation
    JOIN entry_usage AS usage ON usage.entry_id = relation.entry_id
    WHERE relation.producer_id = ?
  `).get(producerId) as { view_count: number | null; last_viewed_at: string | null; like_count: number | null };
  return {
    viewCount: row.view_count ?? 0,
    lastViewedAt: row.last_viewed_at,
    likeCount: row.like_count ?? 0,
  };
}

export interface UsageFilterClauses {
  sql: string;
  parameters: Array<string | number>;
  orderSql: string;
}

/**
 * Builds WHERE fragments for the gallery filter: usage conditions compare the
 * per-Entry count (missing rows read as 0) or the UTC date part of the last
 * view, and `usageSort` produces an ORDER BY prefix where never-viewed
 * entries sink to the bottom in both directions.
 */
export function buildUsageFilterClauses(
  database: T3Database,
  conditions: UsageFilterCondition[],
  sort: UsageSort | null,
): UsageFilterClauses {
  const clauses: string[] = [];
  const parameters: Array<string | number> = [];

  for (const condition of conditions) {
    const column = condition.field === 'views'
      ? 'COALESCE(entry_usage.view_count, 0)'
      : condition.field === 'likes'
        ? 'COALESCE(entry_usage.like_count, 0)'
        : 'substr(entry_usage.last_viewed_at, 1, 10)';
    const comparison = condition.operator === 'eq' ? '=' : condition.operator === 'gt' ? '>' : '<';
    clauses.push(`${column} ${comparison} ?`);
    parameters.push(condition.value);
  }

  let orderSql = '';
  if (sort) {
    if (sort.field === 'views' || sort.field === 'likes') {
      // Missing rows read as 0, so the plain count ordering already handles
      // never-viewed entries naturally in both directions.
      const column = sort.field === 'views' ? 'entry_usage.view_count' : 'entry_usage.like_count';
      const direction = sort.direction === 'desc' ? 'DESC' : 'ASC';
      orderSql = `ORDER BY COALESCE(${column}, 0) ${direction}`;
    } else {
      // Date sort keeps never-viewed entries at the bottom either way; the
      // view count breaks ties within the same second (stable secondary key).
      const sink = 'CASE WHEN entry_usage.last_viewed_at IS NULL THEN 1 ELSE 0 END ASC';
      const direction = sort.direction === 'desc' ? 'DESC' : 'ASC';
      orderSql = `ORDER BY ${sink}, entry_usage.last_viewed_at ${direction}, COALESCE(entry_usage.view_count, 0) ${direction}`;
    }
  }

  void database;
  return { sql: clauses.join('\n      AND '), parameters, orderSql };
}
