// Where do the literal strings 'manga' and 'movie' appear anywhere in the live copy?
// Every TEXT column of every table is scanned, so nothing that points at those types is missed.
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/');
const Database = require('better-sqlite3');

const scratch = 'D:/Project/TagTraceTrove/.hermes/tmp';
const copy = readdirSync(scratch).filter((name) => name.startsWith('live-copy-') && name.endsWith('.db')).sort().pop();
const db = new Database(`${scratch}/${copy}`, { readonly: true });
console.log('copy:', copy);

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all().map((row) => row.name);

for (const value of ['manga', 'movie']) {
  console.log(`\n=== rows whose text is exactly "${value}" ===`);
  for (const table of tables) {
    for (const column of db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all()) {
      if (!/TEXT/i.test(column.type) && column.type !== '') continue;
      let hits;
      try {
        hits = db.prepare(
          `SELECT COUNT(*) AS n FROM "${table}" WHERE "${column.name}" = ?`,
        ).get(value).n;
      } catch { continue; }
      if (hits > 0) console.log(`  ${table}.${column.name}: ${hits}`);
    }
  }
}

console.log('\n=== sections/facets of movie ===');
for (const row of db.prepare(
  "SELECT id, entry_type, name, group_kind, parent_id, sort_order FROM tag_groups WHERE entry_type IN ('manga','movie') ORDER BY entry_type, group_kind, id",
).all()) console.log(' ', JSON.stringify(row));

console.log('\n=== collections schema (for a manual look) ===');
console.log(db.prepare("SELECT sql FROM sqlite_master WHERE name='collections'").get().sql);
db.close();
