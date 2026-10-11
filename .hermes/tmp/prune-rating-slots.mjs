// Report (and optionally delete) rating slots whose entry_type is not a real Gallery.
import { createRequire } from 'node:module';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/');
const Database = require('better-sqlite3');

const live = 'D:/Project/TagTraceTrove/apps/server/.data/library.db';
const remove = process.argv.includes('--delete');

const db = new Database(live);
const types = db.prepare('SELECT DISTINCT type FROM entries').all().map((r) => r.type);
console.log('galleries with entries:', JSON.stringify(types));

const slots = db.prepare('SELECT id, subject_kind, entry_type, name FROM rating_slots').all();
console.log(`\nall ${slots.length} rating slot rows:`);
for (const row of slots) {
  const known = types.includes(row.entry_type);
  console.log(`  ${known ? 'gallery ' : 'NOT A GALLERY'} ${JSON.stringify(row)}`);
}

const orphans = slots.filter((row) => !types.includes(row.entry_type));
if (!remove) {
  console.log('\n(dry run: pass --delete to remove the rows that are not a gallery)');
  db.close();
  process.exit(0);
}

const dropSlot = db.prepare('DELETE FROM rating_slots WHERE id = ?');
const dropLayout = db.prepare('DELETE FROM rating_slot_layouts WHERE entry_type = ? AND subject_kind = ?');
db.transaction(() => {
  for (const row of orphans) {
    console.log(`removing slot ${row.id} (${JSON.stringify(row.entry_type)} / ${row.name})`);
    dropSlot.run(row.id);
    console.log(`  rating_slot_layouts rows removed: ${dropLayout.run(row.entry_type, row.subject_kind).changes}`);
  }
})();

console.log('\nafter:');
for (const row of db.prepare('SELECT id, entry_type, name FROM rating_slots').all()) {
  console.log(' ', JSON.stringify(row));
}
db.close();
