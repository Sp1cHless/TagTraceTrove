import type { T3Database } from './connection.js';

export interface DatabaseDoctorResult {
  ok: boolean;
  issues: string[];
}

interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

export function inspectDatabase(database: T3Database): DatabaseDoctorResult {
  const issues: string[] = [];
  const integrityRows = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
  for (const row of integrityRows) {
    if (row.integrity_check !== 'ok') {
      issues.push(`integrity check: ${row.integrity_check}`);
    }
  }

  const foreignKeyRows = database.pragma('foreign_key_check') as ForeignKeyViolation[];
  for (const row of foreignKeyRows) {
    issues.push(
      `foreign key violation: ${row.table} row ${row.rowid ?? 'without rowid'} -> ${row.parent} (${row.fkid})`,
    );
  }

  const invalidFacets = database.prepare(`
    SELECT child.id
    FROM tag_groups AS child
    LEFT JOIN tag_groups AS parent ON parent.id = child.parent_id
    WHERE child.group_kind = 'facet'
      AND (
        parent.id IS NULL OR
        parent.group_kind <> 'section' OR
        parent.entry_type <> child.entry_type
      )
  `).pluck().all() as number[];
  for (const id of invalidFacets) {
    issues.push(`invalid facet hierarchy: tag_groups ${id}`);
  }

  const sectionsMissingDefaultFacet = database.prepare(`
    SELECT section.id
    FROM tag_groups AS section
    WHERE section.group_kind = 'section'
      AND NOT EXISTS (
        SELECT 1
        FROM tag_groups AS facet
        WHERE facet.parent_id = section.id
          AND facet.group_kind = 'facet'
          AND facet.name = ''
      )
  `).pluck().all() as number[];
  for (const id of sectionsMissingDefaultFacet) {
    issues.push(`missing default facet: section ${id}`);
  }

  const invalidAssignments = database.prepare(`
    SELECT assignment.entry_id || ':' || assignment.tag_id
    FROM entry_tags AS assignment
    JOIN entries AS entry ON entry.id = assignment.entry_id
    LEFT JOIN tag_groups AS facet ON facet.id = assignment.facet_id
    WHERE facet.id IS NULL
       OR facet.group_kind <> 'facet'
       OR facet.entry_type <> entry.type
  `).pluck().all() as string[];
  for (const assignment of invalidAssignments) {
    issues.push(`invalid entry tag facet: ${assignment}`);
  }

  const invalidAuthorDirectoryEntries = database.prepare(`
    SELECT membership.directory_id || ':' || membership.entry_id
    FROM author_directory_entries AS membership
    LEFT JOIN author_directories AS directory
      ON directory.id = membership.directory_id
     AND directory.producer_id = membership.producer_id
    LEFT JOIN entry_producers AS relation
      ON relation.entry_id = membership.entry_id
     AND relation.producer_id = membership.producer_id
    WHERE directory.id IS NULL OR relation.entry_id IS NULL
  `).pluck().all() as string[];
  for (const membership of invalidAuthorDirectoryEntries) {
    issues.push(`invalid author directory membership: ${membership}`);
  }

  // A rating value must belong to a slot of its own subject kind; the plain
  // foreign keys only guarantee that the slot row exists.
  const invalidEntryRatings = database.prepare(`
    SELECT value.entry_id || ':' || value.slot_id
    FROM entry_rating_values AS value
    LEFT JOIN rating_slots AS slot ON slot.id = value.slot_id
      AND slot.subject_kind = 'entry'
    WHERE slot.id IS NULL
  `).pluck().all() as string[];
  for (const rating of invalidEntryRatings) {
    issues.push(`invalid entry rating slot: ${rating}`);
  }

  const invalidProducerRatings = database.prepare(`
    SELECT value.producer_id || ':' || value.slot_id
    FROM producer_rating_values AS value
    LEFT JOIN rating_slots AS slot ON slot.id = value.slot_id
      AND slot.subject_kind = 'producer'
    WHERE slot.id IS NULL
  `).pluck().all() as string[];
  for (const rating of invalidProducerRatings) {
    issues.push(`invalid producer rating slot: ${rating}`);
  }

  // Collections nest at most one level: a child folder can never be a parent.
  const nestedTooDeep = database.prepare(`
    SELECT child.id
    FROM collections AS child
    JOIN collections AS parent ON parent.id = child.parent_id
    WHERE parent.parent_id IS NOT NULL
  `).pluck().all() as number[];
  for (const id of nestedTooDeep) {
    issues.push(`collection nested too deep: collections ${id}`);
  }

  // Each member table must hang off a collection of its own kind.
  const invalidEntryMembers = database.prepare(`
    SELECT link.collection_id || ':' || link.entry_id
    FROM collection_entries AS link
    JOIN collections AS collection ON collection.id = link.collection_id
    WHERE collection.kind <> 'entry'
  `).pluck().all() as string[];
  for (const member of invalidEntryMembers) {
    issues.push(`invalid collection entry member: ${member}`);
  }

  const invalidProducerMembers = database.prepare(`
    SELECT link.collection_id || ':' || link.producer_id
    FROM collection_producers AS link
    JOIN collections AS collection ON collection.id = link.collection_id
    WHERE collection.kind <> 'producer'
  `).pluck().all() as string[];
  for (const member of invalidProducerMembers) {
    issues.push(`invalid collection producer member: ${member}`);
  }

  return { ok: issues.length === 0, issues };
}
