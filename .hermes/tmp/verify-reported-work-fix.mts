/** Rehearses the fix on the reported work, on a COPY of the live library. */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEntryDetail } from '../../apps/server/src/repositories/entry-repository.js';
import { convertEntryAuthorsToMultiAuthor } from '../../apps/server/src/repositories/entry-multi-author-repository.js';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', {
  readonly: true,
  fileMustExist: true,
});
const copyPath = join(mkdtempSync(join(tmpdir(), 't3-1413-fix-')), 'library-copy.db');
await source.backup(copyPath);
source.close();
const database = new Database(copyPath);

const entryId = 643;
const describe = () => (getEntryDetail(database, entryId)?.producers ?? [])
  .map((producer) => `${producer.name}(${producer.entryCount})`);

console.log(`#${entryId} before:`, describe());
const first = convertEntryAuthorsToMultiAuthor(database, entryId);
console.log(`  absorbed ${first.convertedAuthors.length}:`,
  first.convertedAuthors.map((author) => author.name).join(', '));
console.log(`#${entryId} after :`, describe());

const repeated = convertEntryAuthorsToMultiAuthor(database, entryId);
console.log('  repeated click ->', JSON.stringify({
  converted: repeated.convertedAuthors.length,
  multiAuthorId: repeated.multiAuthorId,
}));
database.close();
