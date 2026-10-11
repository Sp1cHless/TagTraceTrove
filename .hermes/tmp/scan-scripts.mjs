
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
const findings = [];
for (const path of files) {
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf('<script');
  const end = source.indexOf('</script>');
  if (start === -1 || end === -1) continue;
  const body = source.slice(start, end);
  const lineOffset = source.slice(0, start).split('\n').length - 1;
  body.split('\n').forEach((line, index) => {
    if (/^\s*(\/\/|\*)/u.test(line)) return;
    for (const match of line.matchAll(/'([^']{4,})'/gu)) {
      const value = match[1];
      if (!/\s/u.test(value)) continue;
      if (!/[a-z]/.test(value)) continue;
      if (/^[a-z][a-z-]*$/u.test(value)) continue;
      if (/^(error|throw|new Error|console)/u.test(line.trim())) continue;
      if (/^[\w./-]+$/u.test(value)) continue;
      findings.push({ file: path, line: lineOffset + index + 1, text: value.slice(0, 80) });
    }
  });
}
const byFile = new Map();
for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
console.log(`findings: ${findings.length} in ${byFile.size} files\n`);
for (const [file, rows] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${relative('.', file)} (${rows.length})`);
  for (const row of rows.slice(0, 14)) console.log(`  ${row.line}  ${row.text}`);
  if (rows.length > 14) console.log(`  ... ${rows.length - 14} more`);
  console.log('');
}
