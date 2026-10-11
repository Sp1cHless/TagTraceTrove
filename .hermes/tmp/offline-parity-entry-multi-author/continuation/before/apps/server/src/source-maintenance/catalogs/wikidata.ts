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
 * Wikidata — cross-language labels/aliases plus cross-catalog ID bridging.
 * Entity JSON: labels/aliases per language and claims such as P2003
 * (MangaDex ID), P4087 (?), P8729 — the property map below only bridges IDs
 * this project actually consumes and tolerates absence everywhere.
 */

const searchEndpoint = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=5&search=';
const entityEndpoint = 'https://www.wikidata.org/wiki/Special:EntityData/';

const EXTERNAL_ID_PROPERTIES: Record<string, string> = {
  P2003: 'mangadex',
  P10864: 'mangadex-volume',
  P4947: 'myanimelist',
  P4086: 'anilist',
  P5739: 'kitsu',
};

interface EntityPayload {
  entities?: Record<string, unknown>;
}

export function parseWikidataEntities(payload: unknown): CatalogWork[] {
  const entities = asRecord((payload as EntityPayload).entities ?? payload);
  const works: CatalogWork[] = [];
  for (const [entityId, raw] of Object.entries(entities)) {
    const entity = asRecord(raw);
    const labels = asRecord(entity.labels);
    const aliases = asRecord(entity.aliases);
    const titles: CatalogTitle[] = [];

    for (const [language, label] of Object.entries(labels)) {
      const value = asString(asRecord(label).value);
      if (value !== undefined) titles.push({ value, language, kind: 'title' });
    }
    for (const [language, entries] of Object.entries(aliases)) {
      for (const entry of asArray(entries)) {
        const value = asString(asRecord(entry).value);
        if (value !== undefined) titles.push({ value, language, kind: 'alias' });
      }
    }
    if (titles.length === 0) continue;

    const claims = asRecord(entity.claims);
    const externalIds: Record<string, string> = { wikidata: entityId };
    for (const [property, catalog] of Object.entries(EXTERNAL_ID_PROPERTIES)) {
      const statements = asArray(claims[property]);
      const value = asString(asRecord(asRecord(asRecord(statements[0]).mainsnak).datavalue).value);
      if (value !== undefined) externalIds[catalog] = value;
    }

    works.push({
      providerId: `wikidata:${entityId}`,
      titles,
      creators: [],
      externalIds,
    });
  }
  return works;
}

export function createWikidataProvider(fetchImpl: FetchLike): TitleCatalogProvider {
  return {
    key: 'wikidata',
    async lookup(query: TitleQuery, signal: AbortSignal): Promise<CatalogWork[]> {
      const searchUrl = `${searchEndpoint}${encodeURIComponent(query.value)}`;
      const searchPayload = await fetchProviderJson('wikidata', searchUrl, signal, fetchImpl);
      const ids = asArray(asRecord(searchPayload).search)
        .map((hit) => asString(asRecord(hit).id))
        .filter((id): id is string => id !== undefined)
        .slice(0, 3);
      if (ids.length === 0) return [];
      const entityUrl = `${entityEndpoint}${ids.join('|')}.json`;
      const entityPayload = await fetchProviderJson('wikidata', entityUrl, signal, fetchImpl);
      return parseWikidataEntities(entityPayload);
    },
  };
}
