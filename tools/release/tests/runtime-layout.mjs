import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workspace = join(repo, '.hermes/tmp', `rt-${randomUUID().slice(0, 8)}`);
const copier = join(repo, 'tools/release/copy-runtime.mjs');
function run(command, args, cwd) {
  const env = { ...process.env };
  // Windows PowerShell must discover its own built-in modules, as it does
  // when Install.cmd is launched from Explorer rather than PowerShell 7.
  if (command === 'powershell.exe') for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    assert(!entry.isSymbolicLink(), `External link in payload: ${entry.name}`);
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
function pkg(path, name, dependencies = {}, body = '', version = '1.0.0') {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version, main: 'index.cjs', dependencies,
    ...(name === '@t3/server' ? { devDependencies: { tsx: '1.0.0' } } : {}) }));
  writeFileSync(join(path, 'index.cjs'), body);
}
mkdirSync(workspace, { recursive: true });
try {
  const fixture = join(workspace, 'fixture');
  const server = join(fixture, 'apps/server');
  pkg(server, '@t3/server', { 'consumer-a': '1', 'consumer-b': '1' });
  pkg(join(server, 'node_modules/tsx'), 'tsx');
  for (const [consumer, value] of [['consumer-a', 'one'], ['consumer-b', 'two']]) {
    const path = join(server, 'node_modules', consumer);
    pkg(path, consumer, { choice: '1' }, 'module.exports = require("choice");');
    pkg(join(path, 'node_modules/choice'), 'choice', {}, `module.exports = ${JSON.stringify(value)};`, value === 'one' ? '1.0.0' : '2.0.0');
  }
  const fixtureTarget = join(fixture, 'packed');
  run(process.execPath, [copier, fixture, fixtureTarget], repo);
  const fixtureRequire = createRequire(join(fixtureTarget, 'apps/server/package.json'));
  assert.equal(fixtureRequire('consumer-a'), 'one');
  assert.equal(fixtureRequire('consumer-b'), 'two');

  const actual = join(workspace, 'package');
  console.log(run(process.execPath, [copier, repo, actual], repo));
  const actualRequire = createRequire(join(actual, 'apps/server/package.json'));
  for (const name of ['better-sqlite3', 'hono', 'jsdom', 'qrcode', 'sharp', 'tsx']) {
    assert(actualRequire.resolve(name).startsWith(actual + sep), `Dependency escaped payload: ${name}`);
  }
  for (const name of ['Install.ps1', 'Install.cmd', 'Install-Demo.cmd', 'Start.ps1', 'Start.cmd', 'Uninstall.ps1', 'Uninstall.cmd', 'lifecycle.ps1']) {
    cpSync(join(repo, 'tools/release', name), join(actual, name));
  }
  const smoke = join(actual, 'apps/server/runtime-layout-smoke.ts');
  writeFileSync(smoke, `import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createApiApp} from './src/http/app.js';
import {createMigratedMemoryDatabase} from './src/database/testing.js';
const require=createRequire(import.meta.url);
const D=require('better-sqlite3'); const db=new D(':memory:'); assert.equal(db.prepare('SELECT 42 AS value').get().value,42); db.close();
const {JSDOM}=require('jsdom'); const dom=new JSDOM('<p class="target">loaded</p>'); assert.equal(dom.window.document.querySelector('.target').textContent,'loaded'); dom.window.close();
const sharp=require('sharp'); const image=await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer(); assert(image.length>0);
assert((await require('qrcode').toString('T3',{type:'svg'})).includes('<svg'));
const memory=createMigratedMemoryDatabase(); try {const app=createApiApp(memory,{dataDir:${JSON.stringify(join(workspace, 'data'))},assetRoot:${JSON.stringify(join(workspace, 'assets'))}}); assert.equal((await app.request('/api/sync/capabilities')).status,200); const response=await app.request('/api/entries/query',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); assert.equal(response.status,200); assert.equal((await response.json()).total,0);} finally {memory.close();}
console.log('Installed flattened runtime: SQLite, jsdom, sharp, QR, tsx, shared and in-memory HTTP passed');
`);
  const payload = files(actual);
  const longest = Math.max(...payload.map(path => relative(actual, path).length));
  assert(longest <= 145, `Node payload still too deep: ${longest}`);
  const manifest = { product: 'T3', platform: 'win-x64', version: '0.9.0', files: {} };
  for (const path of payload) manifest.files[relative(actual, path).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(join(actual, 'release-manifest.json'), JSON.stringify(manifest));
  // Exercise the advanced-script default via -File, exactly as Install.cmd
  // does. Calling the script with & or passing InstallRoot hides this bug.
  console.log(run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(actual, 'Install.ps1'), '-NoShortcut'], repo));
  const inPlace = JSON.parse(readFileSync(join(actual, 'installation.json'), 'utf8'));
  assert.equal(inPlace.dataDirectory, join(actual, 'data'));
  assert.equal(inPlace.currentDirectory, join(actual, 'versions/0.9.0'));
  const installed = join(workspace, 'T3-1.0.4-windows-x64/TagTraceTrove');
  console.log(run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(actual, 'Install.ps1'), '-InstallRoot', installed, '-NoShortcut'], repo));
  const state = JSON.parse(readFileSync(join(installed, 'installation.json'), 'utf8'));
  console.log(run(process.execPath, [join(state.currentDirectory, 'apps/server/node_modules/tsx/dist/cli.mjs'), join(state.currentDirectory, 'apps/server/runtime-layout-smoke.ts')], join(state.currentDirectory, 'apps/server')));
  const actualPath = Math.max(...files(state.currentDirectory).map(path => path.length));
  assert(actualPath <= 259, `Installed payload exceeds Windows path limit: ${actualPath}`);
  console.log(JSON.stringify({ longestNodeRelativePath: longest, longestInstalledPath: actualPath, incompatibleVersionsRetained: true }));
} finally {
  const allowed = resolve(repo, '.hermes/tmp') + sep;
  assert(resolve(workspace).startsWith(allowed));
  if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
}
