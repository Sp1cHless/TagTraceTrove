import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { siteprobeRevealFolderRequestSchema } from '@t3/shared';

import { revealFolder, siteprobeFolderPath } from '../../src/siteprobe/reveal.js';
import type { SiteprobeTooling } from '../../src/siteprobe/home.js';

/**
 * "Open the adapter folder" — the two things that must not be negotiable.
 *
 * The endpoint exists because T³ ships clean: an adapter that needs a sign-in is downloaded and
 * dropped into a folder. So the folder is named by the *server* from the tool's home, and the caller
 * can only pick a layer — a route that opened a path the browser named would make the local server a
 * way to launch anything on the machine. The other half is that a fresh install has no `installed/`
 * folder at all, and a button that refused to open the folder it was about to create would be the
 * wrong refusal.
 */
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function tooling(): Promise<SiteprobeTooling> {
  const dataDir = await mkdtemp(join(tmpdir(), 't3-reveal-'));
  directories.push(dataDir);
  return {
    tool: join(dataDir, 'siteprobe'),
    python: 'python',
    pythonArgs: ['integration.py'],
    linkArgs: ['fetch_work_meta.py'],
    buildArgs: ['build_adapter.py'],
    listingArgs: ['build_listing.py'],
    home: join(dataDir, 'siteprobe'),
    ok: true,
    detail: null,
  };
}

describe('the adapter folder', () => {
  it('only accepts a layer name, never a path', () => {
    for (const folder of ['installed', 'local', 'home']) {
      expect(siteprobeRevealFolderRequestSchema.safeParse({ folder }).success).toBe(true);
    }
    for (const folder of ['/etc', 'C:\\Windows', '../../', 'installed/../../..', '', 'export']) {
      expect(siteprobeRevealFolderRequestSchema.safeParse({ folder }).success, folder).toBe(false);
    }
    // Strict, so an extra key is a refusal rather than something ignored — a `path` a caller hoped
    // would be used is exactly the request this endpoint must not quietly accept.
    expect(siteprobeRevealFolderRequestSchema.safeParse({ folder: 'installed', path: '/etc' }).success)
      .toBe(false);
  });

  it('resolves every layer under the tool’s own home', async () => {
    const home = await tooling();
    const base = siteprobeFolderPath(home, 'home');
    expect(base).toBe(home.home);
    expect(siteprobeFolderPath(home, 'installed')).toBe(join(home.home, 'installed'));
    expect(siteprobeFolderPath(home, 'local')).toBe(join(home.home, 'local'));
    expect(existsSync(join(home.home, 'installed'))).toBe(true);
  });

  it('creates the folder a downloaded adapter goes into, which a fresh install does not have', async () => {
    const home = await tooling();
    expect(existsSync(join(home.home, 'installed'))).toBe(false);

    const outcome = await revealFolder(home, 'installed', { launch: () => fakeProcess(null) });

    expect(outcome.detail).toBeNull();
    expect(existsSync(outcome.result.path)).toBe(true);
    expect(outcome.result).toEqual({ folder: 'installed', path: join(home.home, 'installed') });
  });

  it('opens the machine’s own file manager, per platform', async () => {
    const home = await tooling();
    const seen: { command: string; args: string[] }[] = [];
    const launch = (command: string, args: string[]) => {
      seen.push({ command, args });
      return fakeProcess(null);
    };

    await revealFolder(home, 'installed', { platform: 'win32', launch });
    await revealFolder(home, 'installed', { platform: 'darwin', launch });
    await revealFolder(home, 'installed', { platform: 'linux', launch });

    expect(seen.map((entry) => entry.command)).toEqual(['explorer.exe', 'open', 'xdg-open']);
    expect(seen[0]!.args).toEqual([join(home.home, 'installed')]);
  });

  it('reports a file manager that would not start, with the path it was given', async () => {
    const home = await tooling();

    const outcome = await revealFolder(home, 'installed', {
      launch: () => fakeProcess(new Error('spawn xdg-open ENOENT')),
    });

    expect(outcome.detail).toBe('spawn xdg-open ENOENT');
    expect(outcome.result.path).toBe(join(home.home, 'installed'));
  });
});

/** A launched process that either starts or fails, with no real window behind it. */
function fakeProcess(error: Error | null): { once: (event: string, listener: (value: Error) => void) => void; unref: () => void } {
  const listeners = new Map<string, (value: Error) => void>();
  return {
    once(event, listener) {
      listeners.set(event, listener);
      // Both events are emitted after the call returns, which is how the real one behaves.
      queueMicrotask(() => {
        if (event === 'spawn' && !error) listeners.get('spawn')?.(new Error('spawn'));
        if (event === 'error' && error) listeners.get('error')?.(error);
      });
    },
    unref() {},
  };
}
