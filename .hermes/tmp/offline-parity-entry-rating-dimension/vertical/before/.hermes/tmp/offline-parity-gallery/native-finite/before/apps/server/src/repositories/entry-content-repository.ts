import type { T3Database } from '../database/connection.js';

export interface EntryContentRecord {
  id: number;
  entryId: number;
  contentType: string;
  content: string;
  sortOrder: number;
}

export interface CreateEntryContentInput {
  entryId: number;
  contentType: string;
  content: string;
  sortOrder?: number | undefined;
}

export interface UpdateEntryContentInput {
  contentType?: string | undefined;
  content?: string | undefined;
  sortOrder?: number | undefined;
}

interface EntryContentRow {
  id: number;
  entry_id: number;
  content_type: string;
  content: string;
  sort_order: number;
}

function getEntryContent(
  database: T3Database,
  contentId: number,
): EntryContentRecord | null {
  const row = database.prepare(`
    SELECT id, entry_id, content_type, content, sort_order
    FROM entry_contents
    WHERE id = ?
  `).get(contentId) as EntryContentRow | undefined;
  return row ? {
    id: row.id,
    entryId: row.entry_id,
    contentType: row.content_type,
    content: row.content,
    sortOrder: row.sort_order,
  } : null;
}

export function createEntryContent(
  database: T3Database,
  input: CreateEntryContentInput,
): EntryContentRecord {
  const contentType = input.contentType.trim();
  if (contentType === '') {
    throw new Error('content type cannot be empty');
  }

  const result = database.prepare(`
    INSERT INTO entry_contents (entry_id, content_type, content, sort_order)
    VALUES (?, ?, ?, ?)
  `).run(input.entryId, contentType, input.content, input.sortOrder ?? 0);
  return getEntryContent(database, Number(result.lastInsertRowid)) as EntryContentRecord;
}

export function updateEntryContent(
  database: T3Database,
  contentId: number,
  input: UpdateEntryContentInput,
): EntryContentRecord {
  if (!getEntryContent(database, contentId)) {
    throw new Error('entry content not found');
  }

  const assignments: string[] = [];
  const values: Array<string | number> = [];
  if (input.contentType !== undefined) {
    const contentType = input.contentType.trim();
    if (contentType === '') {
      throw new Error('content type cannot be empty');
    }
    assignments.push('content_type = ?');
    values.push(contentType);
  }
  if (input.content !== undefined) {
    assignments.push('content = ?');
    values.push(input.content);
  }
  if (input.sortOrder !== undefined) {
    assignments.push('sort_order = ?');
    values.push(input.sortOrder);
  }

  if (assignments.length > 0) {
    database.prepare(`
      UPDATE entry_contents
      SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...values, contentId);
  }
  return getEntryContent(database, contentId) as EntryContentRecord;
}

export function deleteEntryContent(database: T3Database, contentId: number): void {
  const result = database.prepare('DELETE FROM entry_contents WHERE id = ?').run(contentId);
  if (result.changes === 0) {
    throw new Error('entry content not found');
  }
}

export function reorderEntryContents(
  database: T3Database,
  entryId: number,
  orderedContentIds: number[],
): void {
  database.transaction(() => {
    const currentIds = database.prepare(`
      SELECT id
      FROM entry_contents
      WHERE entry_id = ?
    `).pluck().all(entryId) as number[];
    const supplied = new Set(orderedContentIds);
    const valid = supplied.size === orderedContentIds.length
      && currentIds.length === orderedContentIds.length
      && currentIds.every((id) => supplied.has(id));
    if (!valid) {
      throw new Error('content reorder must include every content item for the entry exactly once');
    }

    const update = database.prepare(`
      UPDATE entry_contents
      SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND entry_id = ?
    `);
    orderedContentIds.forEach((contentId, index) => {
      update.run(index, contentId, entryId);
    });
  })();
 }
