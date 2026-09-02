import type { T3Database } from '../database/connection.js';

export interface CreateSectionInput {
  entryType: string;
  name: string;
  sortOrder?: number | undefined;
}

export interface CreatedSection {
  id: number;
  entryType: string;
  name: string;
  sortOrder: number;
  defaultFacetId: number;
}

export interface CreateFacetInput {
  sectionId: number;
  name: string;
  sortOrder?: number | undefined;
}

export interface LayoutFacet {
  id: number;
  name: string;
  sortOrder: number;
}

export interface CreatedFacet extends LayoutFacet {
  sectionId: number;
}

export interface LayoutSection {
  id: number;
  name: string;
  sortOrder: number;
  facets: LayoutFacet[];
}

interface LayoutRow {
  section_id: number;
  section_name: string;
  section_sort_order: number;
  facet_id: number;
  facet_name: string;
  facet_sort_order: number;
}

export function createSection(
  database: T3Database,
  input: CreateSectionInput,
): CreatedSection {
  const entryType = input.entryType.trim();
  const name = input.name.trim();
  const sortOrder = input.sortOrder ?? 0;

  return database.transaction(() => {
    const sectionResult = database.prepare(`
      INSERT INTO tag_groups (entry_type, name, group_kind, sort_order)
      VALUES (?, ?, 'section', ?)
    `).run(entryType, name, sortOrder);
    const sectionId = Number(sectionResult.lastInsertRowid);

    const facetResult = database.prepare(`
      INSERT INTO tag_groups (entry_type, name, group_kind, parent_id, sort_order)
      VALUES (?, '', 'facet', ?, 0)
    `).run(entryType, sectionId);

    return {
      id: sectionId,
      entryType,
      name,
      sortOrder,
      defaultFacetId: Number(facetResult.lastInsertRowid),
    };
  })();
}

export function createFacet(
  database: T3Database,
  input: CreateFacetInput,
): CreatedFacet {
  const name = input.name.trim();
  if (name === '') {
    throw new Error('named facet cannot have an empty name');
  }

  const section = database.prepare(`
    SELECT entry_type
    FROM tag_groups
    WHERE id = ? AND group_kind = 'section'
  `).get(input.sectionId) as { entry_type: string } | undefined;
  if (!section) {
    throw new Error('section not found');
  }

  const sortOrder = input.sortOrder ?? 0;
  const result = database.prepare(`
    INSERT INTO tag_groups (entry_type, name, group_kind, parent_id, sort_order)
    VALUES (?, ?, 'facet', ?, ?)
  `).run(section.entry_type, name, input.sectionId, sortOrder);

  return {
    id: Number(result.lastInsertRowid),
    sectionId: input.sectionId,
    name,
    sortOrder,
  };
}

