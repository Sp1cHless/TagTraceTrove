/**
 * Rehearses the multi-author conversion against a COPY of the real library.
 * Run from apps/server: node_modules/.bin/tsx ../../.hermes/tmp/multi-author-rehearsal.mts
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertEntryAuthorsToMultiAuthor } from '../../apps/server/src/repositories/entry-multi-author-repository.js';
import { findProducers } from '../../apps/server/src/repositories/producer-tag-repository.js';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', {
  readonly: true,
  fileMustExist: true,
});
const copyPath = join(mkdtempSync(join(tmpdir(), 't3-multi-author-')), 'library-copy.db');
await source.backup(copyPath);
source.close();
console.log('rehearsal copy:', copyPath);

const database = new Database(copyPath);
const visible = () => findProducers(database).length;
const stored = () => (database.prepare('SELECT COUNT(*) FROM producers').pluck().get() as number);

console.log(`before: ${stored()} stored Authors, ${visible()} visible`);

const anthologies = database.prepare(`
  SELECT e.id, e.title,
    (SELECT COUNT(*) FROM entry_producers r WHERE r.entry_id = e.id) AS authors
  FROM entries e
  WHERE authors > 1
  ORDER BY authors DESC
`).all() as Array<{ id: number; title: string; authors: number }>;

/** Authors who appear ONLY in multi-Author works: the case this rule targets. */
const anthologyOnly = () => database.prepare(`
  SELECT COUNT(*) FROM producers p
  WHERE EXISTS (SELECT 1 FROM entry_producers r WHERE r.producer_id = p.id)
    AND NOT EXISTS (
      SELECT 1 FROM entry_producers r
      WHERE r.producer_id = p.id
        AND (SELECT COUNT(*) FROM entry_producers x WHERE x.entry_id = r.entry_id) = 1
    )
`).pluck().get() as number;
console.log(`Authors whose every work is an anthology work: ${anthologyOnly()}`);

for (const work of anthologies) {
  const result = convertEntryAuthorsToMultiAuthor(database, work.id);
  const left = database.prepare(
    'SELECT COUNT(*) FROM entry_producers WHERE entry_id = ?',
  ).pluck().get(work.id) as number;
  console.log(`\n#${work.id} ${work.title}\n  ${work.authors} Authors`
    + ` -> absorbed ${result.convertedAuthors.length}, now ${left} link(s),`
    + ` multiAuthorId ${result.multiAuthorId}`);
}

console.log(`\nafter: ${stored()} stored Authors, ${visible()} visible`);
console.log(`Authors whose every work is an anthology work: ${anthologyOnly()}`);
const leftover = database.prepare(`
  SELECT COUNT(*) FROM producers p
  WHERE (SELECT COUNT(*) FROM entry_producers own WHERE own.producer_id = p.id) = 0
`).pluck().get() as number;
console.log(`stored Authors with no work left: ${leftover} (hidden from every list, rows intact)`);
console.log('multi-author Author works:', database.prepare(
  "SELECT COUNT(*) FROM entry_producers r JOIN producers p ON p.id = r.producer_id WHERE p.name = 'multiple author'",
).pluck().get());

database.close();
