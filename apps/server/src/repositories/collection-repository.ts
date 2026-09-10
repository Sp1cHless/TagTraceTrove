import type { T3Database } from '../database/connection.js';

export type CollectionKind = 'entry' | 'producer';

export interface CollectionMemberEntry {
  id: number;
  title: string;
  type: string;
  coverRef: string | null;
  previewRefs: string[];
}

export interface CollectionMemberProducer {
  id: number;
  name: string;
  covers: string[];
}

export interface CollectionRecord {
  id: number;
  kind: CollectionKind;
  title: string;
  description: string;
  nsfw: boolean;
  sortOrder: number;
  /** Entry collections only: one level of child folders. */
  children: CollectionRecord[];
  entries: CollectionMemberEntry[];
  producers: CollectionMemberProducer[];
  entryCount?: number;
  producerCount?: number;
}

interface CollectionRow {
  id: number;
  kind: CollectionKind;
  title: string;
  description: string;
  nsfw: number;
  parent_id: number | null;
  sort_order: number;
}

function parsePreviewRefs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((ref): ref is string => typeof ref === 'string') : [];
  } catch {
    return [];
  }
}

function rowToRecord(
  row: CollectionRow,
  children: CollectionRecord[],
  entries: CollectionMemberEntry[],
  producers: CollectionMemberProducer[],
  counts?: { entryCount: number; producerCount: number },
): CollectionRecord {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    nsfw: row.nsfw === 1,
    sortOrder: row.sort_order,
    children,
    entries,
    producers,
    ...counts,
  };
}

function listRows(database: T3Database, kind: CollectionKind): CollectionRow[] {
  return database.prepare(`
    SELECT id, kind, title, description, nsfw, parent_id, sort_order
    FROM collections
    WHERE kind = ?
    ORDER BY sort_order, id
  `).all(kind) as CollectionRow[];
}

export function listCollections(
  database: T3Database,
  kind: CollectionKind,
  options: { compact?: boolean; includeNsfw?: boolean } = {},
): CollectionRecord[] {
  const rows = listRows(database, kind);
  const compact = options.compact === true;
  const includeNsfw = options.includeNsfw !== false;
  const entryStatement = database.prepare(`
    SELECT entry.id, entry.title, entry.type, entry.cover_ref AS coverRef,
      entry.preview_refs AS previewRefs
    FROM collection_entries AS link
    JOIN entries AS entry ON entry.id = link.entry_id
    WHERE link.collection_id = ?
      AND (? = 1 OR NOT EXISTS (
        SELECT 1 FROM gallery_settings AS partition
        WHERE partition.entry_type = entry.type AND partition.nsfw = 1
      ))
    ORDER BY link.created_at, entry.id
    ${compact ? 'LIMIT 3' : ''}
  `);
  const producerStatement = database.prepare(`
    SELECT producer.id, producer.name
    FROM collection_producers AS link
    JOIN producers AS producer ON producer.id = link.producer_id
    WHERE link.collection_id = ?
      AND (? = 1 OR NOT EXISTS (
        SELECT 1
        FROM entry_producers AS relation
        JOIN entries AS work ON work.id = relation.entry_id
        JOIN gallery_settings AS partition ON partition.entry_type = work.type AND partition.nsfw = 1
        WHERE relation.producer_id = producer.id
      ))
    ORDER BY link.created_at, producer.id
    ${compact ? 'LIMIT 3' : ''}
  `);
  const producerCoverStatement = database.prepare(`
    SELECT entry.cover_ref
    FROM entry_producers AS relation
    JOIN entries AS entry ON entry.id = relation.entry_id
    WHERE relation.producer_id = ? AND entry.cover_ref IS NOT NULL
    ORDER BY entry.id ASC
    LIMIT 4
  `);
  const entryCountStatement = compact
    ? database.prepare(`
        SELECT COUNT(*)
        FROM collection_entries AS link
        JOIN entries AS entry ON entry.id = link.entry_id
        WHERE link.collection_id = ?
          AND (? = 1 OR NOT EXISTS (
            SELECT 1 FROM gallery_settings AS partition
            WHERE partition.entry_type = entry.type AND partition.nsfw = 1
          ))
      `).pluck()
    : null;
  const producerCountStatement = compact
    ? database.prepare(`
        SELECT COUNT(*)
        FROM collection_producers AS link
        JOIN producers AS producer ON producer.id = link.producer_id
        WHERE link.collection_id = ?
          AND (? = 1 OR NOT EXISTS (
            SELECT 1
            FROM entry_producers AS relation
            JOIN entries AS work ON work.id = relation.entry_id
            JOIN gallery_settings AS partition ON partition.entry_type = work.type AND partition.nsfw = 1
            WHERE relation.producer_id = producer.id
          ))
      `).pluck()
    : null;
  const childrenOf = new Map<number, CollectionRow[]>();
  for (const row of rows) {
    if (row.parent_id !== null) {
      const list = childrenOf.get(row.parent_id) ?? [];
      list.push(row);
      childrenOf.set(row.parent_id, list);
    }
  }
  const build = (row: CollectionRow): CollectionRecord => rowToRecord(
    row,
    (childrenOf.get(row.id) ?? []).map(build),
    (entryStatement.all(row.id, includeNsfw ? 1 : 0) as Array<{
      id: number;
      title: string;
      type: string;
      coverRef: string | null;
      previewRefs: string | null;
    }>).map((entry) => ({
      id: entry.id,
      title: entry.title,
      type: entry.type,
      coverRef: entry.coverRef,
      previewRefs: parsePreviewRefs(entry.previewRefs),
    })),
    (producerStatement.all(row.id, includeNsfw ? 1 : 0) as CollectionMemberProducer[]).map((producer) => ({
      ...producer,
      covers: (producerCoverStatement.all(producer.id) as Array<{ cover_ref: string }>)
        .map((entry) => entry.cover_ref),
    })),
    compact ? {
      entryCount: Number(entryCountStatement!.get(row.id, includeNsfw ? 1 : 0)),
      producerCount: Number(producerCountStatement!.get(row.id, includeNsfw ? 1 : 0)),
    } : undefined,
  );
  return rows.filter((row) => row.parent_id === null).map(build);
}

