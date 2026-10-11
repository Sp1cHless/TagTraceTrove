import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeTag, parseTaxonomyDictionary } from '@t3/shared';

import type { T3Database } from '../database/connection.js';
import { importTaxonomyAliases } from '../repositories/taxonomy-repository.js';
import { toSimplified } from './simplify.js';

/**
 * Brings every site's dictionary into the library's own alias table — the one-time move.
 *
 * Each crawl writes `<export>/<group>/taxonomy_dictionary.json`, and until now that file was the only
 * place a name's translation lived: reachable by opening the tool's export tree, which is exactly
 * what nobody does any more, now that a work goes from a crawl to the library without a person
 * touching anything in between. Measured before this existed: seven sites' dictionaries on disk,
 * 207+290 accepted mappings and 1,340 author spellings on the two oldest — all of it stranded.
 *
 * What comes across is what a person **decided**: a pair whose canonical form is what the built-in
 * Traditional → Simplified conversion would produce anyway is passed over, so the dictionary keeps
 * only the mappings that carry information (usually English → Chinese). `rejected` is not read: those
 * tags never reach the library in the first place, and a "never create this" list is a different
 * feature from "this name means that name".
 *
 * It runs on demand rather than on every import, because after it runs there is nothing left to move:
 * the alias table is the dictionary from then on.
 */
export interface SiteDictionaryImportResult {
  /** Site groups whose dictionary was read. */
  sites: number;
  /** Alias rows written or updated. */
  imported: number;
  /** Of those, rows that are still waiting for a canonical name. */
  pending: number;
  /** Name pairs passed over because they said nothing. */
  skipped: number;
  /** Rows already in the library whose own spelling was re-written simplified. */
  rewritten: number;
  /** Rows that became the same name as another row and were folded into it. */
  merged: number;
  /**
   * Names a site's dictionary mapped one way while the library maps them the other.
   *
   * The library keeps its own answer — it is the one a person worked on — and these are named so the
   * disagreement is visible rather than silently resolved. Measured on a real migration: one such
   * pair used to fail the whole move with a 500 and name nothing.
   */
  conflicts: string[];
}

/**
 * Re-writes the rows that were stored before the library converted anything.
 *
 * A row's identity is its simplified spelling now, so a row written the old way — `乳膠衣 → 內衣`,
 * keyed on the Traditional form — stops being found the moment the lookup simplifies what it is asked
 * about: measured on a row of exactly that shape, both `乳膠衣` and `乳胶衣` came back as themselves
 * and the translation `內衣` was silently lost. Rows like that are in every library that imported a
 * dictionary by hand before this existed.
 *
 * Two rows can become one name (the same spelling entered both ways). One has to go, and the one that
 * carries a mapping is the one kept — a row that says nothing is worth less than a row that says
 * something. The count is reported rather than swallowed, because a folded row's mapping is gone.
 */
