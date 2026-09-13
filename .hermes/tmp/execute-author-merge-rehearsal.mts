/**
 * Rehearses executing the Author merge on a COPY of the real library.
 * Run from apps/server: node_modules/.bin/tsx ../../.hermes/tmp/execute-author-merge-rehearsal.mts
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectDatabase } from '../../apps/server/src/database/doctor.js';
import {
  executeProducerMerges,
  planProducerMerges,
} from '../../apps/server/src/import/merge-producers.js';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', {
  readonly: true,
  fileMustExist: true,
});
const copyPath = join(mkdtempSync(join(tmpdir(), 't3-merge-exec-')), 'library-copy.db');
await source.backup(copyPath);
source.close();
const database = new Database(copyPath);

const producers = () => database.prepare('SELECT COUNT(*) FROM producers').pluck().get() as number;
const pair = () => database.prepare(`
  SELECT producer.id, producer.name,
    (SELECT COUNT(*) FROM entry_producers AS relation WHERE relation.producer_id = producer.id) AS works
  FROM producers AS producer
  WHERE producer.name IN ('arai_kazuki', 'Arai Kazuki')
  ORDER BY producer.id
`).all() as Array<{ id: number; name: string; works: number }>;
const sharedWorks = () => database.prepare(`
  SELECT entry_id FROM entry_producers WHERE producer_id IN (SELECT id FROM producers WHERE name IN ('arai_kazuki', 'Arai Kazuki'))
  GROUP BY entry_id HAVING COUNT(*) > 1
`).pluck().all() as number[];

console.log('before:', producers(), 'producers');
console.log('  pair:', pair());
console.log('  works linked to BOTH spellings:', sharedWorks().length);

database.pragma('foreign_keys = OFF');
try {
  const plans = planProducerMerges(database);
  console.log('plans:', plans.length);
  const executions = executeProducerMerges(database, plans);
  console.log('execution:', executions[0]);
} finally {
  database.pragma('foreign_keys = ON');
}

console.log('after:', producers(), 'producers');
console.log('  pair:', pair());
const keeper = pair()[0];
if (keeper) {
  console.log('  works on the survivor:', database.prepare(
    'SELECT COUNT(*) FROM entry_producers WHERE producer_id = ?',
  ).pluck().get(keeper.id));
  console.log('  producer tags kept:', database.prepare(
    'SELECT COUNT(*) FROM producer_tag_assignments WHERE producer_id = ?',
  ).pluck().get(keeper.id));
}
console.log('  duplicate links (must be 0):', database.prepare(`
  SELECT COUNT(*) FROM (
    SELECT entry_id, producer_id FROM entry_producers GROUP BY entry_id, producer_id HAVING COUNT(*) > 1
  )
`).pluck().get());
console.log('  foreign_key_check:', database.pragma('foreign_key_check'));
console.log('  doctor ok:', inspectDatabase(database).ok);
database.close();
