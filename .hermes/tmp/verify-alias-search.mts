/** Read-only: searches the real library by an author alias spelling. */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryProducerPage } from '../../apps/server/src/repositories/producer-tag-repository.js';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', {
  readonly: true,
  fileMustExist: true,
});
const copyPath = join(mkdtempSync(join(tmpdir(), 't3-alias-search-')), 'library-copy.db');
await source.backup(copyPath);
source.close();
const database = new Database(copyPath);

const query = process.argv[2] ?? 'ishikei';
console.log(`-- aliases whose spelling contains "${query}" --`);
for (const row of database.prepare(`
  SELECT alias_name, canonical_name, normalized_canonical FROM taxonomy_aliases
  WHERE vocabulary = 'producer' AND (alias_name LIKE ? OR canonical_name LIKE ?)
  ORDER BY alias_name LIMIT 6
`).all(`%${query}%`, `%${query}%`)) {
  console.log('  ', JSON.stringify(row));
}

const search = (searchQuery: string) => queryProducerPage(database, {
  searchQuery,
  ownTagIds: [],
  relatedEntryTagIds: [],
  includeNsfw: true,
  sort: 'relevance',
  page: 1,
  pageSize: 10,
} as never);

for (const needle of [query, 'ishikeii', 'zzzznotfound']) {
  const result = search(needle);
  console.log(`search "${needle}" -> ${result.total}:`,
    result.items.map((item) => `${item.name} (${item.id})`).join(', ') || '(nothing)');
}
database.close();
