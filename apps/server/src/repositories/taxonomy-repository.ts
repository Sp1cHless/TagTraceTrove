import { normalizeTag } from '@t3/shared';
import type { T3Database } from '../database/connection.js';

export type TaxonomyVocabulary = 'entry' | 'producer';

export interface TaxonomyAlias {
  id: number;
  vocabulary: TaxonomyVocabulary;
  partition: string;
  alias: string;
  normalizedAlias: string;
  canonicalName: string;
  normalizedCanonical: string;
}

export interface UpsertTaxonomyAliasInput {
  vocabulary: TaxonomyVocabulary;
  /** Dictionary partition label ('' = unpartitioned). */
  partition?: string | undefined;
  alias: string;
  /** Empty canonical = placeholder row (recorded name, not yet mapped). */
  canonicalName: string;
}

interface AliasRow {
  id: number;
  vocabulary: TaxonomyVocabulary;
  partition: string;
  alias_name: string;
  normalized_alias: string;
  canonical_name: string;
  normalized_canonical: string;
}

const aliasColumns = `
  id, vocabulary, partition, alias_name, normalized_alias,
  canonical_name, normalized_canonical
`;

function displayName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function aliasFromRow(row: AliasRow): TaxonomyAlias {
  return {
    id: row.id,
    vocabulary: row.vocabulary,
    partition: row.partition,
    alias: row.alias_name,
    normalizedAlias: row.normalized_alias,
    canonicalName: row.canonical_name,
    normalizedCanonical: row.normalized_canonical,
  };
}

export function resolveTaxonomyName(
  database: T3Database,
  vocabulary: TaxonomyVocabulary,
  value: string,
): string {
  let name = displayName(value);
  let normalized = normalizeTag(name);
  const visited = new Set<string>();
  while (!visited.has(normalized)) {
    visited.add(normalized);
    const row = database.prepare(`
      SELECT canonical_name, normalized_canonical
      FROM taxonomy_aliases
      WHERE vocabulary = ? AND normalized_alias = ?
        AND normalized_canonical <> ''
    `).get(vocabulary, normalized) as {
      canonical_name: string;
      normalized_canonical: string;
    } | undefined;
    if (!row) return name;
    name = row.canonical_name;
    normalized = row.normalized_canonical;
  }
  throw new Error('taxonomy alias cycle detected');
}

function mergeEntryTags(
  database: T3Database,
  aliasNormalized: string,
  canonicalName: string,
  canonicalNormalized: string,
): void {
  const sourceId = database.prepare('SELECT id FROM tags WHERE normalized_name = ?')
    .pluck().get(aliasNormalized) as number | undefined;
  if (sourceId === undefined || aliasNormalized === canonicalNormalized) return;

  database.prepare(`
    INSERT INTO tags (name, normalized_name)
    VALUES (?, ?)
    ON CONFLICT(normalized_name) DO NOTHING
  `).run(canonicalName, canonicalNormalized);
  const targetId = database.prepare('SELECT id FROM tags WHERE normalized_name = ?')
    .pluck().get(canonicalNormalized) as number;
  database.prepare(`
    DELETE FROM entry_tags AS source
    WHERE source.tag_id = ?
      AND EXISTS (
        SELECT 1 FROM entry_tags AS target
        WHERE target.entry_id = source.entry_id AND target.tag_id = ?
      )
  `).run(sourceId, targetId);
  database.prepare('UPDATE entry_tags SET tag_id = ? WHERE tag_id = ?').run(targetId, sourceId);
  database.prepare('DELETE FROM tags WHERE id = ?').run(sourceId);
}

function mergeProducerTags(
  database: T3Database,
  aliasNormalized: string,
  canonicalName: string,
  canonicalNormalized: string,
): void {
  const sourceId = database.prepare('SELECT id FROM producer_tags WHERE normalized_name = ?')
    .pluck().get(aliasNormalized) as number | undefined;
  if (sourceId === undefined || aliasNormalized === canonicalNormalized) return;

  database.prepare(`
    INSERT INTO producer_tags (name, normalized_name)
    VALUES (?, ?)
    ON CONFLICT(normalized_name) DO NOTHING
  `).run(canonicalName, canonicalNormalized);
  const targetId = database.prepare('SELECT id FROM producer_tags WHERE normalized_name = ?')
    .pluck().get(canonicalNormalized) as number;
  database.prepare(`
    DELETE FROM producer_tag_assignments AS source
    WHERE source.tag_id = ?
      AND EXISTS (
        SELECT 1 FROM producer_tag_assignments AS target
        WHERE target.producer_id = source.producer_id AND target.tag_id = ?
      )
  `).run(sourceId, targetId);
  database.prepare('UPDATE producer_tag_assignments SET tag_id = ? WHERE tag_id = ?')
    .run(targetId, sourceId);
  database.prepare('DELETE FROM producer_tags WHERE id = ?').run(sourceId);
}

function readAlias(
  database: T3Database,
  vocabulary: TaxonomyVocabulary,
  normalizedAlias: string,
): TaxonomyAlias | null {
  const row = database.prepare(`
    SELECT ${aliasColumns}
    FROM taxonomy_aliases
    WHERE vocabulary = ? AND normalized_alias = ?
  `).get(vocabulary, normalizedAlias) as AliasRow | undefined;
  return row === undefined ? null : aliasFromRow(row);
}

