import { createMigratedMemoryDatabase } from './src/database/testing.js';
import { importSiteDictionaries } from './src/taxonomy/import-dictionaries.js';

const database = createMigratedMemoryDatabase();
const insert = database.prepare(`INSERT INTO taxonomy_aliases
  (vocabulary, partition, alias_name, normalized_alias, canonical_name, normalized_canonical)
  VALUES (?, ?, ?, ?, ?, ?)`);

// The shape the user's library holds: rows imported by hand, with the tool's partitions, mixed
// English → Chinese, Traditional spellings, placeholders, and two aliases sharing a canonical.
const partitions = ['series', 'characters', 'types', 'tags'];
for (let i = 0; i < 2600; i += 1) {
  const partition = partitions[i % partitions.length]!;
  const canonical = i % 3 === 0 ? '' : `角色${i % 300}`;
  insert.run('entry', partition, `Alias ${i}`, `alias ${i}`, canonical, canonical.toLowerCase());
}
// A Traditional-keyed row and its Simplified twin, the case the rewrite has to fold.
insert.run('entry', 'tags', '乳膠衣', '乳膠衣', '內衣', '內衣');
insert.run('entry', 'tags', '乳胶衣', '乳胶衣', '', '');
for (let i = 0; i < 1500; i += 1) {
  insert.run('producer', 'authors', `Author ${i}`, `author ${i}`, '', '');
}
console.log('rows before:', (database.prepare('SELECT COUNT(*) AS n FROM taxonomy_aliases').get() as { n: number }).n);

try {
  const result = importSiteDictionaries(database, 'D:/Project/TagTraceTrove/apps/server/.data/siteprobe/export');
  console.log('ok', JSON.stringify(result));
} catch (error) {
  console.log('THREW:', (error as Error).constructor.name, (error as Error).message);
}
database.close();