function requireCollection(
  database: T3Database,
  collectionId: number,
  kind?: CollectionKind,
): CollectionRow {
  const row = database.prepare(
    'SELECT id, kind, title, description, nsfw, parent_id, sort_order FROM collections WHERE id = ?',
  ).get(collectionId) as CollectionRow | undefined;
  if (!row) {
    throw new Error('collection not found');
  }
  if (kind !== undefined && row.kind !== kind) {
    throw new Error(`cannot use an entry collection API on a ${row.kind} collection`);
  }
  return row;
}

export function createCollection(
  database: T3Database,
  input: {
    kind: CollectionKind;
    title: string;
    description?: string | undefined;
    parentId?: number | null | undefined;
  },
): CollectionRecord {
  const title = input.title.trim();
  if (title === '') {
    throw new Error('collection title cannot be empty');
  }
  let parentId: number | null = null;
  if (input.parentId != null) {
    const parent = requireCollection(database, input.parentId, 'entry');
    if (parent.parent_id !== null) {
      throw new Error('cannot nest a collection more than one level deep');
    }
    parentId = parent.id;
  }
  const maxOrder = database.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) FROM collections WHERE kind = ? AND parent_id IS NULL',
  ).pluck().get(input.kind) as number;
  const result = database.prepare(`
    INSERT INTO collections (kind, title, description, parent_id, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.kind, title, input.description?.trim() ?? '', parentId, maxOrder + 1);
  return getCollection(database, Number(result.lastInsertRowid), { compact: true })!;
}

export function getCollection(
  database: T3Database,
  collectionId: number,
  options: { compact?: boolean; includeNsfw?: boolean } = {},
): CollectionRecord | null {
  const kind = database.prepare(
    'SELECT kind FROM collections WHERE id = ?',
  ).pluck().get(collectionId) as CollectionKind | undefined;
  if (kind === undefined) return null;
  const topLevel = listCollections(database, kind, options);
  const direct = topLevel.find((record) => record.id === collectionId);
  if (direct) return direct;
  for (const parent of topLevel) {
    const child = parent.children.find((nested) => nested.id === collectionId);
    if (child) return child;
  }
  return null;
}

export function updateCollection(
  database: T3Database,
  collectionId: number,
  input: { title?: string | undefined; description?: string | undefined },
): CollectionRecord {
  const existing = requireCollection(database, collectionId);
  const title = input.title !== undefined ? input.title.trim() : existing.title;
  if (title === '') {
    throw new Error('collection title cannot be empty');
  }
  const description = input.description !== undefined
    ? input.description.trim()
    : existing.description;
  database.prepare(
    'UPDATE collections SET title = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  ).run(title, description, collectionId);
  return getCollection(database, collectionId, { compact: true })!;
}

export function deleteCollection(database: T3Database, collectionId: number): void {
  const result = database.prepare('DELETE FROM collections WHERE id = ?').run(collectionId);
  if (result.changes === 0) {
    throw new Error('collection not found');
  }
}

export function setCollectionNsfw(
  database: T3Database,
  collectionId: number,
  nsfw: boolean,
): void {
  const result = database.prepare(
    'UPDATE collections SET nsfw = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  ).run(nsfw ? 1 : 0, collectionId);
  if (result.changes === 0) {
    throw new Error('collection not found');
  }
}

export function reorderCollections(
  database: T3Database,
  kind: CollectionKind,
  orderedIds: number[],
): void {
  const topLevel = listRows(database, kind).filter((row) => row.parent_id === null);
  const known = new Set(topLevel.map((row) => row.id));
  const unique = new Set(orderedIds);
  if (unique.size !== orderedIds.length || orderedIds.length !== topLevel.length
    || orderedIds.some((id) => !known.has(id))) {
    throw new Error('cannot reorder: the payload must contain every top-level collection exactly once');
  }
  database.transaction(() => {
    const update = database.prepare('UPDATE collections SET sort_order = ? WHERE id = ?');
    orderedIds.forEach((id, index) => update.run(index, id));
  })();
}

export function addCollectionEntry(
  database: T3Database,
  collectionId: number,
  entryId: number,
): void {
  requireCollection(database, collectionId, 'entry');
  if (!database.prepare('SELECT 1 FROM entries WHERE id = ?').get(entryId)) {
    throw new Error('entry not found');
  }
  database.prepare(`
    INSERT INTO collection_entries (collection_id, entry_id) VALUES (?, ?)
    ON CONFLICT (collection_id, entry_id) DO NOTHING
  `).run(collectionId, entryId);
}

export function removeCollectionEntry(
  database: T3Database,
  collectionId: number,
  entryId: number,
): void {
  requireCollection(database, collectionId, 'entry');
  database.prepare(
    'DELETE FROM collection_entries WHERE collection_id = ? AND entry_id = ?',
  ).run(collectionId, entryId);
}

export function addCollectionProducer(
  database: T3Database,
  collectionId: number,
  producerId: number,
): void {
  requireCollection(database, collectionId, 'producer');
  if (!database.prepare('SELECT 1 FROM producers WHERE id = ?').get(producerId)) {
    throw new Error('producer not found');
  }
  database.prepare(`
    INSERT INTO collection_producers (collection_id, producer_id) VALUES (?, ?)
    ON CONFLICT (collection_id, producer_id) DO NOTHING
  `).run(collectionId, producerId);
}

export function removeCollectionProducer(
  database: T3Database,
  collectionId: number,
  producerId: number,
): void {
  requireCollection(database, collectionId, 'producer');
  database.prepare(
    'DELETE FROM collection_producers WHERE collection_id = ? AND producer_id = ?',
  ).run(collectionId, producerId);
}

/** Collection ids (with their parents') containing one entry, for the add-to menu. */
export function listCollectionIdsForEntry(
  database: T3Database,
  entryId: number,
): number[] {
  return database.prepare(`
    SELECT link.collection_id AS id
    FROM collection_entries AS link
    JOIN collections AS collection ON collection.id = link.collection_id
    WHERE link.entry_id = ?
  `).all(entryId).map((row) => (row as { id: number }).id);
}

export function listCollectionIdsForProducer(
  database: T3Database,
  producerId: number,
): number[] {
  return database.prepare(`
    SELECT link.collection_id AS id
    FROM collection_producers AS link
    JOIN collections AS collection ON collection.id = link.collection_id
    WHERE link.producer_id = ?
  `).all(producerId).map((row) => (row as { id: number }).id);
}
