import type { T3Database } from '../database/connection.js';

export interface EntrySourceRecord {
  entryId: number;
  contentId: number;
  sourceKey: string;
  sourceName: string;
  host: string;
  url: string;
}

export type SourceStatusState = 'active' | 'invalid';

export interface SourceLibraryRecord {
  sourceKey: string;
  sourceName: string;
  hosts: string[];
  entryCount: number;
  entryUrlCount: number;
  /** Group-level annotation; it never hides, replaces or deletes URLs. */
  state: SourceStatusState;
  statusNote: string | null;
}

interface ContentSourceRow {
  entry_id: number;
  content_id: number;
  content: string;
}

export const SOURCE_REGISTRY: ReadonlyArray<{
  key: string;
  name: string;
  hosts: ReadonlyArray<{ hostname: string; includeSubdomains: boolean }>;
}> = [
  { key: 'hitomi', name: 'Hitomi', hosts: [
    { hostname: 'hitomi.la', includeSubdomains: false },
    { hostname: 'www.hitomi.la', includeSubdomains: false },
  ] },
  { key: '18comic', name: '18comic', hosts: [
    { hostname: '18comic.vip', includeSubdomains: false },
    { hostname: 'www.18comic.vip', includeSubdomains: false },
  ] },
  { key: 'hanime1', name: 'Hanime1', hosts: [
    { hostname: 'hanime1.me', includeSubdomains: false },
    { hostname: 'www.hanime1.me', includeSubdomains: false },
  ] },
];

const MAX_SOURCE_URL_LENGTH = 4_096;

function trimUrlPunctuation(value: string): string {
  let result = value.replace(/[.,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f]+$/gu, '');
  for (const [closing, opening] of [[')', '('], [']', '['], ['}', '{']] as const) {
    while (result.endsWith(closing)) {
      const openingCount = [...result].filter((character) => character === opening).length;
      const closingCount = [...result].filter((character) => character === closing).length;
      if (closingCount <= openingCount) break;
      result = result.slice(0, -1);
    }
  }
  return result;
}

export function normalizeSourceUrl(value: string): string | null {
  try {
    const trimmed = trimUrlPunctuation(value.trim());
    if (trimmed.length > MAX_SOURCE_URL_LENGTH) return null;
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hostname = parsed.hostname.replace(/\.+$/u, '');
    parsed.hash = '';
    const normalized = parsed.toString();
    return normalized.length <= MAX_SOURCE_URL_LENGTH ? normalized : null;
  } catch {
    return null;
  }
}

export function extractSourceUrls(content: string): string[] {
  const candidates = content.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeSourceUrl(candidate);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  }
  return urls;
}

export function classifySourceUrl(url: string): {
  sourceKey: string;
  sourceName: string;
  host: string;
} {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const known = SOURCE_REGISTRY.find((source) => source.hosts.some((rule) => (
    host === rule.hostname || (rule.includeSubdomains && host.endsWith(`.${rule.hostname}`))
  )));
  return known
    ? { sourceKey: `known:${known.key}`, sourceName: known.name, host }
    : { sourceKey: `host:${host}`, sourceName: host, host };
}

export function listEntrySources(database: T3Database, entryId: number): EntrySourceRecord[] {
  const rows = database.prepare(`
    SELECT entry_id, id AS content_id, content
    FROM entry_contents
    WHERE entry_id = ?
    ORDER BY sort_order, id
  `).all(entryId) as ContentSourceRow[];
  return sourceRecords(rows);
}

export function listAllEntrySources(database: T3Database): EntrySourceRecord[] {
  const rows = database.prepare(`
    SELECT entry_id, id AS content_id, content
    FROM entry_contents
    ORDER BY entry_id, sort_order, id
  `).all() as ContentSourceRow[];
  return sourceRecords(rows);
}

function sourceRecords(rows: ContentSourceRow[]): EntrySourceRecord[] {
  const records: EntrySourceRecord[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const url of extractSourceUrls(row.content)) {
      const identity = `${row.entry_id}\u0000${url}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      records.push({ entryId: row.entry_id, contentId: row.content_id, url, ...classifySourceUrl(url) });
    }
  }
  return records;
}

export function listSourceLibrary(database: T3Database): SourceLibraryRecord[] {
  const statusRows = database.prepare(`
    SELECT source_key, state, note
    FROM source_statuses
  `).all() as Array<{ source_key: string; state: SourceStatusState; note: string | null }>;
  const statuses = new Map(statusRows.map((row) => [row.source_key, row]));

  const groups = new Map<string, {
    sourceName: string;
    hosts: Set<string>;
    entryIds: Set<number>;
    urls: Set<string>;
  }>();
  for (const source of listAllEntrySources(database)) {
    const group = groups.get(source.sourceKey) ?? {
      sourceName: source.sourceName,
      hosts: new Set<string>(),
      entryIds: new Set<number>(),
      urls: new Set<string>(),
    };
    group.hosts.add(source.host);
    group.entryIds.add(source.entryId);
    group.urls.add(`${source.entryId}\u0000${source.url}`);
    groups.set(source.sourceKey, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceKey, group]) => {
      const status = statuses.get(sourceKey);
      return {
        sourceKey,
        sourceName: group.sourceName,
        hosts: [...group.hosts].sort(),
        entryCount: group.entryIds.size,
        entryUrlCount: group.urls.size,
        state: status?.state === 'invalid' ? 'invalid' : 'active',
        statusNote: status?.note ?? null,
      };
    });
}

export function listEntryIdsBySourceKey(database: T3Database, sourceKey: string): number[] {
  return [...new Set(
    listAllEntrySources(database)
      .filter((source) => source.sourceKey === sourceKey)
      .map((source) => source.entryId),
  )].sort((left, right) => left - right);
}
