/** Read-only: reproduces the batch-review query for the reported imports. */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryEntryPage } from '../../apps/server/src/repositories/entry-tag-repository.js';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', {
  readonly: true,
  fileMustExist: true,
});
const copyPath = join(mkdtempSync(join(tmpdir(), 't3-batch-review-query-')), 'library-copy.db');
await source.backup(copyPath);
source.close();
const database = new Database(copyPath);

const ids = [1099, 1100, 1101, 1102, 1103, 1104, 1105, 1106, 1107, 1108, 1109, 1110];
const query = (entryType?: string) => queryEntryPage(database, {
  ...(entryType === undefined ? {} : { entryType }),
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

for (const entryType of ['Comic', 'comic', 'COMIC', undefined]) {
  const result = query(entryType);
  console.log(`entryType=${JSON.stringify(entryType)} -> ${result.items.length} items (total ${result.total})`,
    result.items.slice(0, 3).map((item) => `#${item.id}`).join(' '));
}

// The same query with the ids the *other* reported import produced.
const haruhisky = database.prepare(`
  SELECT entry.id FROM entry_producers AS relation
  JOIN entries AS entry ON entry.id = relation.entry_id
  JOIN producers AS producer ON producer.id = relation.producer_id
  WHERE producer.name = 'Haruhisky' COLLATE NOCASE
  ORDER BY entry.id DESC LIMIT 6
`).pluck().all() as number[];
for (const entryType of ['Comic', 'comic']) {
  const result = queryEntryPage(database, {
    entryType,
    conditions: [],
    authorIds: [],
    ratingConditions: [],
    ratingSort: null,
    usageConditions: [],
    usageSort: null,
    entryIds: haruhisky,
    sort: 'source-order',
    page: 1,
    pageSize: 100,
  } as never);
  console.log(`Haruhisky ids ${haruhisky.length} with entryType=${entryType} -> ${result.items.length} items`);
}
database.close();
