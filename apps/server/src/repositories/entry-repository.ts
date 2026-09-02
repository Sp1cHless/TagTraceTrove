import type { T3Database } from '../database/connection.js';
import { listEntryTags } from './entry-tag-repository.js';
import { listLayout } from './layout-repository.js';

export interface EntryDetailTag {
  id: number;
  name: string;
  normalizedName: string;
}

export interface EntryDetailFacet {
  id: number;
  name: string;
  sortOrder: number;
  tags: EntryDetailTag[];
}

export interface EntryDetailSection {
  id: number;
  name: string;
  sortOrder: number;
  facets: EntryDetailFacet[];
}

export interface EntryDetailProducer {
  id: number;
  name: string;
  occupation: string | null;
  artworkRef: string | null;
  content: string | null;
}

export interface EntryDetailContent {
  id: number;
  contentType: string;
  content: string;
  sortOrder: number;
}

export interface EntryDetail {
  id: number;
  title: string;
  type: string;
  coverRef: string | null;
  previewRef: string | null;
  previewRefs: string[];
  uploadDate: string | null;
  pageCount: number | null;
  producers: EntryDetailProducer[];
  sections: EntryDetailSection[];
  contents: EntryDetailContent[];
}

export interface EntryRecord {
  id: number;
  title: string;
  type: string;
  coverRef: string | null;
  previewRef: string | null;
  previewRefs: string[];
  uploadDate: string | null;
  pageCount: number | null;
}

export interface GallerySummary {
  type: string;
  entryCount: number;
}

export interface CreateEntryInput {
  title: string;
  type: string;
  coverRef?: string | null | undefined;
  previewRef?: string | null | undefined;
  uploadDate?: string | null | undefined;
  pageCount?: number | null | undefined;
}

export interface UpdateEntryInput {
  title?: string | undefined;
  type?: string | undefined;
  coverRef?: string | null | undefined;
  previewRef?: string | null | undefined;
  previewRefs?: string[] | null | undefined;
  uploadDate?: string | null | undefined;
  pageCount?: number | null | undefined;
}

interface EntryRow {
  id: number;
  title: string;
  type: string;
  cover_ref: string | null;
  preview_ref: string | null;
  preview_refs: string | null;
  upload_date: string | null;
  page_count: number | null;
}

interface ProducerRow {
  id: number;
  name: string;
  occupation: string | null;
  artwork_ref: string | null;
  content: string | null;
}

interface ContentRow {
  id: number;
  content_type: string;
  content: string;
  sort_order: number;
}

function parsePreviewRefs(previewRefs: string | null, previewRef: string | null): string[] {
  if (previewRefs) {
    try {
      const parsed: unknown = JSON.parse(previewRefs);
      if (Array.isArray(parsed)) {
        const refs = parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
        if (refs.length > 0) return refs;
      }
    } catch {
      // fall through to the single-column fallback
    }
  }
  return previewRef ? [previewRef] : [];
}

function toEntryRecord(entry: EntryRow): EntryRecord {
  return {
    id: entry.id,
    title: entry.title,
    type: entry.type,
    coverRef: entry.cover_ref,
    previewRef: entry.preview_ref,
    previewRefs: parsePreviewRefs(entry.preview_refs, entry.preview_ref),
    uploadDate: entry.upload_date,
    pageCount: entry.page_count,
  };
}

function getEntryRecord(database: T3Database, entryId: number): EntryRecord | null {
  const entry = database.prepare(`
    SELECT id, title, type, cover_ref, preview_ref, preview_refs, upload_date, page_count
    FROM entries
    WHERE id = ?
  `).get(entryId) as EntryRow | undefined;
  return entry ? toEntryRecord(entry) : null;
}

