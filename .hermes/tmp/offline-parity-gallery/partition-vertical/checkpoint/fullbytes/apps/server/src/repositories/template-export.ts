import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONTENT_KINDS, normalizeTag } from '@t3/shared';
import type { T3Database } from '../database/connection.js';
import { listLayout } from './layout-repository.js';

/**
 * Formal gallery templates: every Gallery keeps exactly one template file
 * (the Section/Facet structure) plus one tag-layout file (which facet each
 * tag belongs to), written as regular JSON under
 * `<database dir>/templates/`. Import reads the tag layout so incoming tags
 * land in their intended Facet instead of the default position. The files
 * are refreshed whenever a template or tag layout is applied.
 */
export interface TagLayoutMapping {
  tag: string;
  section: string;
  facet: string;
}

export interface TemplateFileContents {
  entryType: string;
  generatedAt: string;
  sections: Array<{ name: string; facets: string[] }>;
  /**
   * The Content kinds a work of this Gallery carries, built-ins first. A template's scope was only
   * ever its Sections and Facets; a work's Content rows are the other half of "what does a work here
   * look like", and they were the one part the person could not see in the template at all.
   */
  contentKinds: string[];
}

export interface TagLayoutFileContents {
  entryType: string;
  generatedAt: string;
  mappings: TagLayoutMapping[];
}

/**
 * The Content kinds one Gallery's works carry: its built-ins first, then every kind actually used,
 * the most-used spelling and order first.
 *
 * Derived from the rows rather than declared in a list somewhere, which is what lets a kind the person
 * added to one work (a `comment`) be part of the Gallery from then on — carried by the next template
 * write, with no empty row ever written for a work that has nothing to say. Spelling is the person's:
 * two rows may say `Source URL` and `source url`, and the one more works use is the one kept.
 */
export function contentKindsForType(database: T3Database, entryType: string): string[] {
  const rows = database.prepare(`
    SELECT content.content_type AS kind, COUNT(DISTINCT content.entry_id) AS works
    FROM entry_contents AS content
    JOIN entries AS entry ON entry.id = content.entry_id
    WHERE entry.type = ?
    GROUP BY content.content_type
  `).all(entryType) as Array<{ kind: string; works: number }>;

  const spellings = new Map<string, { kind: string; works: number }>();
  for (const row of rows) {
    const key = normalizeTag(row.kind);
    if (key === '') continue;
    const seen = spellings.get(key);
    if (!seen || row.works > seen.works) spellings.set(key, row);
  }

  const kinds: string[] = [];
  const taken = new Set<string>();
  for (const builtIn of DEFAULT_CONTENT_KINDS) {
    const key = normalizeTag(builtIn);
    if (taken.has(key)) continue;
    taken.add(key);
    kinds.push(spellings.get(key)?.kind ?? builtIn);
  }
  const rest = [...spellings.entries()]
    .filter(([key]) => !taken.has(key))
    .sort((left, right) => right[1].works - left[1].works
      || left[1].kind.localeCompare(right[1].kind))
    .map(([, row]) => row.kind);
  kinds.push(...rest);
  return kinds;
}