/**
 * Writes one alias row. With a non-empty canonical name this merges existing
 * matching Tags/assignments and re-points other aliases (the historical
 * behavior). With an empty canonical name (`allowEmptyCanonical`) it records a
 * placeholder row only: never downgrades an already-completed mapping, and
 * placeholders are skipped by `resolveTaxonomyName` until they are filled.
 */
function writeTaxonomyAlias(
  database: T3Database,
  input: UpsertTaxonomyAliasInput,
  allowEmptyCanonical: boolean,
): TaxonomyAlias {
  const alias = displayName(input.alias);
  const normalizedAlias = normalizeTag(alias);
  const partition = input.partition === undefined ? '' : displayName(input.partition);
  const requestedCanonical = displayName(input.canonicalName);
  const requestedNormalizedCanonical = normalizeTag(requestedCanonical);
  if (!normalizedAlias) {
    throw new Error('taxonomy alias names cannot be empty');
  }
  if (!requestedNormalizedCanonical) {
    if (!allowEmptyCanonical) {
      throw new Error('taxonomy alias names cannot be empty');
    }
    return database.transaction(() => {
      const existing = readAlias(database, input.vocabulary, normalizedAlias);
      if (existing !== null && existing.normalizedCanonical !== '') {
        return existing;
      }
      database.prepare(`
        INSERT INTO taxonomy_aliases (
          vocabulary, partition, alias_name, normalized_alias,
          canonical_name, normalized_canonical
        ) VALUES (?, ?, ?, ?, '', '')
        ON CONFLICT(vocabulary, normalized_alias) DO UPDATE SET
          alias_name = excluded.alias_name,
          partition = excluded.partition,
          updated_at = CURRENT_TIMESTAMP
      `).run(input.vocabulary, partition, alias, normalizedAlias);
      return readAlias(database, input.vocabulary, normalizedAlias)!;
    })();
  }

  return database.transaction(() => {
    const canonicalName = resolveTaxonomyName(database, input.vocabulary, requestedCanonical);
    const normalizedCanonical = normalizeTag(canonicalName);
    if (normalizedAlias === normalizedCanonical) {
      throw new Error('taxonomy alias must differ from its canonical name');
    }
    const reverse = resolveTaxonomyName(database, input.vocabulary, canonicalName);
    if (normalizeTag(reverse) === normalizedAlias) {
      throw new Error('taxonomy alias cycle detected');
    }

    database.prepare(`
      INSERT INTO taxonomy_aliases (
        vocabulary, partition, alias_name, normalized_alias,
        canonical_name, normalized_canonical
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(vocabulary, normalized_alias) DO UPDATE SET
        alias_name = excluded.alias_name,
        partition = excluded.partition,
        canonical_name = excluded.canonical_name,
        normalized_canonical = excluded.normalized_canonical,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      input.vocabulary,
      partition,
      alias,
      normalizedAlias,
      canonicalName,
      normalizedCanonical,
    );
    database.prepare(`
      UPDATE taxonomy_aliases
      SET canonical_name = ?, normalized_canonical = ?, updated_at = CURRENT_TIMESTAMP
      WHERE vocabulary = ? AND normalized_canonical = ? AND normalized_alias <> ?
    `).run(canonicalName, normalizedCanonical, input.vocabulary, normalizedAlias, normalizedAlias);

    if (input.vocabulary === 'entry') {
      mergeEntryTags(database, normalizedAlias, canonicalName, normalizedCanonical);
    } else {
      mergeProducerTags(database, normalizedAlias, canonicalName, normalizedCanonical);
    }

    return readAlias(database, input.vocabulary, normalizedAlias)!;
  })();
}

export function upsertTaxonomyAlias(
  database: T3Database,
  input: UpsertTaxonomyAliasInput,
): TaxonomyAlias {
  return writeTaxonomyAlias(database, input, false);
}

export function importTaxonomyAliases(
  database: T3Database,
  inputs: Array<{
    vocabulary: TaxonomyVocabulary;
    partition?: string | undefined;
    alias: string;
    canonicalName: string;
  }>,
): TaxonomyAlias[] {
  return database.transaction(() => (
    inputs.map((input) => writeTaxonomyAlias(database, input, true))
  ))();
}

export function listTaxonomyAliases(
  database: T3Database,
  vocabulary?: TaxonomyVocabulary,
): TaxonomyAlias[] {
  const rows = database.prepare(`
    SELECT ${aliasColumns}
    FROM taxonomy_aliases
    ${vocabulary === undefined ? '' : 'WHERE vocabulary = ?'}
    ORDER BY vocabulary, partition, normalized_alias, id
  `).all(...(vocabulary === undefined ? [] : [vocabulary])) as AliasRow[];
  return rows.map(aliasFromRow);
}

export function deleteTaxonomyAlias(database: T3Database, id: number): void {
  const result = database.prepare('DELETE FROM taxonomy_aliases WHERE id = ?').run(id);
  if (result.changes === 0) throw new Error('taxonomy alias not found');
}
