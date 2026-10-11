
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = 'apps/web/src';
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (entry.endsWith('.vue')) files.push(path);
  }
})(root);
const DISPLAY_ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
const isNoise = (text) => {
  const t = text.trim();
  if (t === '') return true;
  if (!/[A-Za-z\u4e00-\u9fff]/.test(t)) return true;
  if (/^[×·—–/|:,.()[\]{}<>+*#@!?%&'"\u00b7-]+$/.test(t)) return true;
  return false;
};
const isExpression = (v) => /\bt\(|\{\{|=>|\?|\+|\|\||&&|\$t\(|^[a-zA-Z_$][\w$.]*\(/u.test(v);
const findings = [];
for (const path of files) {
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf('<template>');
  const end = source.lastIndexOf('</template>');
  if (start === -1 || end === -1) continue;
  const body = source.slice(start, end);
  const lineOf = (index) => source.slice(0, start + index).split('\n').length;
  // Whole-template pass: text nodes may span lines.
  const stripped = body.replace(/\{\{(?:(?!\}\})[\s\S])*\}\}/gu, ' ');
  for (const match of stripped.matchAll(/>([^<>]+)</gu)) {
    if (!isNoise(match[1])) findings.push({ file: path, line: lineOf(match.index), kind: 'text', text: match[1].replace(/\s+/g, ' ').trim().slice(0, 70) });
  }
  for (const attr of DISPLAY_ATTRS) {
    for (const match of body.matchAll(new RegExp(`(?<![\w:.-])${attr}="([^"]*)"`, 'gu'))) {
      if (isExpression(match[1])) continue;
      if (!isNoise(match[1])) findings.push({ file: path, line: lineOf(match.index), kind: attr, text: match[1].slice(0, 70) });
    }
  }
}
const byFile = new Map();
for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
console.log(`findings: ${findings.length} in ${byFile.size} files\n`);
for (const [file, rows] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${relative('.', file)} (${rows.length})`);
  for (const row of rows.slice(0, 12)) console.log(`  ${row.line}  [${row.kind}] ${row.text}`);
  if (rows.length > 12) console.log(`  ... ${rows.length - 12} more`);
  console.log('');
}