export function createEntry(database: T3Database, input: CreateEntryInput): EntryRecord {
  const title = input.title.trim();
  const type = input.type.trim();
  if (title === '') {
    throw new Error('entry title cannot be empty');
  }
  if (type === '') {
    throw new Error('entry type cannot be empty');
  }

  const result = database.prepare(`
    INSERT INTO entries (title, type, cover_ref, preview_ref, preview_refs, upload_date, page_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    title,
    type,
    input.coverRef ?? null,
    input.previewRef ?? null,
    '[]',
    input.uploadDate ?? null,
    input.pageCount ?? null,
  );
  return getEntryRecord(database, Number(result.lastInsertRowid)) as EntryRecord;
}

export function listGalleries(database: T3Database): GallerySummary[] {
  const rows = database.prepare(`
    SELECT type, COUNT(*) AS entry_count
    FROM entries
    GROUP BY type
    ORDER BY type COLLATE NOCASE, type
  `).all() as Array<{ type: string; entry_count: number }>;
  return rows.map((row) => ({ type: row.type, entryCount: row.entry_count }));
}

export function updateEntry(
  database: T3Database,
  entryId: number,
  input: UpdateEntryInput,
): EntryRecord {
  if (!getEntryRecord(database, entryId)) {
    throw new Error('entry not found');
  }

  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title === '') {
      throw new Error('entry title cannot be empty');
    }
    assignments.push('title = ?');
    values.push(title);
  }
  if (input.type !== undefined) {
    const type = input.type.trim();
    if (type === '') {
      throw new Error('entry type cannot be empty');
    }
    assignments.push('type = ?');
    values.push(type);
  }
  if (Object.hasOwn(input, 'coverRef')) {
    assignments.push('cover_ref = ?');
    values.push(input.coverRef ?? null);
  }
  if (Object.hasOwn(input, 'previewRef')) {
    assignments.push('preview_ref = ?');
    values.push(input.previewRef ?? null);
  }
  if (Object.hasOwn(input, 'uploadDate')) {
    assignments.push('upload_date = ?');
    values.push(input.uploadDate ?? null);
  }
  if (Object.hasOwn(input, 'pageCount')) {
    assignments.push('page_count = ?');
    values.push(input.pageCount ?? null);
  }
  if (Object.hasOwn(input, 'previewRefs')) {
    assignments.push('preview_refs = ?');
    values.push(JSON.stringify(input.previewRefs ?? []));
  }

  if (assignments.length > 0) {
    database.prepare(`
      UPDATE entries
      SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...values, entryId);
  }

  return getEntryRecord(database, entryId) as EntryRecord;
}

export function getEntryDetail(database: T3Database, entryId: number): EntryDetail | null {
  const entry = database.prepare(`
    SELECT id, title, type, cover_ref, preview_ref, preview_refs, upload_date, page_count
    FROM entries
    WHERE id = ?
  `).get(entryId) as EntryRow | undefined;
  if (!entry) {
    return null;
  }

  const producers = database.prepare(`
    SELECT
      producer.id,
      producer.name,
      producer.occupation,
      producer.artwork_ref,
      producer.content
    FROM entry_producers AS relation
    JOIN producers AS producer ON producer.id = relation.producer_id
    WHERE relation.entry_id = ?
    ORDER BY producer.name COLLATE NOCASE, producer.id
  `).all(entryId) as ProducerRow[];

  const contents = database.prepare(`
    SELECT id, content_type, content, sort_order
    FROM entry_contents
    WHERE entry_id = ?
    ORDER BY sort_order, id
  `).all(entryId) as ContentRow[];

  const tagsByFacet = new Map<number, EntryDetailTag[]>();
  for (const assignment of listEntryTags(database, entryId)) {
    const tags = tagsByFacet.get(assignment.facetId) ?? [];
    tags.push({
      id: assignment.tagId,
      name: assignment.name,
      normalizedName: assignment.normalizedName,
    });
    tagsByFacet.set(assignment.facetId, tags);
  }

  const sections = listLayout(database, entry.type).map((section) => ({
    id: section.id,
    name: section.name,
    sortOrder: section.sortOrder,
    facets: section.facets.map((facet) => ({
      id: facet.id,
      name: facet.name,
      sortOrder: facet.sortOrder,
      tags: tagsByFacet.get(facet.id) ?? [],
    })),
  }));

  return {
    id: entry.id,
    title: entry.title,
    type: entry.type,
    coverRef: entry.cover_ref,
    previewRef: entry.preview_ref,
    previewRefs: parsePreviewRefs(entry.preview_refs, entry.preview_ref),
    uploadDate: entry.upload_date,
    pageCount: entry.page_count,
    producers: producers.map((producer) => ({
      id: producer.id,
      name: producer.name,
      occupation: producer.occupation,
      artworkRef: producer.artwork_ref,
      content: producer.content,
    })),
    sections,
    contents: contents.map((content) => ({
      id: content.id,
      contentType: content.content_type,
      content: content.content,
      sortOrder: content.sort_order,
    })),
  };
}

export function deleteEntry(database: T3Database, entryId: number): void {
  const result = database.prepare('DELETE FROM entries WHERE id = ?').run(entryId);
  if (result.changes === 0) {
    throw new Error('entry not found');
  }
}
