/** Read-only: reproduces the batch-review query for the most recent imports. */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryEntryPage } from '../../apps/server/src/repositories/entry-tag-repository.js';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3') as typeof import('better-sqlite3');
const { entryPageResponseSchema } = require('@t3/shared') as typeof import('@t3/shared');

const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', {
  readonly: true,
  fileMustExist: true,
});
const copyPath = join(mkdtempSync(join(tmpdir(), 't3-batch-review2-')), 'library-copy.db');
await source.backup(copyPath);
source.close();
const database = new Database(copyPath);

console.log('-- newest 12 entries with their authors --');
const newest = database.prepare(`
  SELECT entry.id, entry.type, entry.cover_ref, entry.preview_ref, entry.preview_refs, entry.title,
    (SELECT GROUP_CONCAT(producer.name, ' / ') FROM entry_producers AS relation
      JOIN producers AS producer ON producer.id = relation.producer_id
      WHERE relation.entry_id = entry.id) AS authors
  FROM entries AS entry ORDER BY entry.id DESC LIMIT 12
`).all() as Array<{
  id: number; type: string; cover_ref: string | null; preview_ref: string | null;
  preview_refs: string | null; title: string; authors: string | null;
}>;
for (const row of newest) {
  console.log(`  #${row.id} [${row.type}] cover=${JSON.stringify(row.cover_ref)} preview=${JSON.stringify(row.preview_ref)} previews=${JSON.stringify(row.preview_refs)}`);
  console.log(`      ${row.title.slice(0, 50)} | ${row.authors ?? '(no author)'}`);
}

// Replays exactly what the review asks for: the newest ids of one Gallery,
// ordered by the id list, without any Gallery-type filter.
const ids = newest.filter((row) => row.type === newest[0]!.type).map((row) => row.id);
console.log(`\n-- replaying the batch-review query for ${ids.length} ids --`);
try {
  const result = queryEntryPage(database, {
    conditions: [],
    authorIds: [],
    ratingConditions: [],
    ratingSort: null,
    usageConditions: [],
    usageSort: null,
    entryIds: ids,
    sort: 'source-order',
    page: 1,
    pageSize: 100,
  } as never);
  console.log('items:', result.items.length, 'total:', result.total);
  console.log('first:', JSON.stringify(result.items[0] ?? null));
  const parsed = entryPageResponseSchema.safeParse(result);
  console.log('response schema accepts it:', parsed.success);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 5)) {
      console.log('  issue:', issue.path.join('.'), '-', issue.message);
    }
  }
} catch (cause) {
  console.log('QUERY FAILED:', (cause as Error).message);
}
database.close();
