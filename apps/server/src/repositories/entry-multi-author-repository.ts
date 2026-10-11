import type { T3Database } from '../database/connection.js';
import { multiAuthorProducerName } from '@t3/shared';
import { createProducer, linkEntryProducer, unlinkEntryProducer } from './producer-repository.js';

export const MULTI_AUTHOR_PRODUCER_NAME = multiAuthorProducerName;

export interface MultiAuthorConversionAuthor {
  id: number;
  name: string;
}

export interface ConvertEntryAuthorsResult {
  entryId: number;
  multiAuthorId: number;
  multiAuthorName: string;
  convertedAuthors: MultiAuthorConversionAuthor[];
}

interface LinkedAuthorRow {
  id: number;
  name: string;
  work_count: number;
}

function findMultiAuthorId(database: T3Database): number | undefined {
  return database.prepare(`
    SELECT id
    FROM producers
    WHERE name = ? COLLATE NOCASE
    ORDER BY id
    LIMIT 1
  `).pluck().get(MULTI_AUTHOR_PRODUCER_NAME) as number | undefined;
}

function listLinkedAuthors(database: T3Database, entryId: number): LinkedAuthorRow[] {
  return database.prepare(`
    SELECT
      producer.id,
      producer.name,
      (
        SELECT COUNT(*)
        FROM entry_producers AS own_relation
        WHERE own_relation.producer_id = producer.id
      ) AS work_count
    FROM entry_producers AS relation
    JOIN producers AS producer ON producer.id = relation.producer_id
    WHERE relation.entry_id = ?
    ORDER BY producer.name COLLATE NOCASE, producer.id
  `).all(entryId) as LinkedAuthorRow[];
}

/**
 * Replaces every Author of one Entry with a single shared multi-author Author.
 *
 * The cleanup deliberately does not judge who deserves to stay: an anthology
 * mixes one-off contributors with real Authors, and an Author who only ever
 * appears in anthologies keeps resurfacing while their per-work work count never
 * looks like a lone credit. After the conversion the work is credited to the
 * multi-author Author alone, so a contributor who was in anthologies only is left
 * holding no work at all and the Author rule removes that row with it. A later
 * import of such a name creates its Author again from the work it brings.
 */
export function convertEntryAuthorsToMultiAuthor(
  database: T3Database,
  entryId: number,
  replayTargetUid?: string,
): ConvertEntryAuthorsResult {
  return database.transaction(() => {
    const exists = database.prepare('SELECT 1 FROM entries WHERE id = ?').get(entryId);
    if (exists === undefined) {
      throw new Error('Entry not found');
    }

    const multiAuthorId = findMultiAuthorId(database);
    const linked = listLinkedAuthors(database, entryId);
    const convertible = linked.filter((author) => author.id !== multiAuthorId);
    // Already credited to the multi-author Author alone: the desired state is
    // already there, so a repeated click is a no-op instead of a conflict.
    if (convertible.length === 0 && multiAuthorId !== undefined && linked.length > 0) {
      return {
        entryId,
        multiAuthorId,
        multiAuthorName: MULTI_AUTHOR_PRODUCER_NAME,
        convertedAuthors: [],
      };
    }
    if (linked.length < 2) {
      throw new Error('Multi Author conversion requires an Entry with several Authors');
    }

    const targetId = multiAuthorId ?? (replayTargetUid === undefined
      ? createProducer(database, { name: MULTI_AUTHOR_PRODUCER_NAME }).id
      : Number(database.prepare('INSERT INTO producers (name, sync_uid) VALUES (?, ?)')
        .run(MULTI_AUTHOR_PRODUCER_NAME, replayTargetUid).lastInsertRowid));
    linkEntryProducer(database, entryId, targetId);
    for (const author of convertible) {
      unlinkEntryProducer(database, entryId, author.id);
    }

    const toAuthor = (row: LinkedAuthorRow): MultiAuthorConversionAuthor => ({
      id: row.id,
      name: row.name,
    });
    return {
      entryId,
      multiAuthorId: targetId,
      multiAuthorName: MULTI_AUTHOR_PRODUCER_NAME,
      convertedAuthors: convertible.map(toAuthor),
    };
  })();
}
