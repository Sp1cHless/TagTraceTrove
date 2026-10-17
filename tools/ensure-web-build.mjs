#!/usr/bin/env node
/**
 * The served Web bundle must never be older than the source it is built from.
 *
 * T³'s front end and its API are separate artifacts: the API is read from `src` when the process
 * starts, while the browser gets whatever file sits in `apps/web/dist`. When the two drift — someone
 * changes the Web sources and starts T³ in a way that never rebuilt — the browser runs the previous
 * front end against the new API, and the first symptom is a schema complaint in the page rather than
 * anything the person can act on.
 *
 * So every way of starting T³ asks this one script first. The decision to rebuild lives here and
 * nowhere else: it used to live in the .bat file and in the tray launcher separately, which is how
 * they came to disagree.
 *
 * An installed payload carries `apps/web/dist` and no Web sources at all. There the shipped bundle
 * *is* the frozen front end — a release never rebuilds — so a missing source tree is a no-op rather
 * than an error.
 *
 * Usage: node tools/ensure-web-build.mjs [--dry-run]
 * Exit:  0 nothing to do, or the bundle is fresh again · 1 the bundle could not be built
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(repoRoot, 'apps', 'web');

/**
 * Every input the built bundle is made of. The directories are walked; the files are the build
 * configuration itself, which changes what the bundle contains without being inside a source tree
 * (`browser-build-compat.js` is imported by `vite.config.ts`), and the lockfile, because a
 * dependency that moves changes the bundle too.
 */
const SOURCE_DIRECTORIES = [
  'apps/web/src',
  'apps/web/public',
  'packages/shared/src',
];
const SOURCE_FILES = [
  'apps/web/index.html',
  'apps/web/vite.config.ts',
  'apps/web/browser-build-compat.js',
  'apps/web/package.json',
  'packages/shared/package.json',
  'pnpm-lock.yaml',
];

/** The bundle's own entry point: its timestamp is when the front end was last built. */
export function distTimestamp(root = repoRoot) {
  const index = join(root, 'apps', 'web', 'dist', 'index.html');
  return existsSync(index) ? statSync(index).mtimeMs : null;
}

/** Every source file that feeds the bundle, with its modification time. */
export function collectSourceTimes(root = repoRoot) {
  const files = [];
  const walk = (absolute) => {
    if (!existsSync(absolute)) return;
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolute)) walk(join(absolute, entry));
      return;
    }
    files.push({ path: relative(root, absolute).split('\\').join('/'), mtimeMs: stats.mtimeMs });
  };
  for (const entry of [...SOURCE_DIRECTORIES, ...SOURCE_FILES]) walk(join(root, entry));
  return files;
}

/**
 * Whether the bundle has to be rebuilt, and the one source that says so — the answer is reported
 * with its reason so a log always explains why a start took longer than usual.
 */
export function decideWebBuild(sources, distTimeMs) {
  if (distTimeMs === null) return { build: true, reason: 'the built front end is missing' };
  let newest = null;
  for (const source of sources) {
    if (newest === null || source.mtimeMs > newest.mtimeMs) newest = source;
  }
  if (newest !== null && newest.mtimeMs > distTimeMs) {
    return { build: true, reason: `${newest.path} is newer than the built front end` };
  }
  return { build: false, reason: 'nothing is newer than the built front end' };
}

/**
 * Builds into a staging directory and only then moves the result into `dist`, so this script is
 * safe to run while a server is serving that directory: nothing reads a half-written front end, and
 * the previous build's hashed files stay behind for a page that is still open on them. `index.html`
 * moves last, because it is the file that names the new assets.
 */
function publishStaged(staged, dist) {
  const copyInto = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      cpSync(join(from, entry), join(to, entry), { recursive: true, force: true });
    }
  };
  for (const entry of readdirSync(staged)) {
    if (entry === 'index.html') continue;
    const from = join(staged, entry);
    const to = join(dist, entry);
    if (statSync(from).isDirectory()) copyInto(from, to);
    else cpSync(from, to, { force: true });
  }
  cpSync(join(staged, 'index.html'), join(dist, 'index.html'), { force: true });
}

function buildWebBundle() {
  const viteEntry = join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteEntry)) {
    console.error(`web-build: cannot rebuild - ${viteEntry} is missing (run the dependency install)`);
    return false;
  }
  const staged = join(webRoot, 'dist.staged');
  rmSync(staged, { recursive: true, force: true });
  console.log('web-build: rebuilding the Web front end from source...');
  const built = spawnSync(process.execPath, [viteEntry, 'build', '--outDir', 'dist.staged'],
    { cwd: webRoot, stdio: 'inherit' });
  if (built.error) {
    console.error(`web-build: could not start the build: ${built.error.message}`);
    return false;
  }
  if (built.status !== 0) {
    console.error(`web-build: the build failed (exit ${built.status}); ${staged} was left in place`);
    return false;
  }
  if (!existsSync(join(staged, 'index.html'))) {
    console.error('web-build: the build reported success but produced no front end');
    return false;
  }
  publishStaged(staged, join(webRoot, 'dist'));
  rmSync(staged, { recursive: true, force: true });
  return true;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!existsSync(join(webRoot, 'src'))) {
    // An installed payload: the shipped bundle is the frozen one, so there is nothing to check.
    console.log('web-build: no Web sources here; serving the shipped front end');
    return 0;
  }
  const decision = decideWebBuild(collectSourceTimes(), distTimestamp());
  if (!decision.build) {
    console.log(`web-build: fresh (${decision.reason})`);
    return 0;
  }
  console.log(`web-build: stale - ${decision.reason}`);
  if (dryRun) return 0;
  return buildWebBundle() ? 0 : 1;
}

// Only a direct run decides anything; importing this file (the rule's own test does) must not build.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
