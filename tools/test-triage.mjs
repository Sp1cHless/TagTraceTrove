#!/usr/bin/env node
/**
 * Triage the test suite: tell "a real red" apart from "the pool was too busy".
 *
 * Why this exists. Running everything in one pool reports far more failures than the code has: the
 * integration suite opens a real SQLite file, a jsdom window and a temp directory per file, so under
 * a full parallel load a handful of heavy files lose their timing and fail on assertions nobody
 * changed. Measured 2026-10-17: `pnpm test` 1317 passed / 3 failed, `pnpm test:integration` 936
 * passed / 19 failed, and of those 22 only ONE failed when its file was run on its own. The other 21
 * pass alone and pass in a group of five — contention, not behaviour.
 *
 * So the number a pool prints is not the truth about the code. This script runs the two documented
 * suites, then re-runs every failing file by itself, and prints the only two things that matter:
 * which tests are really red (they fail alone) and which were the pool's doing (they pass alone).
 *
 * Usage:
 *   node tools/test-triage.mjs                 # both documented suites, full triage
 *   node tools/test-triage.mjs --scope <glob>  # only the files matching <glob> (fast smoke test)
 *   node tools/test-triage.mjs --report-only   # just the two suite runs, no per-file re-runs
 *
 * Run it with the repository's Node 22 (better-sqlite3 is built for it): `pnpm test:triage` does.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitestEntry = join(repo, 'node_modules', 'vitest', 'vitest.mjs');
const integrationConfig = join(repo, 'vitest.integration.config.ts');
const scratch = mkdtempSync(join(tmpdir(), 't3-triage-'));

// A wrong Node makes every run fail the same way, which would look exactly like "RED ALONE" for every
// file — the one verdict this tool exists to not give. better-sqlite3 is built for Node 22 while a
// shell's default node can be 26, so refuse here instead of printing a misleading triage.
try {
  const { createRequire } = await import('node:module');
  // Anchored at the server package, which is where the workspace links better-sqlite3 in. It has to
  // be *used*: the binding is loaded on the first Database, not on require, so a bare require passes
  // under a wrong Node and the misreport would come back.
  const requireFromServer = createRequire(join(repo, 'apps', 'server', 'package.json'));
  const Database = requireFromServer('better-sqlite3');
  new Database(':memory:').close();
} catch (cause) {
  const detail = String(cause instanceof Error ? cause.message : cause).split('\n')
    .find((line) => /NODE_MODULE_VERSION|Cannot find module/.test(line))
    ?? 'better-sqlite3 could not be loaded';
  process.stderr.write(
    `test-triage: this Node (${process.versions.node}) cannot use better-sqlite3, so every test would fail\n`
    + `  and every file would be reported as RED ALONE. Use the repository's Node 22, e.g.\n`
    + '    PATH="$(dirname "$(command -v node)")/../hermes/node:$PATH" pnpm test:triage   # or tools/node/node.exe\n'
    + `  (${detail.trim()})\n`,
  );
  rmSync(scratch, { recursive: true, force: true });
  process.exit(2);
}

const argv = process.argv.slice(2);
const scopeIndex = argv.indexOf('--scope');
const scope = scopeIndex >= 0 ? argv[scopeIndex + 1] : null;
const reportOnly = argv.includes('--report-only');

function run(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [vitestEntry, ...args], {
      cwd: repo,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolveRun({ code, output }));
  });
}

async function runSuite(name, args, reportPath) {
  process.stdout.write(`\n=== ${name}\n`);
  const result = await run([...args, '--reporter=json', `--outputFile=${reportPath}`]);
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    process.stdout.write(`${result.output.split('\n').slice(-12).join('\n')}\n`);
    return { name, passed: 0, failed: 0, files: [] };
  }
  let passed = 0;
  const files = [];
  for (const file of report.testResults ?? []) {
    const failures = (file.assertionResults ?? []).filter((assertion) => assertion.status === 'failed');
    passed += (file.assertionResults ?? []).filter((assertion) => assertion.status === 'passed').length;
    if (failures.length > 0) files.push({ path: file.name, failures });
  }
  const failed = files.reduce((total, file) => total + file.failures.length, 0);
  process.stdout.write(`  ${passed} passed, ${failed} failed in ${files.length} file(s)\n`);
  return { name, passed, failed, files };
}

function configFor(filePath) {
  return filePath.endsWith('.integration.test.ts') ? ['--config', integrationConfig] : [];
}

const suites = [];
if (!scope) {
  suites.push(await runSuite(
    'pnpm test  (unit; the documented run excludes *.integration.test.ts)',
    ['run', '--exclude', '**/*.integration.test.ts'],
    join(scratch, 'unit.json'),
  ));
  suites.push(await runSuite(
    'pnpm test:integration',
    ['run', '--config', integrationConfig],
    join(scratch, 'integration.json'),
  ));
} else {
  // A scoped run is a smoke test of this tool (and of one file); the config follows the scope's own
  // shape, so pointing it at a unit file does not silently match nothing under the other config.
  const integration = scope.includes('.integration.');
  suites.push(await runSuite(
    `pnpm test${integration ? ':integration' : ''} -- ${scope}`,
    integration ? ['run', '--config', integrationConfig, scope] : ['run', scope],
    join(scratch, 'scoped.json'),
  ));
  if (suites[0].passed === 0 && suites[0].failed === 0) {
    process.stdout.write(`\nThe scope matched no test file. Nothing to triage.\n`);
    rmSync(scratch, { recursive: true, force: true });
    process.exit(2);
  }
}

