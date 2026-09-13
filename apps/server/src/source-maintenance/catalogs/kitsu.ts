import {
  asArray,
  asRecord,
  asString,
  fetchProviderJson,
  type CatalogTitle,
  type CatalogWork,
  type FetchLike,
  type TitleCatalogProvider,
  type TitleQuery,
} from '../catalog-provider.js';

/**
 * Kitsu — romaji/English/Japanese title supplies. Search may return both a
 * oneshot record and the series record for the same name; the parser keeps
 * every record so the evidence layer (not the caller) can separate them.
 */

const endpoint = 'https://kitsu.io/api/edge/manga';

const SUBTITLE_KINDS: Record<string, CatalogTitle['kind'] | undefined> = {
  en_jp: 'romaji',
  en: 'title',
  ja: 'title',
};

export function parseKitsuSearch(payload: unknown): CatalogWork[] {
  const data = asArray(asRecord(payload).data);
  const works: CatalogWork[] = [];
  for (const raw of data) {
    const record = asRecord(raw);
    const id = asString(record.id);
    const attributes = asRecord(record.attributes);
    if (id === undefined) continue;

    const titles: CatalogTitle[] = [];
    const seen = new Set<string>();
    const canonical = asString(attributes.canonicalTitle);
    if (canonical !== undefined) {
      seen.add(canonical.toLowerCase());
      titles.push({ value: canonical, kind: 'title' });
    }
    for (const [locale, rawValue] of Object.entries(asRecord(attributes.titles))) {
      const value = typeof rawValue === 'string' ? rawValue : undefined;
      const trimmed = value?.trim();
      const kind = SUBTITLE_KINDS[locale];
      if (trimmed === undefined || kind === undefined || seen.has(trimmed.toLowerCase())) continue;
      seen.add(trimmed.toLowerCase());
      titles.push(kind === 'romaji' ? { value: trimmed, kind } : { value: trimmed, kind, language: locale });
    }
    for (const abbreviated of asArray(attributes.abbreviatedTitles)) {
      const value = asString(abbreviated);
      if (value !== undefined && !seen.has(value.toLowerCase())) {
        seen.add(value.toLowerCase());
        titles.push({ value, kind: 'alias' });
      }
    }
    if (titles.length === 0) continue;

    const subtype = asString(attributes.subtype);
    works.push({
      providerId: `kitsu:${id}`,
      titles,
      creators: [],
      ...(subtype === undefined ? {} : { workKind: subtype === 'oneshot' ? 'oneshot' : 'series' }),
      externalIds: { kitsu: id },
    });
  }
  return works;
}

export function createKitsuProvider(fetchImpl: FetchLike): TitleCatalogProvider {
  return {
    key: 'kitsu',
    async lookup(query: TitleQuery, signal: AbortSignal): Promise<CatalogWork[]> {
      const url = `${endpoint}?filter%5Btext%5D=${encodeURIComponent(query.value)}&page%5Blimit%5D=5`;
      const payload = await fetchProviderJson('kitsu', url, signal, fetchImpl);
      return parseKitsuSearch(payload);
    },
  };
}
