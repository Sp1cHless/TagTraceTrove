import { normalizeTag } from '@t3/shared';
import type { T3Database } from '../database/connection.js';

/**
 * One-shot maintenance tooling to merge duplicate / dictionary-equivalent
 * author (producer) rows, used by `merge-producers-cli.ts`.
 *
 * Two merge rules:
 * 1. Identical names — producers whose normalized name (NFKC, trimmed,
 *    collapsed whitespace, lowercased — see `normalizeTag`) is the same are
 *    the same person and are merged into one row.
 * 2. Dictionary aliases — producer names that resolve through the 'producer'
 *    taxonomy vocabulary to a different canonical name ('bob' -> '鲍勃') are
 *    merged under (and renamed to) that canonical name, whatever language the
 *    alias spelling is in.
 *
 * No schema change: the alternates shown under an author's display name are
 * derived from the same taxonomy_aliases rows at render time.
 */

export interface ProducerMergeMember {
  id: number;
  name: string;
  workCount: number;
}

export interface ProducerMergePlan {
  /** Display name after merge. Null = no dictionary mapping involved; the keeper keeps its own name. */
  canonicalName: string | null;
  /** The row that survives; absorbs every member of `others`. */
  keeper: ProducerMergeMember;
  /** Rows to absorb into the keeper. */
  others: ProducerMergeMember[];
  /** Keeper's name will be rewritten to `canonicalName`. */
  renamed: boolean;
}

export interface ProducerMergeExecution {
  deletedProducers: number;
  worksRelinked: number;
  tagsRelinked: number;
  directoriesMoved: number;
  directoriesMerged: number;
  membershipsMoved: number;
  membershipsRemoved: number;
  renamedTo: string | null;
}

interface ProducerRow {
  id: number;
  name: string;
  work_count: number;
}

function displayName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function resolveProducerCanonical(
  aliases: ReadonlyMap<string, string>,
  name: string,
): string {
  let current = displayName(name);
  const visited = new Set<string>();
  for (;;) {
    const normalized = normalizeTag(current);
    if (visited.has(normalized)) {
      throw new Error(`taxonomy alias cycle detected for "${name}"`);
    }
    visited.add(normalized);
    const canonical = aliases.get(normalized);
    if (canonical === undefined) return current;
    current = canonical;
  }
}

function loadProducerAliases(database: T3Database): Map<string, string> {
  const aliases = new Map<string, string>();
  const rows = database.prepare(`
    SELECT normalized_alias, canonical_name
    FROM taxonomy_aliases
    WHERE vocabulary = 'producer' AND normalized_canonical <> ''
  `).all() as Array<{ normalized_alias: string; canonical_name: string }>;
  for (const row of rows) {
    aliases.set(row.normalized_alias, row.canonical_name);
  }
  return aliases;
}

function loadProducers(database: T3Database): ProducerRow[] {
  return database.prepare(`
    SELECT producer.id, producer.name,
      (SELECT COUNT(*) FROM entry_producers AS relation
       WHERE relation.producer_id = producer.id) AS work_count
    FROM producers AS producer
    ORDER BY producer.id
  `).all() as ProducerRow[];
}

export function planProducerMerges(database: T3Database): ProducerMergePlan[] {
  const aliases = loadProducerAliases(database);
  const producers = loadProducers(database);

  interface Accumulator {
    mapped: boolean;
    canonicalRaw: string | null;
    members: ProducerMergeMember[];
  }
  const groups = new Map<string, Accumulator>();

  for (const producer of producers) {
    const canonical = resolveProducerCanonical(aliases, producer.name);
    const normalizedCanonical = normalizeTag(canonical);
    const mapped = normalizeTag(canonical) !== normalizeTag(producer.name);
    const accumulator = groups.get(normalizedCanonical) ?? {
      mapped: false,
      canonicalRaw: null,
      members: [],
    };
    accumulator.mapped ||= mapped;
    if (mapped && accumulator.canonicalRaw === null) {
      accumulator.canonicalRaw = canonical;
    }
    accumulator.members.push({
      id: producer.id,
      name: producer.name,
      workCount: producer.work_count,
    });
    groups.set(normalizedCanonical, accumulator);
  }

  const plans: ProducerMergePlan[] = [];
  for (const accumulator of groups.values()) {
    const merged = accumulator.members.length > 1;
    if (!merged && !accumulator.mapped) continue;

    const canonicalName = accumulator.mapped ? accumulator.canonicalRaw : null;
    const exact = canonicalName === null
      ? undefined
      : accumulator.members.find((member) => member.name === canonicalName);
    const sorted = [...accumulator.members].sort((a, b) => (
      (b.workCount - a.workCount) || (a.id - b.id)
    ));
    const keeper = exact ?? sorted[0]!;
    const renamed = canonicalName !== null && keeper.name !== canonicalName;

    plans.push({
      canonicalName,
      keeper,
      others: accumulator.members.filter((member) => member.id !== keeper.id),
      renamed,
    });
  }

  return plans.sort((a, b) => (
    (a.canonicalName ?? a.keeper.name).localeCompare(
      b.canonicalName ?? b.keeper.name,
      undefined,
      { sensitivity: 'base' },
    )
  ));
}

