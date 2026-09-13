/**
 * Smoke-tests the Author-rating sort on a COPY of the real library.
 * Run from apps/server: node_modules/.bin/tsx ../../.hermes/tmp/author-rating-sort-rehearsal.mts
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryEntryPage } from '../../apps/server/src/repositories/entry-tag-repository.js';
import type { EntryPageQueryRequest } from '@t3/shared';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', {
  readonly: true,
  fileMustExist: true,
});
const copyPath = join(mkdtempSync(join(tmpdir(), 't3-author-sort-')), 'library-copy.db');
await source.backup(copyPath);
source.close();

const database = new Database(copyPath);
const slot = database.prepare(`
  SELECT slot.id, slot.name, slot.entry_type, COUNT(value.stars) AS rated
  FROM rating_slots AS slot
  LEFT JOIN entry_rating_values AS value ON value.slot_id = slot.id AND value.stars IS NOT NULL
  WHERE slot.subject_kind = 'entry' AND slot.entry_type = 'Comic'
  GROUP BY slot.id
  ORDER BY rated DESC, slot.id
  LIMIT 1
`).get() as { id: number; name: string; entry_type: string; rated: number };
console.log(`slot #${slot.id} "${slot.name}" in Gallery ${slot.entry_type} with ${slot.rated} rated works`);
console.log('rated Author values in this library:', database.prepare(
  'SELECT COUNT(*) FROM producer_rating_values WHERE stars IS NOT NULL',
).pluck().get());

const sortedBy = (applyAuthorRating: boolean) => queryEntryPage(database, {
  entryType: 'Comic',
  conditions: [],
  authorIds: [],
  ratingConditions: [],
  ratingSort: { slotId: slot.id, direction: 'desc', applyAuthorRating },
  usageConditions: [],
  usageSort: null,
  sort: 'title-asc',
  page: 1,
  pageSize: 10,
} as EntryPageQueryRequest);

const entryOnly = sortedBy(false);
const authorFallback = sortedBy(true);
const titles = (result: { items: Array<{ title: string }> }) => result.items.map((item) => item.title);
const starsOf = database.prepare(
  'SELECT stars FROM entry_rating_values WHERE entry_id = ? AND slot_id = ?',
);
const withStars = entryOnly.items.slice(0, 8).map((item) => {
  const stars = starsOf.pluck().get(item.id, slot.id) as number | null | undefined;
  return `${item.title} = ${stars === null || stars === undefined ? 'unrated' : stars}`;
});
console.log('total Comic entries:', entryOnly.total);
console.log('entry-only order (title = own stars):');
for (const line of withStars) console.log('  ', line);
console.log('author-fallback order identical:', JSON.stringify(titles(entryOnly)) === JSON.stringify(titles(authorFallback)));
database.close();
