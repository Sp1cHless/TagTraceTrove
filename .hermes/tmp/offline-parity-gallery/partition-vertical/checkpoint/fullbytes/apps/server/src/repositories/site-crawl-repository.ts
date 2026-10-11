import type { T3Database } from '../database/connection.js';

/**
 * Durable site crawl state. A site_probe export folder is deleted after a run,
 * so the library itself has to remember which site-native works it already
 * holds and how far a crawled author or folder has been read. `site_works`
 * answers the first question per site, `site_crawl_sources` the second per
 * source; see migration `021_site_crawl_state.sql`.
 */

export type SiteCrawlSourceKind = 'artist' | 'folder' | 'work' | 'search';

export interface SiteWorkRecord {
  sourceSite: string;
  sourceId: string;
  entryId: number;
  detailUrl: string | null;
  /** `YYYY-MM-DD` as the source published it; null when the site has none. */
  workDate: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SiteCrawlSourceRecord {
  id: number;
  sourceSite: string;
  sourceKind: SiteCrawlSourceKind;
  sourceRef: string;
  displayName: string | null;
  sourceUrl: string | null;
  /** Newest work already held for this source; null before the first run. */
  lastSeenSourceId: string | null;
  lastSeenWorkDate: string | null;
  lastSeenOrderKey: string | null;
  crawlCount: number;
  firstCrawledAt: string;
  lastCrawledAt: string;
  /** Works of this whole site held in the library. Derived on read, never stored. */
  libraryWorkCount: number;
}

interface SiteWorkRow {
  source_site: string;
  source_id: string;
  entry_id: number;
  detail_url: string | null;
  work_date: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface SiteCrawlSourceRow {
  id: number;
  source_site: string;
  source_kind: SiteCrawlSourceKind;
  source_ref: string;
  display_name: string | null;
  source_url: string | null;
  last_seen_source_id: string | null;
  last_seen_work_date: string | null;
  last_seen_order_key: string | null;
  crawl_count: number;
  first_crawled_at: string;
  last_crawled_at: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
/** Wide enough for every site id in use, so the padding never truncates. */
const NUMERIC_ID_WIDTH = 18;

/**
 * Sortable high-water mark for one work. `\u0000` keeps the date and the id
 * from ever bleeding into each other, and numeric ids are zero-padded so a
 * plain string comparison orders `9` before `10` and before `100`.
 *
 * A work the site published without a date sorts *before* every dated work, so
 * an undated row can never advance a cursor past real dated works. A site with
 * no dates at all still gets a pure id ordering, and a source that mixes the
 * two falls back to the exact `site_works` membership check.
 */
export function siteWorkOrderKey(sourceId: string, workDate: string | null | undefined): string {
  const date = workDate !== null && workDate !== undefined && ISO_DATE.test(workDate.trim())
    ? workDate.trim()
    : '';
  const id = /^\d+$/u.test(sourceId)
    ? sourceId.padStart(NUMERIC_ID_WIDTH, '0')
    : sourceId.toLocaleLowerCase();
  return `${date}\u0000${id}`;
}

function siteWorkFromRow(row: SiteWorkRow): SiteWorkRecord {
  return {
    sourceSite: row.source_site,
    sourceId: row.source_id,
    entryId: row.entry_id,
    detailUrl: row.detail_url,
    workDate: row.work_date,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

function libraryWorkCount(database: T3Database, sourceSite: string): number {
  return database.prepare(
    'SELECT COUNT(*) FROM site_works WHERE source_site = ?',
  ).pluck().get(sourceSite) as number;
}

function siteCrawlSourceFromRow(
  database: T3Database,
  row: SiteCrawlSourceRow,
): SiteCrawlSourceRecord {
  return {
    id: row.id,
    sourceSite: row.source_site,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    displayName: row.display_name,
    sourceUrl: row.source_url,
    lastSeenSourceId: row.last_seen_source_id,
    lastSeenWorkDate: row.last_seen_work_date,
    lastSeenOrderKey: row.last_seen_order_key,
    crawlCount: row.crawl_count,
    firstCrawledAt: row.first_crawled_at,
    lastCrawledAt: row.last_crawled_at,
    libraryWorkCount: libraryWorkCount(database, row.source_site),
  };
}

// --- Work identity --------------------------------------------------------+

export interface RecordSiteWorkInput {
  sourceSite: string;
  sourceId: string;
  entryId: number;
  detailUrl?: string | null;
  workDate?: string | null;
}

/**
 * Remembers that one site-native work is (now) this Entry. Re-recording keeps
 * the original `first_seen_at`, so a work that keeps arriving from new folders
 * still reports when the library first met it.
 */
export function recordSiteWork(
  database: T3Database,
  input: RecordSiteWorkInput,
): SiteWorkRecord {
  database.prepare(`
    INSERT INTO site_works (
      source_site, source_id, entry_id, detail_url, work_date, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(source_site, source_id) DO UPDATE SET
      entry_id = excluded.entry_id,
      detail_url = COALESCE(excluded.detail_url, site_works.detail_url),
      work_date = COALESCE(excluded.work_date, site_works.work_date),
      last_seen_at = CURRENT_TIMESTAMP
  `).run(
    input.sourceSite,
    input.sourceId,
    input.entryId,
    input.detailUrl ?? null,
    input.workDate ?? null,
  );
  return findSiteWork(database, input.sourceSite, input.sourceId)!;
}

export function findSiteWork(
  database: T3Database,
  sourceSite: string,
  sourceId: string,
): SiteWorkRecord | null {
  const row = database.prepare(`
    SELECT * FROM site_works WHERE source_site = ? AND source_id = ?
  `).get(sourceSite, sourceId) as SiteWorkRow | undefined;
  return row ? siteWorkFromRow(row) : null;
}

/** Works of one site already held, keyed by site id. Absent ids are unknown. */
export function findSiteWorks(
  database: T3Database,
  sourceSite: string,
  sourceIds: ReadonlyArray<string>,
): Map<string, SiteWorkRecord> {
  const found = new Map<string, SiteWorkRecord>();
  if (sourceIds.length === 0) return found;
  const statement = database.prepare(
    'SELECT * FROM site_works WHERE source_site = ? AND source_id = ?',
  );
  for (const sourceId of new Set(sourceIds)) {
    const row = statement.get(sourceSite, sourceId) as SiteWorkRow | undefined;
    if (row) found.set(sourceId, siteWorkFromRow(row));
  }
  return found;
}

/**
 * Splits a listing into the works the library already has and the ones it does
 * not. This is the exact answer for sites whose ids carry no usable order: list
 * the folder, ask, fetch only the difference.
 */
export function partitionKnownSiteWorks(
  database: T3Database,
  sourceSite: string,
  sourceIds: ReadonlyArray<string>,
): { known: SiteWorkRecord[]; unknown: string[] } {
  const found = findSiteWorks(database, sourceSite, sourceIds);
  const known: SiteWorkRecord[] = [];
  const unknown: string[] = [];
  for (const sourceId of sourceIds) {
    const record = found.get(sourceId);
    if (record) known.push(record);
    else unknown.push(sourceId);
  }
  return { known, unknown };
}

// --- Crawl cursors --------------------------------------------------------+

export interface SiteCrawlSourceKey {
  sourceSite: string;
  sourceKind: SiteCrawlSourceKind;
  sourceRef: string;
}

export interface CrawlObservation extends SiteCrawlSourceKey {
  displayName?: string | null;
  url?: string | null;
  /** Every work the run carried for this source, newly created or already held. */
  works?: ReadonlyArray<{ sourceId: string; workDate?: string | null }>;
}

/**
 * Records one visit to a source and moves its cursor forward. The cursor only
 * ever advances: a re-crawl that returns nothing new, or an older page fetched
 * out of order, cannot pull it back to a point that re-reads known works.
 */
export function recordCrawlObservation(
  database: T3Database,
  observation: CrawlObservation,
): SiteCrawlSourceRecord {
  const existing = getSiteCrawlSource(database, observation);
  let bestKey = existing?.lastSeenOrderKey ?? '';
  let bestSourceId = existing?.lastSeenSourceId ?? null;
  let bestWorkDate = existing?.lastSeenWorkDate ?? null;

  for (const work of observation.works ?? []) {
    const key = siteWorkOrderKey(work.sourceId, work.workDate);
    if (key > bestKey) {
      bestKey = key;
      bestSourceId = work.sourceId;
      bestWorkDate = work.workDate ?? null;
    }
  }

  if (existing === null) {
    database.prepare(`
      INSERT INTO site_crawl_sources (
        source_site, source_kind, source_ref, display_name, source_url,
        last_seen_source_id, last_seen_work_date, last_seen_order_key, crawl_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      observation.sourceSite,
      observation.sourceKind,
      observation.sourceRef,
      observation.displayName ?? null,
      observation.url ?? null,
      bestSourceId,
      bestWorkDate,
      bestKey === '' ? null : bestKey,
    );
  } else {
    database.prepare(`
      UPDATE site_crawl_sources
      SET display_name = COALESCE(?, display_name),
          source_url = COALESCE(?, source_url),
          last_seen_source_id = ?,
          last_seen_work_date = ?,
          last_seen_order_key = ?,
          crawl_count = crawl_count + 1,
          last_crawled_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      observation.displayName ?? null,
      observation.url ?? null,
      bestSourceId,
      bestWorkDate,
      bestKey === '' ? null : bestKey,
      existing.id,
    );
  }

  return getSiteCrawlSource(database, observation)!;
}

export function getSiteCrawlSource(
  database: T3Database,
  key: SiteCrawlSourceKey,
): SiteCrawlSourceRecord | null {
  const row = database.prepare(`
    SELECT * FROM site_crawl_sources
    WHERE source_site = ? AND source_kind = ? AND source_ref = ?
  `).get(key.sourceSite, key.sourceKind, key.sourceRef) as SiteCrawlSourceRow | undefined;
  return row ? siteCrawlSourceFromRow(database, row) : null;
}

/** All cursors, optionally narrowed to one site, newest visit first. */
export function listSiteCrawlSources(
  database: T3Database,
  sourceSite?: string,
): SiteCrawlSourceRecord[] {
  const rows = (sourceSite === undefined
    ? database.prepare('SELECT * FROM site_crawl_sources ORDER BY last_crawled_at DESC, id').all()
    : database.prepare(
      'SELECT * FROM site_crawl_sources WHERE source_site = ? ORDER BY last_crawled_at DESC, id',
    ).all(sourceSite)) as SiteCrawlSourceRow[];
  return rows.map((row) => siteCrawlSourceFromRow(database, row));
}