function templateFileName(entryType: string, suffix: string): string {
  if (!entryType || /[\\/\\\\:*?"<>|]/u.test(entryType) || entryType === '.' || entryType === '..') {
    throw new Error('Invalid Gallery entryType for template filename');
  }
  return `${entryType}.${suffix}.json`;
}

export function templatesDirFor(databasePath: string): string {
  return join(databasePath, '..', 'templates');
}

/** Aggregated, majority-vote placement of one tag inside one Gallery. */
export function majorityFacetForTag(
  database: T3Database,
  entryType: string,
  tagName: string,
): { facetId: number; section: string; facet: string } | null {
  const normalized = tagName.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  if (normalized === '') return null;
  const row = database.prepare(`
    SELECT facet.id AS facet_id, section.name AS section_name, facet.name AS facet_name,
      COUNT(*) AS placements
    FROM entry_tags AS assignment
    JOIN tags AS tag ON tag.id = assignment.tag_id
    JOIN entries AS entry ON entry.id = assignment.entry_id
    JOIN tag_groups AS facet ON facet.id = assignment.facet_id
    JOIN tag_groups AS section ON section.id = facet.parent_id
    WHERE entry.type = ? AND tag.normalized_name = ?
    GROUP BY facet.id
    ORDER BY placements DESC, facet.id ASC
    LIMIT 1
  `).get(entryType, normalized) as {
    facet_id: number;
    section_name: string;
    facet_name: string;
  } | undefined;
  if (!row) return null;
  return {
    facetId: row.facet_id,
    section: row.section_name,
    facet: row.facet_name,
  };
}

function tagLayoutMappings(database: T3Database, entryType: string): TagLayoutMapping[] {
  const rows = database.prepare(`
    SELECT tag.name AS tag_name, section.name AS section_name, facet.name AS facet_name,
      COUNT(*) AS placements
    FROM entry_tags AS assignment
    JOIN tags AS tag ON tag.id = assignment.tag_id
    JOIN entries AS entry ON entry.id = assignment.entry_id
    JOIN tag_groups AS facet ON facet.id = assignment.facet_id
    JOIN tag_groups AS section ON section.id = facet.parent_id
    WHERE entry.type = ?
    GROUP BY tag.normalized_name, facet.id
    ORDER BY tag.name COLLATE NOCASE, placements DESC
  `).all(entryType) as Array<{
    tag_name: string;
    section_name: string;
    facet_name: string;
    placements: number;
  }>;
  // One row per tag: its most-used placement wins (ties broken by name order).
  const best = new Map<string, TagLayoutMapping>();
  for (const row of rows) {
    if (!best.has(row.tag_name)) {
      best.set(row.tag_name, {
        tag: row.tag_name,
        section: row.section_name,
        facet: row.facet_name,
      });
    }
  }
  return [...best.values()];
}

export interface TemplateFileResult {
  templatePath: string;
  tagLayoutPath: string;
  mappingCount: number;
}

/** Writes both files for one Gallery and returns their absolute paths. */
export function writeTemplateFiles(
  database: T3Database,
  entryType: string,
  templatesDir: string,
): TemplateFileResult {
  mkdirSync(templatesDir, { recursive: true });
  const now = new Date().toISOString();

  const layout = listLayout(database, entryType);
  const templateContents: TemplateFileContents = {
    entryType,
    generatedAt: now,
    sections: layout.map((section) => ({
      name: section.name,
      facets: section.facets.map((facet) => facet.name),
    })),
    contentKinds: contentKindsForType(database, entryType),
  };

  const mappings = tagLayoutMappings(database, entryType);
  const tagLayoutContents: TagLayoutFileContents = {
    entryType,
    generatedAt: now,
    mappings,
  };

  const templatePath = join(templatesDir, templateFileName(entryType, 'template'));
  const tagLayoutPath = join(templatesDir, templateFileName(entryType, 'tag-layout'));
  writeFileSync(templatePath, `${JSON.stringify(templateContents, null, 2)}\n`, 'utf8');
  writeFileSync(tagLayoutPath, `${JSON.stringify(tagLayoutContents, null, 2)}\n`, 'utf8');
  return { templatePath, tagLayoutPath, mappingCount: mappings.length };
}

export interface TemplateSummary {
  entryType: string;
  sections: Array<{ name: string; facets: string[] }>;
  mappings: TagLayoutMapping[];
  templatePath: string;
  tagLayoutPath: string;
  templateExists: boolean;
  tagLayoutExists: boolean;
  /** Same list `writeTemplateFiles` writes, from the same helper, so file and view cannot disagree. */
  contentKinds: string[];
}

/** Advanced-editing listing: one summary per Gallery with a template. */
export function listTemplateSummaries(
  database: T3Database,
  templatesDir: string,
): TemplateSummary[] {
  const rows = database.prepare(
    'SELECT DISTINCT entry_type AS type FROM tag_groups ORDER BY entry_type COLLATE NOCASE',
  ).all() as Array<{ type: string }>;
  const exists = new Set(rows.map((row) => row.type));
  const summaries: TemplateSummary[] = [];
  for (const entryType of exists) {
    const layout = listLayout(database, entryType);
    if (layout.length === 0) continue;
    const templatePath = join(templatesDir, templateFileName(entryType, 'template'));
    const tagLayoutPath = join(templatesDir, templateFileName(entryType, 'tag-layout'));
    summaries.push({
      entryType,
      sections: layout.map((section) => ({
        name: section.name,
        facets: section.facets.map((facet) => facet.name),
      })),
      mappings: tagLayoutMappings(database, entryType),
      templatePath,
      tagLayoutPath,
      templateExists: summaryExists(templatePath),
      tagLayoutExists: summaryExists(tagLayoutPath),
      contentKinds: contentKindsForType(database, entryType),
    });
  }
  return summaries;
}

function summaryExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
