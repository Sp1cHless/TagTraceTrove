// What keeps `manga` and `movie` in Advanced Settings, on a fresh consistent copy of the live library.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/');
const Database = require('better-sqlite3');
const scratch = 'D:/Project/TagTraceTrove/.hermes/tmp';
mkdirSync(scratch, { recursive: true });
const copy = join(scratch, `live-copy-${Date.now()}.db`);

const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', { readonly: true });
await source.backup(copy);
source.close();

const db = new Database(copy, { readonly: true });
const targets = ['manga', 'movie'];
console.log('copy:', copy);

for (const value of targets) {
  console.log(`\n=== ${value} ===`);
  console.log('  entries of this type:', db.prepare('SELECT COUNT(*) AS n FROM entries WHERE type = ?').get(value).n);
  const sections = db.prepare(
    "SELECT id, name, sort_order FROM tag_groups WHERE entry_type = ? AND group_kind = 'section' ORDER BY sort_order, id",
  ).all(value);
  const facets = db.prepare(
    "SELECT id, name, parent_id FROM tag_groups WHERE entry_type = ? AND group_kind = 'facet' ORDER BY id",
  ).all(value);
  console.log('  sections:', JSON.stringify(sections));
  console.log('  facets:', JSON.stringify(facets));
  console.log('  tag assignments on its facets:', db.prepare(
    "SELECT COUNT(*) AS n FROM entry_tags AS t JOIN tag_groups AS g ON g.id = t.facet_id WHERE g.entry_type = ?",
  ).get(value).n);
  console.log('  rating_slots:', JSON.stringify(db.prepare('SELECT id, subject_kind, name FROM rating_slots WHERE entry_type = ?').all(value)));
  console.log('  rating_slot_layouts:', db.prepare('SELECT COUNT(*) AS n FROM rating_slot_layouts WHERE entry_type = ?').get(value).n);
  console.log('  entry_tag_layouts:', JSON.stringify(db.prepare('SELECT entry_type, sync_version FROM entry_tag_layouts WHERE entry_type = ?').all(value)));
  console.log('  gallery_settings:', db.prepare('SELECT COUNT(*) AS n FROM gallery_settings WHERE entry_type = ?').get(value).n);
  console.log('  collections scoped to it:', db.prepare(
    "SELECT COUNT(*) AS n FROM collections WHERE scope = 'gallery' AND scope_value = ?",
  ).get(value).n);
}
db.close();
