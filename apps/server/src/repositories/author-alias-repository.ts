import { normalizeTag } from '@t3/shared';
import type { T3Database } from '../database/connection.js';
import { upsertTaxonomyAlias } from './taxonomy-repository.js';

/**
 * Author alias groups: one display name (显示名) plus every tag-name spelling
 * that must resolve to it — Japanese kana/kanji renderings, translated
 * Chinese, romaji/English, per-site variants. No schema change: a group is
 * stored as `taxonomy_aliases` rows of the `producer` vocabulary whose
 * canonical name IS the display name, so import-time resolution, the author
 * merge, and the faded alternate spellings under author names all reuse the
 * existing dictionary machinery. Merging existing duplicate producers after a
 * group is saved is driven by the route (plan/execute with backup), not here.
 */

export interface AuthorAliasName {
  id: number;
  name: string;
}

export interface AuthorAliasGroup {
  canonicalName: string;
  aliases: AuthorAliasName[];
  producerId: number | null;
  producerName: string | null;
}

export interface SaveAuthorAliasGroupInput {
  displayName: string;
  tagNames: string[];
}

interface AliasNameRow {
  id: number;
  alias_name: string;
  canonical_name: string;
  normalized_canonical: string;
}

function displayForm(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function listAuthorAliasGroups(database: T3Database): AuthorAliasGroup[] {
  const rows = database.prepare(`
    SELECT id, alias_name, canonical_name, normalized_canonical
    FROM taxonomy_aliases
    WHERE vocabulary = 'producer' AND normalized_canonical <> ''
    ORDER BY id
  `).all() as AliasNameRow[];

  const groups = new Map<string, AuthorAliasGroup>();
  for (const row of rows) {
    const group = groups.get(row.normalized_canonical) ?? {
      canonicalName: row.canonical_name,
      aliases: [],
      producerId: null,
      producerName: null,
    };
    group.aliases.push({ id: row.id, name: row.alias_name });
    groups.set(row.normalized_canonical, group);
  }

  // Attach the producer row the display name resolves to, when one exists.
  // Producers carry no normalized column, so match in JS (author counts are
  // small); first id wins on the pathological duplicate-name case.
  const producers = database.prepare('SELECT id, name FROM producers ORDER BY id')
    .all() as Array<{ id: number; name: string }>;
  const byNormalizedName = new Map<string, { id: number; name: string }>();
  for (const producer of producers) {
    const normalized = normalizeTag(producer.name);
    if (!byNormalizedName.has(normalized)) byNormalizedName.set(normalized, producer);
  }
  for (const group of groups.values()) {
    const producer = byNormalizedName.get(normalizeTag(group.canonicalName)) ?? null;
    group.producerId = producer?.id ?? null;
    group.producerName = producer?.name ?? null;
  }
  return [...groups.values()].sort((left, right) => (
    left.canonicalName.localeCompare(right.canonicalName, undefined, { sensitivity: 'base' })
  ));
}

/**
 * Writes one alias group (every tag name → display name) and returns the
 * refreshed group list. Tag names equal to the display name are skipped (they
 * carry no mapping); duplicate spellings are rejected so a typo cannot silently
 * drop one of the names.
 */
export function writeAuthorAliasGroup(
  database: T3Database,
  input: SaveAuthorAliasGroupInput,
): AuthorAliasGroup[] {
  const displayName = displayForm(input.displayName);
  if (!displayName) throw new Error('author alias display name cannot be empty');

  const seen = new Set<string>();
  const displayNormalized = normalizeTag(displayName);
  for (const tagName of input.tagNames) {
    const normalized = normalizeTag(displayForm(tagName));
    if (!normalized) continue;
    if (normalized === displayNormalized) continue; // display name itself, no mapping needed
    if (seen.has(normalized)) {
      throw new Error(`duplicate author tag name: ${tagName}`);
    }
    seen.add(normalized);
  }
  if (seen.size === 0) {
    throw new Error('an author alias group needs at least one tag name besides the display name');
  }

  database.transaction(() => {
    for (const tagName of input.tagNames) {
      const normalized = normalizeTag(displayForm(tagName));
      if (!normalized || normalized === displayNormalized || !seen.has(normalized)) continue;
      upsertTaxonomyAlias(database, {
        vocabulary: 'producer',
        partition: 'authors',
        alias: tagName,
        canonicalName: displayName,
      });
    }
  })();

  return listAuthorAliasGroups(database);
}
