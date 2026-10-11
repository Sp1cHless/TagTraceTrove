// Read-only inspection of the live library: what exactly keeps `template专用` alive,
// and whether `小说` really has no rating slot. Works on a consistent backup copy.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/');
const Database = require('better-sqlite3');

const live = 'D:/Project/TagTraceTrove/apps/server/.data/library.db';
const scratch = 'D:/Project/TagTraceTrove/.hermes/tmp';
mkdirSync(scratch, { recursive: true });
const copy = join(scratch, `live-copy-${Date.now()}.db`);

const source = new Database(live, { readonly: true });
await source.backup(copy);
source.close();

const db = new Database(copy, { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all().map((r) => r.name);

const targets = ['template专用', '小说', '漫画'];

// Which tables carry an entry_type column at all?
const typed = [];
for (const table of tables) {
  const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all();
  const column = columns.find((c) => c.name === 'entry_type');
  if (column) typed.push(table);
}

console.log('copy:', copy);
console.log('tables with entry_type:', typed.join(', '));

for (const value of targets) {
  console.log(`\n=== ${value} ===`);
  for (const table of typed) {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM "${table}" WHERE entry_type = ?`,
    ).get(value);
    if (row.n > 0) console.log(`  ${table}: ${row.n}`);
  }
  const entries = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE type = ?').get(value);
  console.log(`  entries.type: ${entries.n}`);
}

console.log('\n--- tag_groups rows for template专用 / 小说 ---');
for (const row of db.prepare(
  `SELECT id, entry_type, name, group_kind, parent_id, sort_order
     FROM tag_groups WHERE entry_type IN ('template专用','小说') ORDER BY entry_type, group_kind, sort_order`,
).all()) {
  console.log(' ', JSON.stringify(row));
}

console.log('\n--- rating_slots rows for template专用 / 小说 ---');
const slotColumns = db.prepare('PRAGMA table_info(rating_slots)').all().map((c) => c.name);
console.log('  columns:', slotColumns.join(', '));
for (const row of db.prepare(
  `SELECT * FROM rating_slots WHERE entry_type IN ('template专用','小说')`,
).all()) {
  console.log(' ', JSON.stringify(row));
}

console.log('\n--- gallery_settings rows for template专用 / 小说 ---');
try {
  for (const row of db.prepare(
    `SELECT * FROM gallery_settings WHERE entry_type IN ('template专用','小说')`,
  ).all()) console.log(' ', JSON.stringify(row));
} catch (error) { console.log('  (no such query)', String(error)); }

console.log('\n--- rating_slot_layouts columns / rows ---');
const layoutColumns = db.prepare('PRAGMA table_info(rating_slot_layouts)').all().map((c) => c.name);
console.log('  columns:', layoutColumns.join(', '));

console.log('\n--- entry_tag_layouts for template专用 / 小说 ---');
try {
  for (const row of db.prepare(
    `SELECT * FROM entry_tag_layouts WHERE entry_type IN ('template专用','小说')`,
  ).all()) console.log(' ', JSON.stringify(row).slice(0, 300));
} catch (error) { console.log('  (no such query)', String(error)); }

db.close();
