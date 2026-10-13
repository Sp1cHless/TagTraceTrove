// Materialize the installed dependency graph without junctions or external paths.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const [root, target] = process.argv.slice(2).map(value => resolve(value));
if (!root || !target || target === root || !target.startsWith(root + '\\') && !target.startsWith(root + '/')) {
  throw new Error('Destination must be a separate staging directory inside the checkout');
}
const readPackage = path => JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
function locate(name, source) {
  // Names like "buffer" are also Node builtins; resolve.paths(name) would
  // return null even when a package explicitly depends on the npm polyfill.
  for (const search of createRequire(join(source, 'package.json')).resolve.paths('__t3_package_lookup__') ?? []) {
    const candidate = join(search, name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
  }
  return null;
}
let count = 0;
function install(source, destination, ancestors = new Map()) {
  const real = realpathSync(source);
  const pkg = readPackage(real);
  mkdirSync(destination, { recursive: true });
  cpSync(real, destination, {
    recursive: true, dereference: true,
    filter: path => {
      const top = path.slice(real.length + 1).split(/[\\/]/)[0];
      return path === real || (['@t3/server', '@t3/shared'].includes(pkg.name)
        ? ['src', 'package.json'].includes(top)
        : !['node_modules', '.git', '.data', '.env'].includes(top));
    },
  });
  count++;
  const visible = new Map(ancestors);
  visible.set(pkg.name, real);
  const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies };
  // The server runs TypeScript directly; tsx is a runtime dependency in this distribution.
  if (pkg.name === '@t3/server') dependencies.tsx = pkg.devDependencies.tsx;
  for (const name of Object.keys(dependencies)) {
    const dependency = locate(name, real);
    if (!dependency) {
      if (pkg.optionalDependencies?.[name]) continue;
      throw new Error(`Missing installed dependency: ${pkg.name} -> ${name}`);
    }
    if (visible.get(name) === dependency) continue;
    install(dependency, join(destination, 'node_modules', name), visible);
  }
}
install(join(root, 'apps/server'), join(target, 'apps/server'));
// Only runtime sources and resources belong to the application package.
// Server tests/scripts are removed by the caller's whitelist staging, before this copy.
mkdirSync(join(target, 'apps/server/node_modules/.bin'), { recursive: true });
writeFileSync(join(target, 'apps/server/node_modules/.bin/tsx.cmd'),
  '@echo off\r\n"%~dp0..\\..\\..\\..\\tools\\node\\node.exe" "%~dp0..\\tsx\\dist\\cli.mjs" %*\r\n');
// Remove non-runtime first-party directories without touching dependency files.
// Caller only passes a newly created, checked staging root.
const { rmSync } = await import('node:fs');
for (const item of readdirSync(join(target, 'apps/server'))) {
  if (!['src', 'package.json', 'node_modules'].includes(item)) rmSync(join(target, 'apps/server', item), { recursive: true, force: true });
}
console.log(`Materialized ${count} package instances; no pnpm junctions required.`);
