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
 * MangaDex — multilingual altTitles with explicit `ja-ro` (romaji) keys,
 * original language, status, content rating and Author/Artist relations.
 * Search: GET /manga?title=...&limit=8&includes%5B%5D=author&includes%5B%5D=artist.
 */

const endpoint = 'https://api.mangadex.org/manga';

interface MangaDexTitleMap {
  [locale: string]: string | undefined;
}

function collectTitles(
  title: MangaDexTitleMap,
  altTitles: Array<MangaDexTitleMap>,
): CatalogTitle[] {
  const titles: CatalogTitle[] = [];
  const seen = new Set<string>();
  for (const [locale, value] of Object.entries(title)) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    seen.add(trimmed.toLowerCase());
    titles.push({
      value: trimmed,
      ...(locale === 'ja-ro' ? { kind: 'romaji' as const } : { kind: 'title' as const, language: locale }),
    });
  }
  for (const alt of altTitles) {
    for (const [locale, value] of Object.entries(alt)) {
      const trimmed = value?.trim();
      if (!trimmed) continue;
      const kind = locale === 'ja-ro' ? 'romaji' as const : 'alias' as const;
      if (seen.has(trimmed.toLowerCase())) continue;
      seen.add(trimmed.toLowerCase());
      titles.push(kind === 'romaji' ? { value: trimmed, kind } : { value: trimmed, kind, language: locale });
    }
  }
  return titles;
}

export function parseMangaDexSearch(payload: unknown): CatalogWork[] {
  const data = asArray(asRecord(payload).data);
  const works: CatalogWork[] = [];
  for (const raw of data) {
    const record = asRecord(raw);
    const id = asString(record.id);
    const attributes = asRecord(record.attributes);
    if (id === undefined) continue;
    const titles = collectTitles(
      Object.fromEntries(Object.entries(asRecord(attributes.title)).map(([key, value]) => [key, asString(value) ?? ''])),
      asArray(attributes.altTitles).map((entry) => (
        Object.fromEntries(Object.entries(asRecord(entry)).map(([key, value]) => [key, asString(value) ?? '']))
      )),
    );
    if (titles.length === 0) continue;

    const creators: string[] = [];
    for (const relationship of asArray(record.relationships)) {
      const relation = asRecord(relationship);
      const kind = asString(relation.type);
      if (kind !== 'author' && kind !== 'artist') continue;
      const name = asString(asRecord(relation.attributes).name);
      if (name !== undefined && !creators.includes(name)) creators.push(name);
    }

    const tags = asArray(attributes.tags)
      .map((tag) => {
        const name = asRecord(asRecord(tag).attributes).name;
        return typeof name === 'string' ? asString(name) : asString(asRecord(name).en);
      })
      .filter((name): name is string => name !== undefined);
    const workKind = tags.includes('Oneshot') ? 'oneshot' : 'series';

    works.push({
      providerId: `mangadex:${id}`,
      titles,
      creators,
      workKind,
      externalIds: { mangadex: id },
    });
  }
  return works;
}

export function createMangaDexProvider(fetchImpl: FetchLike): TitleCatalogProvider {
  return {
    key: 'mangadex',
    async lookup(query: TitleQuery, signal: AbortSignal): Promise<CatalogWork[]> {
      const url = `${endpoint}?title=${encodeURIComponent(query.value)}&limit=8&includes%5B%5D=author&includes%5B%5D=artist`;
      const payload = await fetchProviderJson('mangadex', url, signal, fetchImpl);
      return parseMangaDexSearch(payload);
    },
  };
}
