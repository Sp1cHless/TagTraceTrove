/** Read-only: state of the reported work and the multi-author bucket. */
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
const copyPath = join(mkdtempSync(join(tmpdir(), 't3-zenzero-')), 'library-copy.db');
await source.backup(copyPath);
source.close();
const db = new Database(copyPath);

console.log('-- entries matching the reported title --');
const entries = db.prepare(`
  SELECT id, title, type FROM entries
  WHERE title LIKE '%Phaethon%' OR title LIKE '%ZenZero%' OR title LIKE '%Gyaku Ra%'
  ORDER BY id
`).all() as Array<{ id: number; title: string; type: string }>;
for (const entry of entries) {
  const authors = db.prepare(`
    SELECT producer.id, producer.name,
      (SELECT COUNT(*) FROM entry_producers AS own WHERE own.producer_id = producer.id) AS works
    FROM entry_producers AS relation
    JOIN producers AS producer ON producer.id = relation.producer_id
    WHERE relation.entry_id = ?
    ORDER BY producer.id
  `).all(entry.id) as Array<{ id: number; name: string; works: number }>;
  console.log(`\n#${entry.id} [${entry.type}] ${entry.title}`);
  console.log(`  linked Authors (${authors.length}):`);
  for (const author of authors) {
    console.log(`    #${author.id} ${JSON.stringify(author.name)} — ${author.works} works`);
  }
}

console.log('\n-- producers named multiple author --');
for (const row of db.prepare(`
  SELECT producer.id, producer.name,
    (SELECT COUNT(*) FROM entry_producers AS own WHERE own.producer_id = producer.id) AS works
  FROM producers AS producer
  WHERE producer.name = 'multiple author'
  ORDER BY producer.id
`).all()) {
  console.log('  ', JSON.stringify(row));
}

console.log('\n-- producers named like a misspelling of the bucket --');
for (const row of db.prepare(`
  SELECT producer.id, producer.name,
    (SELECT COUNT(*) FROM entry_producers AS own WHERE own.producer_id = producer.id) AS works
  FROM producers AS producer
  WHERE producer.name LIKE '%ulti author%' OR producer.name LIKE '%mutiple%'
  ORDER BY producer.id
`).all()) {
  console.log('  ', JSON.stringify(row));
}
db.close();
