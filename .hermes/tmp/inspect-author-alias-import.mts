/** Read-only: inspects one author's aliases and how the import would resolve them. */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProducers } from '../../apps/server/src/repositories/producer-tag-repository.js';
import { resolveTaxonomyName } from '../../apps/server/src/repositories/taxonomy-repository.js';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3') as typeof import('better-sqlite3');
const { normalizeTag } = require('@t3/shared') as typeof import('@t3/shared');

const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', {
  readonly: true,
  fileMustExist: true,
});
const copyPath = join(mkdtempSync(join(tmpdir(), 't3-alias-import-')), 'library-copy.db');
await source.backup(copyPath);
source.close();
const database = new Database(copyPath);

const needle = process.argv[2] ?? '和泉';
console.log(`-- producers matching "${needle}" --`);
for (const row of database.prepare(`
  SELECT producer.id, producer.name,
    (SELECT COUNT(*) FROM entry_producers AS relation WHERE relation.producer_id = producer.id) AS works
  FROM producers AS producer WHERE producer.name LIKE ? ORDER BY producer.id
`).all(`%${needle}%`)) {
  console.log('  ', JSON.stringify({ ...row, normalized: normalizeTag(String(row.name)) }));
}

console.log(`\n-- alias rows mentioning "${needle}" (either side) --`);
for (const row of database.prepare(`
  SELECT id, partition, alias_name, normalized_alias, canonical_name, normalized_canonical
  FROM taxonomy_aliases
  WHERE vocabulary = 'producer' AND (alias_name LIKE ? OR canonical_name LIKE ?)
  ORDER BY id
`).all(`%${needle}%`, `%${needle}%`)) {
  console.log('  ', JSON.stringify(row));
}

console.log(`\n-- aliases that resolve to each matching producer --`);
for (const row of database.prepare(`
  SELECT producer.name AS producer, producer.id AS id,
    (SELECT GROUP_CONCAT(alias_name, ' / ') FROM taxonomy_aliases AS alias
      WHERE alias.vocabulary = 'producer' AND alias.normalized_canonical = ?) AS aliases
  FROM producers AS producer WHERE producer.name LIKE ? ORDER BY producer.id
`).all(normalizeTag(needle), `%${needle}%`)) {
  console.log('  ', JSON.stringify(row));
}

console.log('\n-- how the server resolves candidate spellings --');
for (const spelling of [needle, 'izumi', 'いずみ', 'Izumi']) {
  console.log(`  "${spelling}" -> "${resolveTaxonomyName(database, 'producer', spelling)}"`);
}

console.log('\n-- visible authors whose name matches a resolved canonical --');
const visible = findProducers(database, {});
const canonical = resolveTaxonomyName(database, 'producer', needle);
const target = normalizeTag(canonical);
console.log(`  canonical for "${needle}": "${canonical}" (normalized "${target}")`);
for (const author of visible.filter((item) => normalizeTag(item.name) === target)) {
  console.log('   visible match:', JSON.stringify({ id: author.id, name: author.name }));
}
if (!visible.some((item) => normalizeTag(item.name) === target)) {
  console.log('   NO visible author carries that name (the import review cannot preselect it)');
}
database.close();
