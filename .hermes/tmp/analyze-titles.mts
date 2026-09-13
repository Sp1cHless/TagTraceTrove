/**
 * Read-only classification of titles containing '|', to see whether a
 * "drop the romaji part before the separator" rule generalizes.
 * Run from apps/server: node_modules/.bin/tsx ../../.hermes/tmp/analyze-titles.mts
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', {
  readonly: true,
  fileMustExist: true,
});
const copyPath = join(mkdtempSync(join(tmpdir(), 't3-title-analysis-')), 'library-copy.db');
await source.backup(copyPath);
source.close();
const db = new Database(copyPath);

interface Row { id: number; title: string; type: string }
const entries = db.prepare('SELECT id, title, type FROM entries ORDER BY id').all() as Row[];
console.log('entries:', entries.length);

const hasHan = (value: string) => /\p{Script=Han}/u.test(value);
const hasKana = (value: string) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
const onlyAscii = (value: string) => /^[\x20-\x7E]*$/u.test(value);
const hasCjk = (value: string) => hasHan(value) || hasKana(value);

const kindOf = (value: string): string => {
  if (value.trim() === '') return 'empty';
  if (onlyAscii(value)) return 'ascii';
  if (hasCjk(value)) return 'cjk';
  return 'other';
};

interface Bucket { label: string; rows: Array<{ entry: Row; parts: string[] }> }
const buckets = new Map<string, Bucket>();
const add = (label: string, entry: Row, parts: string[]) => {
  const bucket = buckets.get(label) ?? { label, rows: [] };
  bucket.rows.push({ entry, parts });
  buckets.set(label, bucket);
};

const withPipe = entries.filter((entry) => entry.title.includes('|'));
console.log(`titles containing '|': ${withPipe.length}\n`);

for (const entry of withPipe) {
  const parts = entry.title.split('|').map((part) => part.trim());
  const [left = '', right = ''] = parts;
  if (parts.length > 2) {
    add(`3+ parts (${parts.length})`, entry, parts);
    continue;
  }
  if (parts.length === 1) {
    add('leading/trailing pipe only', entry, parts);
    continue;
  }
  const leftKind = kindOf(left);
  const rightKind = kindOf(right);
  if (rightKind === 'empty') {
    add('right side empty', entry, parts);
  } else if (leftKind === 'cjk' && rightKind === 'ascii') {
    add('reversed: CJK left | ascii right', entry, parts);
  } else if (rightKind === 'cjk' && leftKind !== 'cjk') {
    add('target: ascii left | CJK right', entry, parts);
  } else if (leftKind === 'ascii' && rightKind === 'ascii') {
    add('ambiguous: ascii | ascii', entry, parts);
  } else if (leftKind === 'cjk' && rightKind === 'cjk') {
    add('cjk | cjk', entry, parts);
  } else {
    add(`${leftKind} | ${rightKind}`, entry, parts);
  }
}

const truncated = (value: string, limit = 70) => (value.length <= limit ? value : `${value.slice(0, limit)}…`);

for (const bucket of [...buckets.values()].sort((a, b) => b.rows.length - a.rows.length)) {
  console.log(`\n=== ${bucket.label} — ${bucket.rows.length} entries ===`);
  for (const { entry, parts } of bucket.rows.slice(0, 8)) {
    const kept = parts.length > 1 ? parts.slice(1).join(' | ') : '(no right part)';
    console.log(`  #${entry.id} [${entry.type}] len ${entry.title.length} -> ${kept.length}`);
    console.log(`    before: ${truncated(entry.title)}`);
    console.log(`    after : ${truncated(kept)}`);
  }
  if (bucket.rows.length > 8) console.log(`  … ${bucket.rows.length - 8} more`);
}

console.log('\n=== full ambiguous list (ascii | ascii) ===');
for (const { entry, parts } of buckets.get('ambiguous: ascii | ascii')?.rows ?? []) {
  console.log(`  #${entry.id} left ${parts[0]!.length} / right ${parts[1]!.length}`);
  console.log(`    L: ${truncated(parts[0]!, 90)}`);
  console.log(`    R: ${truncated(parts[1]!, 90)}`);
}

console.log('\n=== what a "drop the left side" rule would change ===');
const ruleWouldChange = withPipe.filter((entry) => {
  const parts = entry.title.split('|').map((part) => part.trim());
  if (parts.length !== 2) return false;
  const [left = '', right = ''] = parts;
  return right !== '' && left !== '' && right !== entry.title;
});
console.log(`  candidates: ${ruleWouldChange.length} of ${withPipe.length} pipe titles (${entries.length} entries total)`);

console.log('\n=== authors most affected (target bucket) ===');
const target = buckets.get('target: ascii left | CJK right');
if (target) {
  const perAuthor = db.prepare(`
    SELECT producer.name, COUNT(*) AS hits
    FROM entry_producers AS relation
    JOIN producers AS producer ON producer.id = relation.producer_id
    WHERE relation.entry_id = ?
    GROUP BY producer.id
    ORDER BY hits DESC, producer.name COLLATE NOCASE
  `);
  const counts = new Map<string, number>();
  for (const { entry } of target.rows) {
    for (const row of perAuthor.all(entry.id) as Array<{ name: string; hits: number }>) {
      counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
    }
  }
  for (const [name, hits] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${name}: ${hits}`);
  }
  const lengths = target.rows.map(({ entry, parts }) => ({
    before: entry.title.length,
    after: parts.slice(1).join(' | ').length,
  }));
  const average = (values: number[]) => Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
  console.log(`  avg length ${average(lengths.map((l) => l.before))} -> ${average(lengths.map((l) => l.after))}`);

  console.log('\n=== Dokuneko Noil works ===');
  for (const row of db.prepare(`
    SELECT entry.id, entry.title FROM entry_producers AS relation
    JOIN entries AS entry ON entry.id = relation.entry_id
    JOIN producers AS producer ON producer.id = relation.producer_id
    WHERE producer.name LIKE '%Dokuneko%' OR producer.name LIKE '%Noil%'
    ORDER BY entry.id
  `).all() as Array<{ id: number; title: string }>) {
    console.log(`  #${row.id} ${truncated(row.title, 100)}`);
  }
}
db.close();
