import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectSourceTimes,
  decideWebBuild,
  distTimestamp,
} from '../../../tools/ensure-web-build.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 't3-web-build-'));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, ...relative.split('/'));
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

/**
 * The rule that keeps the served front end from being older than its source. Every way of starting
 * T³ asks this one function, so what it decides is what the .bat file, the tray launcher and the dev
 * script all do.
 */
describe('web build guard', () => {
  it('builds when there is no bundle yet', () => {
    expect(decideWebBuild([], null)).toEqual({ build: true, reason: 'the built front end is missing' });
  });

  it('builds when any source is newer than the bundle, and names it', () => {
    const decided = decideWebBuild(
      [{ path: 'apps/web/src/old.vue', mtimeMs: 100 }, { path: 'packages/shared/src/new.ts', mtimeMs: 300 }],
      200,
    );
    expect(decided.build).toBe(true);
    expect(decided.reason).toBe('packages/shared/src/new.ts is newer than the built front end');
  });

  it('does nothing when the bundle is at least as new as every source', () => {
    expect(decideWebBuild([{ path: 'apps/web/src/a.vue', mtimeMs: 100 }], 100))
      .toEqual({ build: false, reason: 'nothing is newer than the built front end' });
    expect(decideWebBuild([{ path: 'apps/web/src/a.vue', mtimeMs: 100 }], 200).build).toBe(false);
  });

  it('reads the build configuration and the lockfile too, not only the source trees', () => {
    // A builder that imports `browser-build-compat.js` changes the bundle without being under
    // `src`; a moved dependency changes it without any file being edited by hand.
    const root = fixture({
      'apps/web/src/main.ts': 'x',
      'packages/shared/src/index.ts': 'x',
      'apps/web/vite.config.ts': 'x',
      'apps/web/browser-build-compat.js': 'x',
      'pnpm-lock.yaml': 'x',
      'apps/server/src/http/app.ts': 'x',
      'apps/web/dist/index.html': 'x',
    });
    const paths = collectSourceTimes(root).map((source) => source.path).sort();
    expect(paths).toContain('apps/web/vite.config.ts');
    expect(paths).toContain('apps/web/browser-build-compat.js');
    expect(paths).toContain('pnpm-lock.yaml');
    // Something that cannot reach the bundle must not force a rebuild on every start.
    expect(paths).not.toContain('apps/server/src/http/app.ts');
  });

  it('finds no source at all in an installed payload, and no bundle either when there is none', () => {
    // What a release ships: the built front end, no Web sources. The launcher asks the script, which
    // finds `apps/web/src` missing and leaves the frozen bundle alone.
    const shipped = fixture({ 'apps/web/dist/index.html': 'x' });
    expect(collectSourceTimes(shipped)).toEqual([]);
    expect(distTimestamp(shipped)).not.toBeNull();
    expect(decideWebBuild(collectSourceTimes(shipped), distTimestamp(shipped)).build).toBe(false);
  });

  it('sees a rebuilt bundle as newer than the sources it was built from', () => {
    const root = fixture({
      'apps/web/src/main.ts': 'x',
      'apps/web/dist/index.html': 'x',
    });
    const source = join(root, 'apps', 'web', 'src', 'main.ts');
    const bundle = join(root, 'apps', 'web', 'dist', 'index.html');
    utimesSync(source, new Date(1_000_000), new Date(1_000_000));
    utimesSync(bundle, new Date(2_000_000), new Date(2_000_000));
    expect(decideWebBuild(collectSourceTimes(root), distTimestamp(root)).build).toBe(false);

    // The same tree, one source edited after the build: exactly the state the browser cannot see.
    utimesSync(source, new Date(3_000_000), new Date(3_000_000));
    const decided = decideWebBuild(collectSourceTimes(root), distTimestamp(root));
    expect(decided.build).toBe(true);
    expect(decided.reason).toContain('apps/web/src/main.ts');
  });
});
