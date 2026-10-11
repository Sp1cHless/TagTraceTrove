import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = 'apps/web/src';
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (entry.endsWith('.vue') || entry.endsWith('.ts')) files.push(path);
  }
})(root);

const DISPLAY_ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'label'];
const isExpression = (value) => /t\(|\{\{|=>|\?|\+|\|\||&&|\$t\(|^[a-zA-Z_$][\w$.]*\(/u.test(value);
const isNoise = (text) => {
  const trimmed = text.trim();
  if (trimmed === '') return true;
  if (!/[A-Za-z\u4e00-\u9fff]/.test(trimmed)) return true;
  if (/^[×·—–/|:,.()[\]{}<>+*#@!?%&'"-]+$/.test(trimmed)) return true;
  return false;
};
const stripInterpolations = (line) => line.replace(/\{\{(?:(?!\}\})[\s\S])*\}\}/gu, ' ');

const findings = [];
for (const path of files) {
  const source = readFileSync(path, 'utf8');
  const isVue = path.endsWith('.vue');
  let body = source;
  let lineOffset = 0;
  if (isVue) {
    const start = source.indexOf('<template>');
    const end = source.lastIndexOf('</template>');
    if (start === -1) continue;
    body = source.slice(start, end);
    lineOffset = source.slice(0, start).split('\n').length - 1;
  }
  body.split('\n').forEach((rawLine, index) => {
    const lineNumber = lineOffset + index + 1;
    const line = isVue ? stripInterpolations(rawLine) : rawLine;
    if (isVue) {
      for (const match of line.matchAll(/>([^<>]+)</gu)) {
        if (!isNoise(match[1])) findings.push({ file: path, line: lineNumber, kind: 'text', text: match[1].trim().slice(0, 70) });
      }
      for (const attr of DISPLAY_ATTRS) {
        for (const match of line.matchAll(new RegExp(`(?<![\w:.-])${attr}="([^"]*)"`, 'gu'))) {
          if (isExpression(match[1])) continue;
          if (!isNoise(match[1])) findings.push({ file: path, line: lineNumber, kind: attr, text: match[1].slice(0, 70) });
        }
      }
      // Literal strings handed to a component prop that is shown.
      for (const match of line.matchAll(/(?<!:)\b(label|heading|text|hint)="([^"]{3,})"/gu)) {
        if (isExpression(match[2])) continue;
        if (!isNoise(match[2])) findings.push({ file: path, line: lineNumber, kind: match[1], text: match[2].slice(0, 70) });
      }
    } else {
      // Only sentence-like literals in display-ish positions; types and identifiers are noise.
      for (const match of line.matchAll(/\b(label|text|title|placeholder|ariaLabel|heading|hint|notice|empty)\s*:\s*'([^']{4,})'/gu)) {
        const value = match[2];
        if (isNoise(value)) continue;
        if (!/\s/u.test(value)) continue;
        if (/^(Promise|string|number|boolean|unknown|void|never|Record|Partial|Array)/u.test(value)) continue;
        findings.push({ file: path, line: lineNumber, kind: match[1], text: value.slice(0, 70) });
      }
    }
  });
}
const byFile = new Map();
for (const finding of findings) byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
console.log(`files scanned: ${files.length}; findings: ${findings.length}; files with findings: ${byFile.size}\n`);
for (const [file, rows] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${relative('.', file)}  (${rows.length})`);
  for (const row of rows.slice(0, 20)) console.log(`  ${row.line}  [${row.kind}] ${row.text}`);
  if (rows.length > 20) console.log(`  … ${rows.length - 20} more`);
  console.log('');
}
