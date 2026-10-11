import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { SiteprobeRevealFolder, SiteprobeRevealFolderResult } from '@t3/shared';

import type { SiteprobeTooling } from './home.js';

/**
 * Open the folder a hand-made or downloaded adapter goes into, in the machine's own file manager.
 *
 * The reason this exists: T³ ships clean. The adapters that need a sign-in, or that a site's own
 * markup forced somebody to write by hand, are downloaded from the project on GitHub and dropped into
 * a folder — and until now nothing in the UI said which folder, so the answer lived in the docs.
 *
 * Two decisions are enforced here rather than left to the caller:
 *
 * * **the path is chosen here.** The caller names a layer (`installed`, `local`, the home itself) and
 *   this maps it onto the tool's home. A route that opened whatever path it was handed would make the
 *   local server a way to launch anything on the machine, and the browser is not the only thing that
 *   can post to a local port;
 * * **`installed` is created when it is missing.** A fresh T³ has no `installed/` folder at all —
 *   there is nothing to put in it until somebody downloads an adapter — and a button that refuses
 *   because the folder it is about to create does not exist yet would be the wrong refusal.
 */
export function siteprobeFolderPath(tooling: SiteprobeTooling, folder: SiteprobeRevealFolder): string {
  const path = resolve(folder === 'home' ? tooling.home : join(tooling.home, folder));
  mkdirSync(path, { recursive: true });
  return path;
}

export interface RevealOutcome {
  result: SiteprobeRevealFolderResult;
  /** What the file manager said, when it did not start. Null when the window was launched. */
  detail: string | null;
}

/** The part of a child process this needs: it started, or it said why it did not. */
interface LaunchedProcess {
  once: (event: string, listener: (value: Error) => void) => unknown;
  unref: () => void;
}

type Launch = (command: string, args: string[]) => LaunchedProcess;

/** The command that opens a folder, per platform. Windows' `explorer` is the only one that exists there. */
function opener(platform: NodeJS.Platform): { command: string; args: (path: string) => string[] } {
  if (platform === 'win32') return { command: 'explorer.exe', args: (path) => [path] };
  if (platform === 'darwin') return { command: 'open', args: (path) => [path] };
  return { command: 'xdg-open', args: (path) => [path] };
}

const launchWithSpawn: Launch = (command, args) => spawn(command, args, {
  detached: true,
  stdio: 'ignore',
});

export interface RevealOptions {
  platform?: NodeJS.Platform;
  /** Replaced by tests: the real one opens a window on whatever machine runs the suite. */
  launch?: Launch;
}

/**
 * Launch the file manager and return as soon as it has started.
 *
 * Deliberately not awaited to exit: on Windows `explorer.exe` hands the request to the already-running
 * shell and returns a non-zero code even when the window opened, so waiting for an exit code would
 * report a successful open as a failure. Only a failure to *start* is reported.
 */
export function revealFolder(
  tooling: SiteprobeTooling,
  folder: SiteprobeRevealFolder,
  options: RevealOptions = {},
): Promise<RevealOutcome> {
  const path = siteprobeFolderPath(tooling, folder);
  const { command, args } = opener(options.platform ?? process.platform);
  const launch = options.launch ?? launchWithSpawn;
  return new Promise<RevealOutcome>((settle) => {
    let settled = false;
    const finish = (detail: string | null): void => {
      if (settled) return;
      settled = true;
      settle({ result: { folder, path }, detail });
    };
    try {
      const child = launch(command, args(path));
      child.once('error', (errorValue: Error) => finish(errorValue.message));
      // Reaching here means the process was created; whether the window is visible is the file
      // manager's business, and the caller already has the path if it has to be opened by hand.
      child.once('spawn', () => finish(null));
      child.unref();
    } catch (error) {
      finish(error instanceof Error ? error.message : String(error));
    }
  });
}
