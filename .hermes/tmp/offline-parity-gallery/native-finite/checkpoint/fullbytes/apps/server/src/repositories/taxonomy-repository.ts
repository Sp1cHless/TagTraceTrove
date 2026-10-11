import { normalizeTag } from '@t3/shared';
import type { T3Database } from '../database/connection.js';
import { toSimplified } from '../taxonomy/simplify.js';

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

/**
 * The key a name is identified by: normalised, **and simplified**.
 *
 * Exported because everything that compares two names has to agree with what is stored, and a
 * comparison written with `normalizeTag` alone reads a Traditional spelling as a different name here
 * while the dictionary treats it as the same one there. Measured on the author-alias group writer,
 * which skipped "the display name itself" by comparing un-simplified spellings: `海盜貓` looked like a
 * spelling to record, and recording it then failed as a mapping onto itself.
 */
export function taxonomyNameKey(value: string): string {
  return normalizeTag(toSimplified(displayName(value)));
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

/**
 * The name this spelling becomes: the alias's canonical, or the spelling itself, **simplified**.
 *
 * This is the one place that decides it, which is why the conversion lives here rather than at each
 * caller. A tag or author name arrives in one of three scripts — English, Traditional Chinese,
 * Simplified Chinese — and only Traditional → Simplified can be done without asking anybody: the same
 * language written two ways. So every name that comes through is simplified first, and an English
 * name is left exactly as it is for the dictionary to map. Without this, a site that spells its tags
 * in Traditional (measured on jable.tv, 2026-10-05: 24 of its 45 pending tags) put Traditional tags
 * straight into the library.
 *
 * The lookup is done on the simplified spelling too, so a dictionary row written in Traditional still
 * matches: the row's own key is simplified when it is written (`writeTaxonomyAlias`), and Traditional
 * and Simplified spellings of one name are therefore one row rather than two.
 */
export function resolveTaxonomyName(
  database: T3Database,
  vocabulary: TaxonomyVocabulary,
  value: string,
): string {
  let name = toSimplified(displayName(value));
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
  // A cycle stops the walk; it does not fail it.
  //
  // A row that points a name at itself — or two rows that point at each other — is a broken row, and
  // this used to throw. That turned one bad row into a **500 on every import of that site**, because
  // committing a work resolves every tag it carries: measured on a real library, a migration left 591
  // such rows behind and every import of that site failed with "taxonomy alias cycle detected" until
  // they were cleaned by hand. A dictionary must not be able to stop a work from being imported. The
  // walk returns the name it had reached when the loop closed — which is what those rows say, and
  // what a person reading the dictionary would expect to see.
  //
  // Refusing a *new* cycle is a different question, and that refusal is kept where it belongs: in
  // `writeTaxonomyAlias`, which resolves the chain it is about to close and refuses when it comes back
  // to the alias it is writing.
  return name;
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
 *
 * Both sides are stored **simplified**, which is what makes Traditional and Simplified spellings of
 * one name the same row instead of two: a row written as `乳膠衣` and a row written as `乳胶衣` share
 * one `normalized_alias`, so the second write updates the first. `resolveTaxonomyName` simplifies
 * what it is asked about, so this is the other half of that one decision.
 */
function writeTaxonomyAlias(
  database: T3Database,
  input: UpsertTaxonomyAliasInput,
  allowEmptyCanonical: boolean,
): TaxonomyAlias {
  const alias = toSimplified(displayName(input.alias));
  const normalizedAlias = taxonomyNameKey(input.alias);
  const partition = input.partition === undefined ? '' : displayName(input.partition);
  const requestedCanonical = toSimplified(displayName(input.canonicalName));
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

/** One name a bulk import passed over, and why. */
export interface TaxonomyAliasImportSkip {
  alias: string;
  reason: string;
}

export interface TaxonomyAliasImportResult {
  aliases: TaxonomyAlias[];
  skipped: TaxonomyAliasImportSkip[];
}

/**
 * Writes many alias rows, passing over the ones that cannot be written rather than failing on them.
 *
 * A bulk import is a *dictionary*, not a decision: it holds thousands of pairs from several sites, and
 * one pair contradicting the library must not take the other two thousand with it. Measured on a real
 * migration: a site's dictionary said `Bob → 鲍勃` while the library already said `鲍勃 → Bob`, the
 * cycle check threw, and the whole move answered 500 — with nothing said about which name was the
 * problem. The library keeps what it already has and the pair is reported.
 *
 * Two kinds are passed over:
 *
 * * a pair whose two sides are the same name — the built-in Traditional → Simplified conversion
 *   already covers it (`乳膠衣 → 乳胶衣`), and a row for it could never do anything. A migrated
 *   dictionary is full of them, because the tool filled them in itself;
 * * a pair the library contradicts, which is the `Bob → 鲍勃` case above.
 *
 * The manual single-row path (`upsertTaxonomyAlias`) still throws: there a person typed one pair and
 * should hear why it cannot be saved.
 */
export function importTaxonomyAliases(
  database: T3Database,
  inputs: Array<{
    vocabulary: TaxonomyVocabulary;
    partition?: string | undefined;
    alias: string;
    canonicalName: string;
  }>,
): TaxonomyAliasImportResult {
  return database.transaction(() => {
    const aliases: TaxonomyAlias[] = [];
    const skipped: TaxonomyAliasImportSkip[] = [];
    for (const input of inputs) {
      const alias = taxonomyNameKey(input.alias);
      const canonical = taxonomyNameKey(input.canonicalName);
      if (alias === '' || (canonical !== '' && alias === canonical)) {
        skipped.push({ alias: input.alias, reason: 'says nothing' });
        continue;
      }
      try {
        aliases.push(writeTaxonomyAlias(database, input, true));
      } catch (error) {
        skipped.push({
          alias: input.alias,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { aliases, skipped };
  })();
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
