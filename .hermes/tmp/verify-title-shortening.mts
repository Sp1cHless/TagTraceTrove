/** Read-only rehearsal of the title-shortening plan on a COPY of the live library. */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyTitleShortening,
  planTitleShortening,
} from '../../apps/server/src/repositories/title-shortening-repository.js';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', {
  readonly: true,
  fileMustExist: true,
});
const copyPath = join(mkdtempSync(join(tmpdir(), 't3-titles-')), 'library-copy.db');
await source.backup(copyPath);
source.close();
const database = new Database(copyPath);

const total = database.prepare('SELECT COUNT(*) FROM entries').pluck().get() as number;
const withPipe = database.prepare("SELECT COUNT(*) FROM entries WHERE title LIKE '%|%'").pluck().get() as number;
console.log(`entries ${total}, titles containing '|': ${withPipe}`);

const plan = planTitleShortening(database);
const bySuggestion = (side: 'front' | 'back' | null) => plan.candidates.filter((c) => c.suggested === side);
console.log(`plan: ${plan.candidates.length} candidates —`
  + ` keep back ${bySuggestion('back').length},`
  + ` keep front ${bySuggestion('front').length},`
  + ` undecided ${bySuggestion(null).length}`);

console.log('\nsuggested: keep FRONT (Korean on the other side)');
for (const candidate of bySuggestion('front')) {
  console.log(`  #${candidate.entryId}`);
  console.log(`    keep   ${candidate.keepFront}`);
  console.log(`    drop   ${candidate.keepBack}`);
}

console.log('\nundecided (both sides ASCII)');
for (const candidate of bySuggestion(null)) {
  console.log(`  #${candidate.entryId} front "${candidate.keepFront.slice(0, 40)}" | back "${candidate.keepBack.slice(0, 40)}"`);
}

const changes = plan.candidates.flatMap((candidate) => {
  if (candidate.suggested === null) return [];
  const shortenedTitle = candidate.suggested === 'front' ? candidate.keepFront : candidate.keepBack;
  if (shortenedTitle === candidate.title) return [];
  return [{ entryId: candidate.entryId, title: candidate.title, shortenedTitle }];
});
const lengths = changes.map((change) => ({ before: change.title.length, after: change.shortenedTitle.length }));
const average = (values: number[]) => Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
console.log(`\napplying ${changes.length} suggested choices: average length`
  + ` ${average(lengths.map((l) => l.before))} -> ${average(lengths.map((l) => l.after))}`);

const applied = applyTitleShortening(database, changes);
console.log('applied:', applied);
const remaining = planTitleShortening(database);
console.log(`remaining plan: ${remaining.candidates.length} candidates`
  + ` (undecided ${remaining.candidates.filter((c) => c.suggested === null).length})`);
const longCount = database.prepare('SELECT COUNT(*) FROM entries WHERE LENGTH(title) > 80').pluck().get() as number;
console.log(`titles still longer than 80 chars: ${longCount}`);
database.close();
