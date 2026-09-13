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
 * Bangumi (api.bgm.tv) — primary Chinese/Japanese alias evidence for manga
 * and anime. Search: POST /v0/search/subjects. Subjects carry `name`,
 * `name_cn` and (on detail) an `infobox` whose `别名` row lists translated
 * spellings. Requests must send a descriptive User-Agent (Bangumi policy).
 */

const endpoint = 'https://api.bgm.tv/v0/search/subjects';

export function parseBangumiSearch(payload: unknown): CatalogWork[] {
  const data = asArray(asRecord(payload).data);
  const works: CatalogWork[] = [];
  for (const raw of data) {
    const record = asRecord(raw);
    const id = asString(record.id);
    const name = asString(record.name);
    if (id === undefined || name === undefined) continue;
    const titles: CatalogTitle[] = [{ value: name, kind: 'title' }];
    const nameCn = asString(record.name_cn);
    if (nameCn !== undefined) titles.push({ value: nameCn, language: 'zh-CN', kind: 'alias' });

    const infobox = asArray(record.infobox);
    for (const entry of infobox) {
      const box = asRecord(entry);
      if (asString(box.key) !== '别名') continue;
      const value = box.value;
      if (typeof value === 'string') {
        const alias = asString(value);
        if (alias !== undefined) titles.push({ value: alias, kind: 'alias' });
      } else if (Array.isArray(value)) {
        for (const item of value) {
          const alias = asString(asRecord(item).v);
          if (alias !== undefined) titles.push({ value: alias, kind: 'alias' });
        }
      }
    }

    works.push({
      providerId: `bangumi:${id}`,
      titles,
      creators: [],
      externalIds: { bangumi: id },
    });
  }
  return works;
}

export function createBangumiProvider(fetchImpl: FetchLike): TitleCatalogProvider {
  return {
    key: 'bangumi',
    async lookup(query: TitleQuery, signal: AbortSignal): Promise<CatalogWork[]> {
      const payload = await fetchProviderJson('bangumi', endpoint, signal, fetchImpl, undefined, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Bangumi API policy requires a descriptive, fixed User-Agent.
          'user-agent': 'TagTraceTrove/0.1 (local collection index; contact set in server config)',
        },
        body: JSON.stringify({ keyword: query.value }),
      });
      return parseBangumiSearch(payload);
    },
  };
}
