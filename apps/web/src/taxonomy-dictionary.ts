import type { TaxonomyImportAlias, TaxonomyVocabulary } from '@t3/shared';

/**
 * Parses a site-taxonomy dictionary JSON document into importable alias rows.
 *
 * The document is a map of partition sections to name pairs, mirroring the
 * tag taxonomy buckets the site groups names into:
 *
 *   {
 *     "series":     { "Arknights Endfield": "明日方舟：终末地", "Other": "" },
 *     "characters": { "Ch'en": "陈" },
 *     "types":      { "Manga": "漫画" },
 *     "tags":       { "accepted": { "Ahegao": "阿黑颜" }, "rejected": [...] },
 *     "authors":    { "bob": "鲍勃", "alice": "" }
 *   }
 *
 * Every name pair is kept — including blank ones (canonical `''`), which the
 * UI shows as placeholders to complete later. Section `authors` maps to the
 * producer vocabulary; the entry partitions (series/characters/types/tags)
 * map to the entry vocabulary with the section name as partition.
 */
export function parseTaxonomyDictionary(document: unknown): TaxonomyImportAlias[] {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error('Taxonomy dictionary must be a JSON object');
  }

  const entryPartitions = new Map<string, string>([
    ['series', 'series'],
    ['characters', 'characters'],
    ['types', 'types'],
    ['tags', 'tags'],
  ]);

  const mappings = new Map<string, TaxonomyImportAlias>();
  const addMappings = (
    vocabulary: TaxonomyVocabulary,
    partition: string,
    values: Record<string, string>,
  ): void => {
    for (const [rawAlias, rawCanonical] of Object.entries(values)) {
      const alias = normalizeName(rawAlias);
      const canonicalName = normalizeName(rawCanonical);
      if (!alias) continue;
      if (canonicalName !== '' && normalized(alias) === normalized(canonicalName)) continue;
      const key = `${vocabulary}\u0000${normalized(alias)}`;
      if (!mappings.has(key)) {
        mappings.set(key, { vocabulary, partition, alias, canonicalName });
      }
    }
  };

  for (const [rawSection, value] of Object.entries(document)) {
    const section = rawSection.normalize('NFKC').trim().toLocaleLowerCase();
    const vocabulary: TaxonomyVocabulary | null = section === 'authors'
      ? 'producer'
      : entryPartitions.has(section)
        ? 'entry'
        : null;
    if (vocabulary === null) continue;
    const partition = section === 'authors' ? 'authors' : entryPartitions.get(section)!;

    const direct = stringMap(value);
    if (direct) {
      addMappings(vocabulary, partition, direct);
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const accepted = stringMap((value as Record<string, unknown>).accepted);
    if (accepted) addMappings(vocabulary, partition, accepted);
  }

  return [...mappings.values()];
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function normalized(value: string): string {
  return normalizeName(value).toLocaleLowerCase();
}

function stringMap(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, candidate]) => typeof candidate !== 'string')) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}
