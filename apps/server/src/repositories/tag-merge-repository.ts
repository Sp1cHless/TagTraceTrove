import type { T3Database } from '../database/connection.js';
import type { TagMergeRequest, TagMergeResponse } from '@t3/shared';

/**
 * Tag merge: one kept tag absorbs every merged tag — assignments are
 * re-pointed and the merged tag rows are deleted outright (plan: unlike
 * author aliases there is no retrieval value in the old names). An Entry (or
 * Producer) can only hold a tag once, so a merged assignment whose target
 * already carries the kept tag is dropped instead of moved; the kept
 * assignment wins and the duplicate disappears.
 */

export class TagMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TagMergeError';
  }
}

function moveAssignments(
  database: T3Database,
  vocabulary: 'entry' | 'producer',
  keptTagId: number,
  mergedTagIds: number[],
): { moved: number; skipped: number } {
  const placeholders = mergedTagIds.map(() => '?').join(',');
  const table = vocabulary === 'entry' ? 'entry_tags' : 'producer_tag_assignments';
  const ownerKey = vocabulary === 'entry' ? 'entry_id' : 'producer_id';

  interface AssignmentRow { owner: number; facetId?: number | null }
  const rows = (vocabulary === 'entry'
    ? database.prepare(`
        SELECT ${ownerKey} AS owner, facet_id AS facetId
        FROM ${table}
        WHERE tag_id IN (${placeholders})
      `)
    : database.prepare(`
        SELECT ${ownerKey} AS owner, NULL AS facetId
        FROM ${table}
        WHERE tag_id IN (${placeholders})
      `)
  ).all(...mergedTagIds) as AssignmentRow[];

  const insert = vocabulary === 'entry'
    ? database.prepare(`
        INSERT OR IGNORE INTO entry_tags (entry_id, tag_id, facet_id)
        VALUES (?, ?, ?)
      `)
    : database.prepare(`
        INSERT OR IGNORE INTO producer_tag_assignments (producer_id, tag_id)
        VALUES (?, ?)
      `);

  let moved = 0;
  let skipped = 0;
  for (const row of rows) {
    const result = vocabulary === 'entry'
      ? insert.run(row.owner, keptTagId, row.facetId)
      : insert.run(row.owner, keptTagId);
    if (result.changes > 0) moved += 1;
    else skipped += 1;
  }

  database.prepare(`
    DELETE FROM ${table} WHERE tag_id IN (${placeholders})
  `).run(...mergedTagIds);

  return { moved, skipped };
}

export function mergeTag(
  database: T3Database,
  input: TagMergeRequest,
  options: { injectFailure?: () => void } = {},
): TagMergeResponse {
  const { vocabulary, keptTagId, mergedTagIds } = input;
  const tagTable = vocabulary === 'entry' ? 'tags' : 'producer_tags';
  const existing = database.prepare(
    `SELECT id FROM ${tagTable} WHERE id IN (${[keptTagId, ...mergedTagIds].map(() => '?').join(',')})`,
  ).pluck().all(keptTagId, ...mergedTagIds) as number[];
  if (existing.length !== mergedTagIds.length + 1) {
    throw new TagMergeError('kept or merged tag does not exist');
  }

  const tx = database.transaction((): TagMergeResponse => {
    let moved = 0; let skipped = 0;
    try {
      const r = moveAssignments(database, vocabulary, keptTagId, mergedTagIds);
      moved = r.moved; skipped = r.skipped;
    } catch (cause) {
      throw new Error(`stage=move: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    options.injectFailure?.();
    const deleted = database.prepare(`
      DELETE FROM ${tagTable} WHERE id IN (${mergedTagIds.map(() => '?').join(',')})
    `).run(...mergedTagIds).changes;
    return {
      keptTagId,
      movedAssignments: moved,
      skippedDuplicates: skipped,
      deletedTags: deleted,
    };
  });

  const result = tx.immediate();
  if (result.deletedTags !== mergedTagIds.length) {
    throw new TagMergeError('tag merge deleted an unexpected number of tags');
  }
  return result;
}
