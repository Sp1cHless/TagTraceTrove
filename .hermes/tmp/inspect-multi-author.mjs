import { createRequire } from 'node:module';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3');

const db = new Database('apps/server/.data/library.db', { readonly: true });
const q = (sql) => db.prepare(sql).all();

console.log('entries:', q('SELECT COUNT(*) AS n FROM entries')[0].n);
console.log('producers:', q('SELECT COUNT(*) AS n FROM producers')[0].n);
console.log('links:', q('SELECT COUNT(*) AS n FROM entry_producers')[0].n);

console.log('\n-- entries by producer count --');
for (const row of q(`
  SELECT n AS producerCount, COUNT(*) AS entries
  FROM (SELECT entry_id, COUNT(*) AS n FROM entry_producers GROUP BY entry_id)
  GROUP BY n ORDER BY n
`)) console.log(`  ${row.producerCount} author(s): ${row.entries} entries`);

console.log('\n-- producers by entry count (top) --');
for (const row of q(`
  SELECT n AS entryCount, COUNT(*) AS producers
  FROM (SELECT producer_id, COUNT(*) AS n FROM entry_producers GROUP BY producer_id)
  GROUP BY n ORDER BY n LIMIT 8
`)) console.log(`  ${row.entryCount} work(s): ${row.producers} producers`);

console.log('\n-- multi-author entries (up to 12) --');
for (const row of q(`
  SELECT e.id, e.title, e.type,
    (SELECT GROUP_CONCAT(p.name, ' | ') FROM entry_producers r JOIN producers p ON p.id = r.producer_id WHERE r.entry_id = e.id) AS authors,
    (SELECT COUNT(*) FROM entry_producers r WHERE r.entry_id = e.id) AS n
  FROM entries e
  WHERE n > 1
  ORDER BY n DESC, e.id
  LIMIT 12
`)) console.log(`  #${row.id} [${row.type}] ${row.title}\n     (${row.n}) ${row.authors}`);

console.log('\n-- authors whose ONLY work is a multi-author work --');
console.log('  count:', q(`
  SELECT COUNT(*) AS n FROM (
    SELECT r.producer_id
    FROM entry_producers r
    GROUP BY r.producer_id
    HAVING COUNT(*) = 1
      AND (SELECT COUNT(*) FROM entry_producers x WHERE x.entry_id = r.entry_id) > 1
  )
`)[0].n);

console.log('\n-- examples --');
for (const row of q(`
  SELECT p.id AS pid, p.name, e.id AS eid, e.title, (SELECT COUNT(*) FROM entry_producers x WHERE x.entry_id = e.id) AS authorsInWork
  FROM entry_producers r
  JOIN producers p ON p.id = r.producer_id
  JOIN entries e ON e.id = r.entry_id
  GROUP BY r.producer_id
  HAVING COUNT(*) = 1 AND authorsInWork > 1
  ORDER BY authorsInWork DESC, p.name
  LIMIT 12
`)) console.log(`  #${row.pid} "${row.name}" -> #${row.eid} ${row.title} (${row.authorsInWork} authors)`);

db.close();
