/** Read-only: finds producer names that differ only by separators. */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeTag } from '../../packages/shared/src/normalize/tag.js';
import { planProducerMerges } from '../../apps/server/src/import/merge-producers.js';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', {
  readonly: true,
  fileMustExist: true,
});
const copyPath = join(mkdtempSync(join(tmpdir(), 't3-author-merge-')), 'library-copy.db');
await source.backup(copyPath);
source.close();
const db = new Database(copyPath);
const producers = db.prepare(`
  SELECT producer.id, producer.name,
    (SELECT COUNT(*) FROM entry_producers AS relation WHERE relation.producer_id = producer.id) AS work_count
  FROM producers AS producer
  ORDER BY producer.id
`).all() as Array<{ id: number; name: string; work_count: number }>;
console.log('producers:', producers.length);

/** Current merge key: NFKC + trim + collapse spaces + lowercase. */
const currentKey = (name: string) => normalizeTag(name);
/** Candidate key: separators behave like whitespace. */
const separatorKey = (name: string) => normalizeTag(name.replace(/[_\-.]+/gu, ' '));

const groupBy = (key: (name: string) => string) => {
  const groups = new Map<string, Array<{ id: number; name: string; work_count: number }>>();
  for (const producer of producers) {
    const k = key(producer.name);
    groups.set(k, [...(groups.get(k) ?? []), producer]);
  }
  return [...groups.entries()].filter(([, members]) => members.length > 1);
};

console.log('\n-- what the real plan endpoint returns today --');
const plans = planProducerMerges(db);
console.log('plans:', plans.length);
for (const plan of plans) {
  console.log(`  keeper "${plan.keeper.name}" (${plan.keeper.workCount} works) + ${plan.others.map((o) => `${o.name}(${o.workCount})`).join(', ')}${plan.canonicalName ? ` -> ${plan.canonicalName}` : ''}`);
}

console.log('\n-- detected by the CURRENT merge key --');
const currentGroups = new Map<string, number>();
for (const [key, members] of groupBy(currentKey)) {
  currentGroups.set(key, members.length);
  console.log(`  ${key}: ${members.map((m) => `${m.name}(${m.work_count})`).join(' + ')}`);
}

console.log('\n-- additionally detected when _ - . act as whitespace --');
for (const [key, members] of groupBy(separatorKey)) {
  const current = new Set(members.map((m) => currentKey(m.name)));
  if (current.size === 1 && currentGroups.has([...current][0]!)) continue;
  console.log(`  ${key}: ${members.map((m) => `${m.name}(${m.work_count})`).join(' + ')}`);
}

console.log('\n-- the reported pair --');
for (const name of ['arai_kazuki', 'Arai Kazuki']) {
  const match = producers.filter((p) => p.name === name);
  console.log(`  "${name}" ->`, match.length === 0 ? 'NOT PRESENT' : `#${match[0]!.id} (${match[0]!.work_count} works)`,
    '| current key:', currentKey(name), '| separator key:', separatorKey(name));
}
console.log('  taxonomy aliases for producer vocabulary:', db.prepare(
  "SELECT COUNT(*) FROM taxonomy_aliases WHERE vocabulary = 'producer'",
).pluck().get());

console.log('\n-- workaround: rename one row, then plan (on the copy) --');
db.prepare("UPDATE producers SET name = 'Arai Kazuki' WHERE id = 83").run();
for (const plan of planProducerMerges(db)) {
  console.log(`  keeper "${plan.keeper.name}" + ${plan.others.map((o) => `${o.name}(${o.workCount})`).join(', ')}${plan.canonicalName ? ` -> ${plan.canonicalName}` : ''} | renamed: ${plan.renamed}`);
}
db.prepare("UPDATE producers SET name = 'arai_kazuki' WHERE id = 83").run();

console.log('\n-- existing alias rows for the pair --');
for (const row of db.prepare(`
  SELECT id, alias_name, normalized_alias, canonical_name, normalized_canonical, partition
  FROM taxonomy_aliases
  WHERE vocabulary = 'producer'
    AND (normalized_alias IN (?, ?) OR normalized_canonical IN (?, ?))
  ORDER BY id
`).all(
  normalizeTag('arai_kazuki'), normalizeTag('Arai Kazuki'),
  normalizeTag('arai_kazuki'), normalizeTag('Arai Kazuki'),
)) {
  console.log('  ', JSON.stringify(row));
}

console.log('\n-- would an author alias make it detectable? (on the copy) --');
const existingAlias = db.prepare(
  "SELECT COUNT(*) FROM taxonomy_aliases WHERE vocabulary = 'producer' AND normalized_alias = ?",
).pluck().get(normalizeTag('arai_kazuki')) as number;
if (existingAlias > 0) {
  db.prepare(`
    UPDATE taxonomy_aliases SET canonical_name = 'Arai Kazuki', normalized_canonical = ?
    WHERE vocabulary = 'producer' AND normalized_alias = ?
  `).run(normalizeTag('Arai Kazuki'), normalizeTag('arai_kazuki'));
  console.log('  rewrote the existing alias to point at "Arai Kazuki"');
} else {
  db.prepare(`
    INSERT INTO taxonomy_aliases (vocabulary, partition, alias_name, normalized_alias, canonical_name, normalized_canonical, created_at, updated_at)
    VALUES ('producer', '', 'arai_kazuki', ?, 'Arai Kazuki', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(normalizeTag('arai_kazuki'), normalizeTag('Arai Kazuki'));
  console.log('  created the alias');
}
for (const plan of planProducerMerges(db)) {
  console.log(`  with alias: keeper "${plan.keeper.name}" + ${plan.others.map((o) => `${o.name}(${o.workCount})`).join(', ')}${plan.canonicalName ? ` -> ${plan.canonicalName}` : ''}`);
}

console.log('\n-- extra groups if separators were removed entirely --');
const strippedKey = (name: string) => normalizeTag(name).replace(/[_\-.]+/gu, '');
for (const [key, members] of groupBy(strippedKey)) {
  const current = new Set(members.map((m) => currentKey(m.name)));
  if (current.size === 1) continue;
  console.log(`  ${key}: ${members.map((m) => `${m.name}(${m.work_count})`).join(' + ')}`);
}
db.close();
