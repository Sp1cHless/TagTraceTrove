/**
 * Reproduces importing a work credited to an ALIAS spelling, on a COPY.
 * Run from apps/server: node_modules/.bin/tsx ../../.hermes/tmp/reproduce-alias-import.mts 冷泉
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitImportBatch } from '../../apps/server/src/import/commit.js';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const aliasSpelling = process.argv[2] ?? '冷泉';
const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', {
  readonly: true,
  fileMustExist: true,
});
const copyPath = join(mkdtempSync(join(tmpdir(), 't3-alias-commit-')), 'library-copy.db');
await source.backup(copyPath);
source.close();
const database = new Database(copyPath);

const rowsNamed = () => database.prepare(`
  SELECT producer.id, producer.name,
    (SELECT COUNT(*) FROM entry_producers AS relation WHERE relation.producer_id = producer.id) AS works
  FROM producers AS producer WHERE producer.name LIKE '%和泉%' ORDER BY producer.id
`).all() as Array<{ id: number; name: string; works: number }>;
console.log('before:', JSON.stringify(rowsNamed()));

// Exactly what the API receives when the review did not preselect a match
// (createUnmatched on, no reviewed existing ids) for an alias spelling.
const section = database.prepare(
  "SELECT id, name FROM tag_groups WHERE group_kind = 'section' AND entry_type = 'Comic' ORDER BY id LIMIT 1",
).get() as { id: number; name: string };
const facet = database.prepare(
  "SELECT id FROM tag_groups WHERE group_kind = 'facet' AND parent_id = ? ORDER BY id LIMIT 1",
).pluck().get(section.id) as number;

const result = commitImportBatch(database, {
  source: 'hitomi.la',
  warnings: [],
  entries: [{
    externalKey: 'hitomi.la:900001',
    title: 'Work credited to an alias spelling',
    fields: { authors: [aliasSpelling] },
    sources: [{ label: 'hitomi.la', url: 'https://hitomi.la/cg/alias-test-900001.html' }],
  }],
}, {
  entryType: 'Comic',
  canonicalTagFacetId: facet,
  sourceContentType: 'Source URL',
  externalKeyContentType: 'External Key',
  fieldMappings: {
    authors: { kind: 'producer', createUnmatched: true, existingProducerIds: {} },
  },
  ignoredFields: [],
  authorRatings: [],
});

console.log('commit:', JSON.stringify({
  entryCount: result.entryCount,
  createdProducerCount: result.createdProducerCount,
  producerLinkCount: result.producerLinkCount,
}));
console.log('after :', JSON.stringify(rowsNamed()));
const entryId = result.entries[0]?.entryId;
if (entryId !== undefined) {
  console.log('linked authors of the new work:', JSON.stringify(database.prepare(`
    SELECT producer.id, producer.name FROM entry_producers AS relation
    JOIN producers AS producer ON producer.id = relation.producer_id
    WHERE relation.entry_id = ?
  `).all(entryId)));
}
database.close();