const failingFiles = new Map();
for (const suite of suites) {
  for (const file of suite.files) failingFiles.set(file.path, file.failures);
}

if (failingFiles.size === 0) {
  process.stdout.write('\nBoth documented suites are green. Nothing to triage.\n');
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

if (reportOnly) {
  process.stdout.write(`\n${failingFiles.size} file(s) failed in the pool. Re-run without --report-only to see which of them fail alone.\n`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

process.stdout.write(`\n=== re-running each of the ${failingFiles.size} failing file(s) on its own\n`);
const real = [];
const contention = [];
for (const [filePath, failures] of failingFiles) {
  const relative = filePath.slice(repo.length + 1);
  await run(['run', ...configFor(filePath), relative, '--reporter=json', `--outputFile=${join(scratch, 'one.json')}`]);
  let alone = null;
  try {
    const report = JSON.parse(readFileSync(join(scratch, 'one.json'), 'utf8'));
    alone = (report.testResults ?? []).flatMap((file) => (file.assertionResults ?? []).filter((a) => a.status === 'failed'));
  } catch { /* an unreadable report counts as "fails alone" below */ }
  const stillRed = alone === null || alone.length > 0;
  const record = { relative, inPool: failures.length, alone: alone?.length ?? null, failures };
  if (stillRed) real.push(record); else contention.push(record);
  process.stdout.write(`  ${stillRed ? 'RED ALONE ' : 'pool only '} ${relative} (in pool ${failures.length}, alone ${alone?.length ?? '?'})\n`);
}

process.stdout.write('\n=== verdict\n');
if (contention.length > 0) {
  process.stdout.write(`  ${contention.reduce((total, record) => total + record.inPool, 0)} failure(s) in ${contention.length} file(s) pass when their file runs alone: the pool was too busy, not the code.\n`);
}
if (real.length === 0) {
  process.stdout.write('  nothing is red on its own. Do not report the pool number as a code problem.\n');
} else {
  for (const record of real) {
    process.stdout.write(`  really red: ${record.relative}\n`);
    for (const failure of record.failures) {
      const message = (failure.failureMessages ?? []).join('\n').split('\n').find((line) => /Error|expected|Cannot|resolved/.test(line)) ?? '';
      process.stdout.write(`      ${failure.title}\n        ${message.trim().slice(0, 180)}\n`);
    }
  }
}
rmSync(scratch, { recursive: true, force: true });
process.exit(real.length === 0 ? 0 : 1);
