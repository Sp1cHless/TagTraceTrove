/** Read-only: types of the recently imported authors' entries vs stored Gallery spellings. */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', {
  readonly: true,
  fileMustExist: true,
});
const copyPath = join(mkdtempSync(join(tmpdir(), 't3-batch-review-')), 'library-copy.db');
await source.backup(copyPath);
source.close();
const db = new Database(copyPath);

console.log('-- stored Gallery types --');
for (const row of db.prepare('SELECT type, COUNT(*) AS n FROM entries GROUP BY type ORDER BY n DESC').all()) {
  console.log(`  ${JSON.stringify(row.type)} — ${row.n} entries`);
}

for (const author of ['Hato Devilbu', 'Haruhisky']) {
  console.log(`\n-- ${author} --`);
  const rows = db.prepare(`
    SELECT entry.id, entry.type, entry.title,
      (SELECT COUNT(*) FROM entry_contents AS content WHERE content.entry_id = entry.id) AS contents
    FROM entry_producers AS relation
    JOIN entries AS entry ON entry.id = relation.entry_id
    JOIN producers AS producer ON producer.id = relation.producer_id
    WHERE producer.name = ? COLLATE NOCASE
    ORDER BY entry.id DESC
    LIMIT 8
  `).all(author) as Array<{ id: number; type: string; title: string; contents: number }>;
  for (const row of rows) {
    console.log(`  #${row.id} [${JSON.stringify(row.type)}] contents=${row.contents} ${row.title.slice(0, 60)}`);
  }
  const total = db.prepare(`
    SELECT COUNT(*) FROM entry_producers AS relation
    JOIN producers AS producer ON producer.id = relation.producer_id
    WHERE producer.name = ? COLLATE NOCASE
  `).pluck().get(author);
  console.log(`  total works: ${total}`);
}

console.log('\n-- case-insensitive type collisions (would break an exact match) --');
for (const row of db.prepare(`
  SELECT lower(trim(type)) AS folded, COUNT(DISTINCT type) AS spellings, GROUP_CONCAT(DISTINCT type) AS names
  FROM entries GROUP BY folded HAVING spellings > 1
`).all()) {
  console.log('  ', JSON.stringify(row));
}
db.close();