export function renameTagGroup(database: T3Database, groupId: number, name: string): void {
  const trimmedName = name.trim();
  const group = database.prepare(`
    SELECT group_kind, name
    FROM tag_groups
    WHERE id = ?
  `).get(groupId) as { group_kind: 'section' | 'facet'; name: string } | undefined;
  if (!group) {
    throw new Error('tag group not found');
  }
  if (trimmedName === '') {
    throw new Error('tag group name cannot be empty');
  }
  if (group.group_kind === 'facet' && group.name === '') {
    throw new Error('cannot rename the default facet');
  }

  database.prepare(`
    UPDATE tag_groups
    SET name = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(trimmedName, groupId);
}

export function reorderTagGroup(
  database: T3Database,
  groupId: number,
  sortOrder: number,
): void {
  const result = database.prepare(`
    UPDATE tag_groups
    SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(sortOrder, groupId);
  if (result.changes === 0) {
    throw new Error('tag group not found');
  }
}

export function reorderSectionFacets(
  database: T3Database,
  sectionId: number,
  orderedFacetIds: number[],
): void {
  database.transaction(() => {
    const sectionExists = database.prepare(`
      SELECT 1
      FROM tag_groups
      WHERE id = ? AND group_kind = 'section'
    `).pluck().get(sectionId);
    if (sectionExists !== 1) {
      throw new Error('section not found');
    }

    const currentIds = database.prepare(`
      SELECT id
      FROM tag_groups
      WHERE parent_id = ? AND group_kind = 'facet'
    `).pluck().all(sectionId) as number[];
    const supplied = new Set(orderedFacetIds);
    const valid = supplied.size === orderedFacetIds.length
      && currentIds.length === orderedFacetIds.length
      && currentIds.every((id) => supplied.has(id));
    if (!valid) {
      throw new Error('facet reorder must include every facet for the section exactly once');
    }

    const update = database.prepare(`
      UPDATE tag_groups
      SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND parent_id = ?
    `);
    orderedFacetIds.forEach((facetId, index) => {
      update.run(index, facetId, sectionId);
    });
  })();
}

export function deleteFacet(database: T3Database, facetId: number): void {
  const facet = database.prepare(`
    SELECT name, entry_type
    FROM tag_groups
    WHERE id = ? AND group_kind = 'facet'
  `).get(facetId) as { name: string; entry_type: string } | undefined;
  if (!facet) {
    throw new Error('facet not found');
  }
  if (facet.name === '') {
    throw new Error('cannot delete the default facet');
  }

  database.transaction(() => {
    // Tags assigned to the removed Facet move to the type's canonical
    // "unassigned" spot: the Tags Section's default Facet, or the first
    // Section's default Facet when no Tags Section exists.
    const targetId = canonicalDefaultFacetId(database, facet.entry_type);
    if (targetId !== null && targetId !== facetId) {
      database.prepare(
        'UPDATE entry_tags SET facet_id = ? WHERE facet_id = ?',
      ).run(targetId, facetId);
    }
    database.prepare('DELETE FROM tag_groups WHERE id = ?').run(facetId);
  })();
}

/** The unnamed default Facet of the 'Tags' Section for a type, else the first Section's. */
function canonicalDefaultFacetId(database: T3Database, entryType: string): number | null {
  const rows = database.prepare(`
    SELECT section.name AS section_name, facet.id AS facet_id
    FROM tag_groups AS facet
    JOIN tag_groups AS section ON section.id = facet.parent_id
    WHERE facet.group_kind = 'facet'
      AND facet.name = ''
      AND section.group_kind = 'section'
      AND section.entry_type = ?
    ORDER BY section.sort_order, section.id
  `).all(entryType) as Array<{ section_name: string; facet_id: number }>;
  if (rows.length === 0) return null;
  const tagsRow = rows.find((row) => normalizedGroupName(row.section_name) === 'tags');
  return (tagsRow ?? rows[0]!)!.facet_id;
}

export function deleteSection(database: T3Database, sectionId: number): void {
  const sectionExists = database.prepare(`
    SELECT 1
    FROM tag_groups
    WHERE id = ? AND group_kind = 'section'
  `).pluck().get(sectionId);
  if (sectionExists !== 1) {
    throw new Error('section not found');
  }

  const assignmentCount = database.prepare(`
    SELECT COUNT(*)
    FROM entry_tags AS assignment
    JOIN tag_groups AS facet ON facet.id = assignment.facet_id
    WHERE facet.parent_id = ?
  `).pluck().get(sectionId) as number;
  if (assignmentCount > 0) {
    throw new Error('cannot delete a section that contains assigned tags');
  }

  database.prepare('DELETE FROM tag_groups WHERE id = ?').run(sectionId);
}

export function listLayout(database: T3Database, entryType: string): LayoutSection[] {
  const rows = database.prepare(`
    SELECT
      section.id AS section_id,
      section.name AS section_name,
      section.sort_order AS section_sort_order,
      facet.id AS facet_id,
      facet.name AS facet_name,
      facet.sort_order AS facet_sort_order
    FROM tag_groups AS section
    JOIN tag_groups AS facet ON facet.parent_id = section.id
    WHERE section.group_kind = 'section'
      AND facet.group_kind = 'facet'
      AND section.entry_type = ?
    ORDER BY section.sort_order, section.id, facet.sort_order, facet.id
  `).all(entryType.trim()) as LayoutRow[];

  const sections = new Map<number, LayoutSection>();
  for (const row of rows) {
    let section = sections.get(row.section_id);
    if (!section) {
      section = {
        id: row.section_id,
        name: row.section_name,
        sortOrder: row.section_sort_order,
        facets: [],
      };
      sections.set(row.section_id, section);
    }
    section.facets.push({
      id: row.facet_id,
      name: row.facet_name,
      sortOrder: row.facet_sort_order,
    });
  }

  return [...sections.values()];
}

export interface LayoutTemplateApplyResult {
  entryType: string;
  entriesAffected: number;
  tagsRelinked: number;
  orphansMoved: number;
  sectionsRecreated: number;
}

function normalizedGroupName(name: string): string {
  return name.normalize('NFKC').trim().toLocaleLowerCase();
}

/**
 * Rebuilds the shared layout for the source Entry's type from its current
 * Section/Facet structure (names and order), then re-maps every Entry's tag
 * assignments onto the rebuilt Facets by (Section name, Facet name) with
 * case/width-insensitive comparison. Duplicate Facet spellings inside one
 * Section (e.g. `characters` next to `Characters`) collapse into the first
 * occurrence. Tags whose old Facet no longer exists in the template move to
 * the Tags Section's default Facet (falling back to the first Section's
 * default Facet). Template Facets without tags stay empty.
 *
 * Runs inside one transaction: existing sections are renamed aside first so
 * the rebuilt rows can take the canonical names, all assignments are re-mapped
 * (both old and new Facet rows exist throughout, so FK constraints hold), and
 * only then are the old layout rows deleted.
 */
export function applyLayoutTemplate(
  database: T3Database,
  sourceEntryId: number,
): LayoutTemplateApplyResult {
  const entry = database.prepare('SELECT id, type FROM entries WHERE id = ?')
    .get(sourceEntryId) as { id: number; type: string } | undefined;
  if (!entry) {
    throw new Error('entry not found');
  }
  const entryType = entry.type.trim();

  const template = listLayout(database, entryType);
  if (template.length === 0) {
    throw new Error(`no layout exists for entry type "${entryType}"`);
  }

  return database.transaction(() => {
    const oldRows = database.prepare(`
      SELECT
        section.id AS section_id,
        section.name AS section_name,
        facet.id AS facet_id,
        facet.name AS facet_name
      FROM tag_groups AS section
      LEFT JOIN tag_groups AS facet
        ON facet.parent_id = section.id AND facet.group_kind = 'facet'
      WHERE section.group_kind = 'section'
        AND section.entry_type = ?
      ORDER BY section.sort_order, section.id, facet.sort_order, facet.id
    `).all(entryType) as Array<{
      section_id: number;
      section_name: string;
      facet_id: number | null;
      facet_name: string | null;
    }>;

    const oldSectionIds = [...new Set(oldRows.map((row) => row.section_id))];

    // Rename existing sections aside so the rebuilt rows may take the
    // canonical names without hitting the unique (entry_type, name) index.
    const renameSection = database.prepare(
      'UPDATE tag_groups SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    );
    oldSectionIds.forEach((sectionId, index) => {
      renameSection.run(`__t3_template_${index}__`, sectionId);
    });

    const insertSection = database.prepare(`
      INSERT INTO tag_groups (entry_type, name, group_kind, sort_order)
      VALUES (?, ?, 'section', ?)
    `);
    const insertFacet = database.prepare(`
      INSERT INTO tag_groups (entry_type, name, group_kind, parent_id, sort_order)
      VALUES (?, ?, 'facet', ?, ?)
    `);

    // normalized (section, facet) name -> rebuilt facet id. Duplicate facet
    // spellings inside one Section keep only the first occurrence.
    const newFacetIds = new Map<string, number>();
    const defaultFacetIds = new Map<string, number>();
    let sectionsRecreated = 0;
    for (const section of template) {
      const sectionKey = normalizedGroupName(section.name);
      const sectionResult = insertSection.run(entryType, section.name, section.sortOrder);
      const newSectionId = Number(sectionResult.lastInsertRowid);
      sectionsRecreated += 1;
      const seenFacetNames = new Set<string>();
      for (const facet of section.facets) {
        const facetKey = normalizedGroupName(facet.name);
        if (facet.name === '') {
          const defaultId = Number(insertFacet.run(
            entryType, facet.name, newSectionId, facet.sortOrder,
          ).lastInsertRowid);
          defaultFacetIds.set(sectionKey, defaultId);
          newFacetIds.set(`${sectionKey}\u0000`, defaultId);
          continue;
        }
        if (seenFacetNames.has(facetKey)) continue;
        seenFacetNames.add(facetKey);
        const facetResult = insertFacet.run(
          entryType, facet.name, newSectionId, facet.sortOrder,
        );
        newFacetIds.set(
          `${sectionKey}\u0000${facetKey}`,
          Number(facetResult.lastInsertRowid),
        );
      }
    }

    const fallbackFacetId = defaultFacetIds.get('tags')
      ?? defaultFacetIds.values().next().value as number | undefined;
    if (fallbackFacetId === undefined) {
      throw new Error('template layout has no default facet to receive tags');
    }

    const relinkTag = database.prepare(
      'UPDATE entry_tags SET facet_id = ? WHERE facet_id = ?',
    );
    let tagsRelinked = 0;
    let orphansMoved = 0;
    for (const row of oldRows) {
      if (row.facet_id === null || row.facet_name === null) continue;
      const key = `${normalizedGroupName(row.section_name)}\u0000${normalizedGroupName(row.facet_name)}`;
      const targetId = newFacetIds.get(key);
      if (targetId === undefined) {
        orphansMoved += relinkTag.run(fallbackFacetId, row.facet_id).changes;
      } else {
        tagsRelinked += relinkTag.run(targetId, row.facet_id).changes;
      }
    }

    const deleteSection = database.prepare('DELETE FROM tag_groups WHERE id = ?');
    for (const sectionId of oldSectionIds) {
      deleteSection.run(sectionId);
    }

    const entriesAffected = database.prepare(
      'SELECT COUNT(*) AS n FROM entries WHERE type = ?',
    ).get(entryType) as { n: number };

    return {
      entryType,
      entriesAffected: entriesAffected.n,
      tagsRelinked,
      orphansMoved,
      sectionsRecreated,
    };
  })();
}