/**
 * Executes plans. Must be called with a database where foreign keys are
 * temporarily OFF, because absorption re-points rows in an order that would
 * trip composite FKs mid-flight; integrity is re-verified afterwards with
 * `PRAGMA foreign_key_check` and `inspectDatabase` (doctor).
 */
export function executeProducerMerges(
  database: T3Database,
  plans: ProducerMergePlan[],
): ProducerMergeExecution[] {
  const executions: ProducerMergeExecution[] = [];

  database.transaction(() => {
    for (const plan of plans) {
      const { keeper, others, canonicalName, renamed } = plan;
      const execution: ProducerMergeExecution = {
        deletedProducers: 0,
        worksRelinked: 0,
        tagsRelinked: 0,
        directoriesMoved: 0,
        directoriesMerged: 0,
        membershipsMoved: 0,
        membershipsRemoved: 0,
        renamedTo: null,
      };

      for (const other of others) {
        // Directories whose title the keeper does not already use move to the
        // keeper as-is; colliding ones have their works absorbed into the
        // keeper's directory of the same title, then are deleted.
        const otherDirectories = database.prepare(`
          SELECT id, title
          FROM author_directories
          WHERE producer_id = ?
          ORDER BY id
        `).all(other.id) as Array<{ id: number; title: string }>;
        const keeperDirectories = database.prepare(`
          SELECT id, title
          FROM author_directories
          WHERE producer_id = ?
          ORDER BY id
        `).all(keeper.id) as Array<{ id: number; title: string }>;

        const moveDirectory = database.prepare(
          'UPDATE author_directories SET producer_id = ? WHERE id = ?',
        );
        const absorbDirectoryEntries = database.prepare(`
          INSERT OR IGNORE INTO author_directory_entries (directory_id, producer_id, entry_id, sort_order)
          SELECT ?, ?, entry_id, sort_order
          FROM author_directory_entries
          WHERE directory_id = ?
        `);
        const clearDirectory = database.prepare(
          'DELETE FROM author_directory_entries WHERE directory_id = ?',
        );
        const deleteDirectory = database.prepare(
          'DELETE FROM author_directories WHERE id = ?',
        );

        for (const directory of otherDirectories) {
          const target = keeperDirectories.find((candidate) => candidate.title === directory.title);
          if (target) {
            absorbDirectoryEntries.run(target.id, keeper.id, directory.id);
            clearDirectory.run(directory.id);
            deleteDirectory.run(directory.id);
            execution.directoriesMerged += 1;
          } else {
            moveDirectory.run(keeper.id, directory.id);
            execution.directoriesMoved += 1;
          }
        }

        // Works the keeper already curates stay in the keeper's own directory;
        // remaining memberships (under moved directories) transfer.
        const dropDuplicateMemberships = database.prepare(`
          DELETE FROM author_directory_entries
          WHERE producer_id = ?
            AND EXISTS (
              SELECT 1 FROM author_directory_entries
              WHERE producer_id = ? AND entry_id = author_directory_entries.entry_id
            )
        `);
        dropDuplicateMemberships.run(other.id, keeper.id);
        const membershipsRemoved = database.prepare(
          'SELECT changes() AS changes',
        ).get() as { changes: number };
        execution.membershipsRemoved += membershipsRemoved.changes;

        const moveMemberships = database.prepare(
          'UPDATE author_directory_entries SET producer_id = ? WHERE producer_id = ?',
        );
        moveMemberships.run(keeper.id, other.id);
        const membershipsMoved = database.prepare(
          'SELECT changes() AS changes',
        ).get() as { changes: number };
        execution.membershipsMoved += membershipsMoved.changes;

        const absorbEntryLinks = database.prepare(`
          INSERT OR IGNORE INTO entry_producers (entry_id, producer_id)
          SELECT entry_id, ? FROM entry_producers WHERE producer_id = ?
        `);
        absorbEntryLinks.run(keeper.id, other.id);
        const worksRelinked = database.prepare(
          'SELECT changes() AS changes',
        ).get() as { changes: number };
        execution.worksRelinked += worksRelinked.changes;
        database.prepare('DELETE FROM entry_producers WHERE producer_id = ?').run(other.id);

        const absorbTags = database.prepare(`
          INSERT OR IGNORE INTO producer_tag_assignments (producer_id, tag_id)
          SELECT ?, tag_id FROM producer_tag_assignments WHERE producer_id = ?
        `);
        absorbTags.run(keeper.id, other.id);
        const tagsRelinked = database.prepare(
          'SELECT changes() AS changes',
        ).get() as { changes: number };
        execution.tagsRelinked += tagsRelinked.changes;
        database.prepare('DELETE FROM producer_tag_assignments WHERE producer_id = ?').run(other.id);

        database.prepare('DELETE FROM producers WHERE id = ?').run(other.id);
        execution.deletedProducers += 1;
      }

      if (renamed && canonicalName !== null) {
        database.prepare(`
          UPDATE producers
          SET name = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(canonicalName, keeper.id);
        execution.renamedTo = canonicalName;
      }
      executions.push(execution);
    }
  })();

  return executions;
}
