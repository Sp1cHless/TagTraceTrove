import type { T3Database } from '../database/connection.js';

export interface AuthorWorkSummary {
  id: number;
  title: string;
  type: string;
  coverRef: string | null;
  viewCount: number;
  likeCount: number;
  lastViewedAt: string | null;
}

export interface AuthorDirectoryRecord {
  id: number;
  producerId: number;
  title: string;
  description: string;
  sortOrder: number;
  entries: AuthorWorkSummary[];
}

export interface CreateAuthorDirectoryInput {
  producerId: number;
  title: string;
  description?: string | undefined;
  entryIds?: number[] | undefined;
}

export interface UpdateAuthorDirectoryInput {
  title?: string | undefined;
  description?: string | undefined;
}

export interface AddEntryToAuthorDirectoryInput {
  producerId: number;
  directoryId: number;
  entryId: number;
}

interface DirectoryRow {
  id: number;
  producer_id: number;
  title: string;
  description: string;
  sort_order: number;
}

interface WorkRow {
  id: number;
  title: string;
  type: string;
  cover_ref: string | null;
  view_count: number;
  like_count: number;
  last_viewed_at: string | null;
}

function mapWork(row: WorkRow): AuthorWorkSummary {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    coverRef: row.cover_ref,
    viewCount: row.view_count,
    likeCount: row.like_count,
    lastViewedAt: row.last_viewed_at,
  };
}

function listDirectoryEntries(database: T3Database, directoryId: number): AuthorWorkSummary[] {
  const rows = database.prepare(`
    SELECT entry.id, entry.title, entry.type, entry.cover_ref,
      COALESCE(usage.view_count, 0) AS view_count,
      COALESCE(usage.like_count, 0) AS like_count,
      usage.last_viewed_at AS last_viewed_at
    FROM author_directory_entries AS membership
    JOIN entries AS entry ON entry.id = membership.entry_id
    LEFT JOIN entry_usage AS usage ON usage.entry_id = entry.id
    WHERE membership.directory_id = ?
    ORDER BY membership.sort_order, membership.entry_id
  `).all(directoryId) as WorkRow[];
  return rows.map(mapWork);
}

function getDirectory(database: T3Database, directoryId: number): AuthorDirectoryRecord | null {
  const row = database.prepare(`
    SELECT id, producer_id, title, description, sort_order
    FROM author_directories
    WHERE id = ?
  `).get(directoryId) as DirectoryRow | undefined;
  return row ? {
    id: row.id,
    producerId: row.producer_id,
    title: row.title,
    description: row.description,
    sortOrder: row.sort_order,
    entries: listDirectoryEntries(database, row.id),
  } : null;
}

function normalizedTitle(title: string): string {
  const value = title.trim();
  if (value === '') throw new Error('author directory title cannot be empty');
  return value;
}

function insertMembership(
  database: T3Database,
  input: AddEntryToAuthorDirectoryInput,
  sortOrder?: number,
): void {
  const directory = database.prepare(`
    SELECT id
    FROM author_directories
    WHERE id = ? AND producer_id = ?
  `).get(input.directoryId, input.producerId);
  if (!directory) throw new Error('author directory not found');

  database.prepare(`
    DELETE FROM author_directory_entries
    WHERE producer_id = ? AND entry_id = ?
  `).run(input.producerId, input.entryId);
  const nextSortOrder = sortOrder ?? Number(database.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1
    FROM author_directory_entries
    WHERE directory_id = ?
  `).pluck().get(input.directoryId));
  database.prepare(`
    INSERT INTO author_directory_entries (
      directory_id, producer_id, entry_id, sort_order
    ) VALUES (?, ?, ?, ?)
  `).run(input.directoryId, input.producerId, input.entryId, nextSortOrder);
}

export function createAuthorDirectory(
  database: T3Database,
  input: CreateAuthorDirectoryInput,
): AuthorDirectoryRecord {
  return database.transaction(() => {
    const title = normalizedTitle(input.title);
    const sortOrder = Number(database.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1
      FROM author_directories
      WHERE producer_id = ?
    `).pluck().get(input.producerId));
    const result = database.prepare(`
      INSERT INTO author_directories (producer_id, title, description, sort_order)
      VALUES (?, ?, ?, ?)
    `).run(input.producerId, title, input.description ?? '', sortOrder);
    const directoryId = Number(result.lastInsertRowid);
    for (const [index, entryId] of (input.entryIds ?? []).entries()) {
      insertMembership(database, {
        producerId: input.producerId,
        directoryId,
        entryId,
      }, index);
    }
    return getDirectory(database, directoryId) as AuthorDirectoryRecord;
  })();
}

export function updateAuthorDirectory(
  database: T3Database,
  directoryId: number,
  input: UpdateAuthorDirectoryInput,
): AuthorDirectoryRecord {
  const assignments: string[] = [];
  const values: string[] = [];
  if (input.title !== undefined) {
    assignments.push('title = ?');
    values.push(normalizedTitle(input.title));
  }
  if (input.description !== undefined) {
    assignments.push('description = ?');
    values.push(input.description);
  }
  if (assignments.length > 0) {
    const result = database.prepare(`
      UPDATE author_directories
      SET ${assignments.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...values, directoryId);
    if (result.changes === 0) throw new Error('author directory not found');
  }
  const directory = getDirectory(database, directoryId);
  if (!directory) throw new Error('author directory not found');
  return directory;
}

export function addEntryToAuthorDirectory(
  database: T3Database,
  input: AddEntryToAuthorDirectoryInput,
): AuthorDirectoryRecord {
  return database.transaction(() => {
    insertMembership(database, input);
    return getDirectory(database, input.directoryId) as AuthorDirectoryRecord;
  })();
}

export function removeEntryFromAuthorDirectory(
  database: T3Database,
  input: AddEntryToAuthorDirectoryInput,
): AuthorDirectoryRecord {
  const result = database.prepare(`
    DELETE FROM author_directory_entries
    WHERE directory_id = ? AND producer_id = ? AND entry_id = ?
  `).run(input.directoryId, input.producerId, input.entryId);
  if (result.changes === 0) throw new Error('author directory membership not found');
  return getDirectory(database, input.directoryId) as AuthorDirectoryRecord;
}

export function listAuthorDirectories(
  database: T3Database,
  producerId: number,
): AuthorDirectoryRecord[] {
  const rows = database.prepare(`
    SELECT id, producer_id, title, description, sort_order
    FROM author_directories
    WHERE producer_id = ?
    ORDER BY sort_order, id
  `).all(producerId) as DirectoryRow[];
  return rows.map((row) => ({
    id: row.id,
    producerId: row.producer_id,
    title: row.title,
    description: row.description,
    sortOrder: row.sort_order,
    entries: listDirectoryEntries(database, row.id),
  }));
}
