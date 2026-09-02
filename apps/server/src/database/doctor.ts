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

  return { ok: issues.length === 0, issues };
}
