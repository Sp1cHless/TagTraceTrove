import type { T3Database } from '../database/connection.js';
import { createEntryContent } from './entry-content-repository.js';
import { deleteEntry } from './entry-repository.js';
import {
  listEntrySources,
  normalizeSourceUrl,
  type EntrySourceRecord,
} from './source-library-repository.js';

export interface MergeAuthorEntriesInput {
  authorId: number;
  keepEntryId: number;
  absorbEntryId: number;
  copyTags: boolean;
  /** 合并后写入保留作品的标题；缺省沿用原标题。 */
  title?: string | undefined;
  sourceUrls: string[];
}

export interface MergeAuthorEntriesResult {
  keptEntryId: number;
  absorbedEntryId: number;
  copiedTagCount: number;
  copiedSourceCount: number;
  sources: EntrySourceRecord[];
}

interface MergeEntryRow {
  id: number;
  title: string;
  type: string;
  linked_to_author: number;
}

export function mergeAuthorEntries(
  database: T3Database,
  input: MergeAuthorEntriesInput,
): MergeAuthorEntriesResult {
  if (input.keepEntryId === input.absorbEntryId) {
    throw new Error('Entry merge requires two different Entries');
  }

  return database.transaction(() => {
    const readEntry = database.prepare(`
      SELECT
        entry.id,
        entry.title,
        entry.type,
        EXISTS (
          SELECT 1
          FROM entry_producers AS link
          WHERE link.entry_id = entry.id AND link.producer_id = ?
        ) AS linked_to_author
      FROM entries AS entry
      WHERE entry.id = ?
    `);
    const keep = readEntry.get(input.authorId, input.keepEntryId) as MergeEntryRow | undefined;
    const absorb = readEntry.get(input.authorId, input.absorbEntryId) as MergeEntryRow | undefined;
    if (!keep || !absorb) throw new Error('Entry not found');
    if (!keep.linked_to_author || !absorb.linked_to_author) {
      throw new Error('Both Entries must be linked to the active Author');
    }
    if (keep.type !== absorb.type) {
      throw new Error('Entry merge requires both works to use the same Gallery');
    }

    let copiedTagCount = 0;
    if (input.copyTags) {
      const tagResult = database.prepare(`
        INSERT INTO entry_tags (entry_id, tag_id, facet_id)
        SELECT ?, tag_id, facet_id
        FROM entry_tags
        WHERE entry_id = ?
        ON CONFLICT(entry_id, tag_id) DO NOTHING
      `).run(keep.id, absorb.id);
      copiedTagCount = tagResult.changes;
    }

    database.prepare(`
      INSERT INTO entry_producers (entry_id, producer_id)
      SELECT ?, producer_id
      FROM entry_producers
      WHERE entry_id = ?
      ON CONFLICT(entry_id, producer_id) DO NOTHING
    `).run(keep.id, absorb.id);

    // 合并后使用的标题：界面可选用被吸收作品的那一条，也可自行改写。
    const nextTitle = input.title?.trim();
    if (nextTitle && nextTitle !== keep.title) {
      database.prepare(`
        UPDATE entries
        SET title = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextTitle, keep.id);
    }

    const availableSources = new Map(
      listEntrySources(database, absorb.id).map((source) => [source.url, source]),
    );
    const normalizedSources = input.sourceUrls.map(normalizeSourceUrl);
    if (normalizedSources.some((url) => url === null)) {
      throw new Error('Selected source URL must use HTTP or HTTPS');
    }
    const requestedSources = [...new Set(normalizedSources as string[])];
    if (requestedSources.some((url) => !availableSources.has(url))) {
      throw new Error('Selected source URL does not belong to the absorbed Entry');
    }
    const existingUrls = new Set(listEntrySources(database, keep.id).map((source) => source.url));
    let nextSortOrder = (database.prepare(`
      SELECT COALESCE(MAX(sort_order), -1) + 1
      FROM entry_contents
      WHERE entry_id = ?
    `).pluck().get(keep.id) as number);
    let copiedSourceCount = 0;
    for (const url of requestedSources) {
      if (existingUrls.has(url)) continue;
      createEntryContent(database, {
        entryId: keep.id,
        contentType: 'Source URL',
        content: url,
        sortOrder: nextSortOrder,
      });
      nextSortOrder += 1;
      copiedSourceCount += 1;
      existingUrls.add(url);
    }

    deleteEntry(database, absorb.id);
    return {
      keptEntryId: keep.id,
      absorbedEntryId: absorb.id,
      copiedTagCount,
      copiedSourceCount,
      sources: listEntrySources(database, keep.id),
    };
  })();
}
