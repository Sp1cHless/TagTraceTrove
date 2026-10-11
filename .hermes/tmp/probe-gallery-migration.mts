import { mkdtempSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryDatabase } from '../../apps/server/src/database/testing.js';
import { applyAllMigrations } from '../../apps/server/src/database/migrations.js';
import { createEntry, deleteEntry } from '../../apps/server/src/repositories/entry-repository.js';

const source = fileURLToPath(new URL('../../apps/server/src/database/migrations/', import.meta.url));
const previous = mkdtempSync(join(tmpdir(), 't3-v36-gallery-review-'));
const db = createMemoryDatabase();
try {
  for (const file of readdirSync(source).filter(name => /^\d+_.+\.sql$/.test(name) && Number(name.split('_')[0]) <= 36)) copyFileSync(join(source, file), join(previous, file));
  applyAllMigrations(db, previous);
  const e = createEntry(db, { title: 'Disposable old tombstone', type: 'OldReview' });
  deleteEntry(db, e.id);
  db.prepare("UPDATE sqlite_sequence SET seq=100000 WHERE name='sync_changes'").run();
  const triggerRows = () => db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all() as { name: string; sql: string }[];
  const before = new Map(triggerRows().map(row => [row.name, row.sql]));
  const tombstones = db.prepare('SELECT * FROM sync_tombstones').all();
  const result = applyAllMigrations(db);
  const after = new Map(triggerRows().map(row => [row.name, row.sql]));
  const canonical = (sql: string) => sql.replaceAll('"', '').replace(/\s+/g, ' ').trim();
  const missing = [...before.keys()].filter(name => !after.has(name));
  const changed = [...before.keys()].filter(name => after.has(name) && canonical(before.get(name)!) !== canonical(after.get(name)!));
  const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='sync_changes'").pluck().get();
  const fk = db.pragma('foreign_key_check');
  const currentTombstones = db.prepare('SELECT * FROM sync_tombstones').all();
  console.log(JSON.stringify({ migration: result, missingOldTriggers: missing, changedOldTriggers: changed, newTriggers: [...after.keys()].filter(name => !before.has(name)), journalSequence: seq, tombstonesPreserved: JSON.stringify(tombstones) === JSON.stringify(currentTombstones), foreignKeys: fk }, null, 2));
  if (missing.length || changed.length || Number(seq) < 100000 || fk.length || JSON.stringify(tombstones) !== JSON.stringify(currentTombstones)) process.exitCode = 1;
} finally { db.close(); rmSync(previous, { recursive: true, force: true }); }