function simplifyStoredAliases(database: T3Database): { rewritten: number; merged: number } {
  const rows = database.prepare(`
    SELECT id, vocabulary, alias_name, canonical_name
    FROM taxonomy_aliases
  `).all() as Array<{
    id: number;
    vocabulary: string;
    alias_name: string;
    canonical_name: string;
  }>;

  const keep = new Map<string, { id: number; alias: string; canonical: string }>();
  const drop: number[] = [];
  for (const row of rows) {
    const alias = toSimplified(row.alias_name);
    const canonical = toSimplified(row.canonical_name);
    // A row that has become its own canonical is dropped, and this is not a nicety: it says nothing
    // (the built-in conversion already produces that name), and leaving it is worse than useless —
    // resolution follows it into a loop and throws, which is a 500 on *every* import of that site.
    // Measured on a real library: 591 such rows, made by this very pass, out of pairs like
    // `黃泉 → 黄泉` whose two sides became one name once the alias was simplified. A migrated
    // dictionary is full of them, because the tool filled every translation with its own t2s.
    if (canonical !== '' && normalizeTag(alias) === normalizeTag(canonical)) {
      drop.push(row.id);
      continue;
    }
    const key = `${row.vocabulary}\u0000${normalizeTag(alias)}`;
    const existing = keep.get(key);
    if (existing === undefined) {
      keep.set(key, { id: row.id, alias, canonical });
      continue;
    }
    const replacing = existing.canonical === '' && canonical !== '';
    if (replacing) drop.push(existing.id);
    else drop.push(row.id);
    if (replacing) keep.set(key, { id: row.id, alias, canonical });
  }

  const original = new Map(rows.map((row) => [row.id, row]));
  return database.transaction(() => {
    // The folded rows go **first**: a row about to be re-written to a spelling another row still holds
    // would collide with it on `UNIQUE (vocabulary, normalized_alias)` — measured on the two spellings
    // of one name, where the update ran before the delete and the whole move failed.
    for (const id of drop) {
      database.prepare('DELETE FROM taxonomy_aliases WHERE id = ?').run(id);
    }
    let rewritten = 0;
    for (const row of keep.values()) {
      const before = original.get(row.id);
      if (before === undefined) continue;
      if (before.alias_name === row.alias && before.canonical_name === row.canonical) continue;
      database.prepare(`
        UPDATE taxonomy_aliases
        SET alias_name = ?, normalized_alias = ?, canonical_name = ?, normalized_canonical = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(row.alias, normalizeTag(row.alias), row.canonical, normalizeTag(row.canonical), row.id);
      rewritten += 1;
    }
    return { rewritten, merged: drop.length };
  })();
}

export function importSiteDictionaries(
  database: T3Database,
  exportRoot: string,
): SiteDictionaryImportResult {
  const rows: Array<{
    vocabulary: 'entry' | 'producer';
    alias: string;
    canonicalName: string;
  }> = [];
  let sites = 0;
  let skipped = 0;

  let groups: string[];
  try {
    groups = readdirSync(exportRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No export tree at all is not a failure: it means nothing has been crawled on this machine.
    // The rows already in the library are still re-written: they need it whether or not a crawl has
    // happened on this machine, and that is the half that repairs a library which imported a
    // dictionary by hand before the conversion was built in.
    return {
      sites: 0, imported: 0, pending: 0, skipped: 0, conflicts: [],
      ...simplifyStoredAliases(database),
    };
  }

  for (const group of groups) {
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(join(exportRoot, group, 'taxonomy_dictionary.json'), 'utf8'));
    } catch {
      // A group with no dictionary (or an unreadable one) simply has nothing to bring across.
      continue;
    }
    sites += 1;
    for (const row of parseTaxonomyDictionary(document)) {
      // "Says nothing" means the canonical form is *exactly* what the built-in conversion produces
      // from the alias: the tool filled those in itself, and the library computes them itself now.
      // Compared simplified, not as strings — `JoJo的奇妙冒險 → JoJo的奇妙冒险` differs character by
      // character and is still the same pair.
      const same = row.canonicalName !== '' && row.canonicalName === toSimplified(row.alias);
      if (same) {
        skipped += 1;
        continue;
      }
      // A producer name with no canonical is not carried across. Measured on this machine: the
      // `authors` section of all seven dictionaries holds 1,340 spellings and **not one** translation,
      // and `listAuthorAliasGroups` shows nothing at all for a row whose canonical is empty — so
      // importing them would add 1,340 rows that no page displays and no resolution reads. An entry
      // name with no canonical is different: that *is* the queue the dictionary page exists to work
      // through, and it is a handful of names rather than a thousand.
      if (row.vocabulary === 'producer' && row.canonicalName === '') {
        skipped += 1;
        continue;
      }
      rows.push({ vocabulary: row.vocabulary, alias: row.alias, canonicalName: row.canonicalName });
    }
  }

  // The rows already there first, so a name that is both stored and being imported is written once,
  // in its final form.
  const { rewritten, merged } = simplifyStoredAliases(database);
  const written = importTaxonomyAliases(database, rows);
  return {
    sites,
    imported: written.aliases.length,
    pending: written.aliases.filter((alias) => alias.canonicalName === '').length,
    // Both kinds of "not written": a pair that says nothing, and one the library contradicts.
    skipped: skipped + written.skipped.length,
    conflicts: written.skipped
      .filter((skip) => skip.reason !== 'says nothing')
      .map((skip) => skip.alias),
    rewritten,
    merged,
  };
}
