import type { TaxonomyImportAlias, TaxonomyVocabulary } from './schemas/api.js';

/**
 * Parses a site-taxonomy dictionary JSON document into importable alias rows.
 *
 * The document is the SiteProbe tool's per-site dictionary, a map of sections to name pairs:
 *
 *   {
 *     "series":     { "Arknights Endfield": "明日方舟：终末地", "Other": "" },
 *     "characters": { "Ch'en": "陈" },
 *     "types":      { "Manga": "漫画" },
 *     "tags":       { "accepted": { "Ahegao": "阿黑颜" }, "rejected": [...] },
 *     "authors":    { "bob": "鲍勃", "alice": "" }
 *   }
 *
 * `authors` maps to the producer vocabulary and every other section to the entry vocabulary.
 *
 * **The sections do not become partitions.** They are how the three hand-written site adapters
 * happened to split what they found — hitomi and 18comic read a work's series, characters and tags
 * from different places on the page — and a generic adapter cannot: everything it reads is one field,
 * so every tag arrives together. Measured before this was dropped: a dictionary import put every new
 * name under `tags`, so the `characters` and `series` headings stopped receiving anything, and the
 * split they promised was never in the database anyway — the library's own classification is a Tag's
 * Facet, which the import learns from where the tag already lives. So the sections are flattened: the
 * dictionary is one list of names, and what a name *is* is decided by where it is used.
 *
 * Every name pair is kept, including blank ones (canonical `''`), which the UI shows as placeholders
 * to complete later — that is the queue of names nobody has decided about yet.
 */
export function parseTaxonomyDictionary(document: unknown): TaxonomyImportAlias[] {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error('Taxonomy dictionary must be a JSON object');
  }

  const entrySections = new Set(['series', 'characters', 'types', 'tags']);
  const mappings = new Map<string, TaxonomyImportAlias>();
  const addMappings = (
    vocabulary: TaxonomyVocabulary,
    values: Record<string, string>,
  ): void => {
    for (const [rawAlias, rawCanonical] of Object.entries(values)) {
      const alias = normalizeName(rawAlias);
      const canonicalName = normalizeName(rawCanonical);
      if (!alias) continue;
      if (canonicalName !== '' && normalized(alias) === normalized(canonicalName)) continue;
      const key = `${vocabulary}\u0000${normalized(alias)}`;
      if (!mappings.has(key)) {
        mappings.set(key, { vocabulary, alias, canonicalName });
      }
    }
  };

  for (const [rawSection, value] of Object.entries(document)) {
    const section = rawSection.normalize('NFKC').trim().toLocaleLowerCase();
    const vocabulary: TaxonomyVocabulary | null = section === 'authors'
      ? 'producer'
      : entrySections.has(section)
        ? 'entry'
        : null;
    if (vocabulary === null) continue;

    const direct = stringMap(value);
    if (direct) {
      addMappings(vocabulary, direct);
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const accepted = stringMap((value as Record<string, unknown>).accepted);
    if (accepted) addMappings(vocabulary, accepted);
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
