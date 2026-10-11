import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { siteprobeLineSchema, type SiteprobeLine } from '@t3/shared';

import type { SiteprobeTooling } from './home.js';

/**
 * One run of the local tool, as a child process reading JSON lines back.
 *
 * A subprocess rather than a resident service, decided by measurement: the interpreter plus the
 * heaviest adapter's imports cost about 0.14s (`python -c pass` is 0.06s), while a service would add
 * a port, a lifecycle and a version skew to keep in step. Every run here is a bounded piece of work
 * a person asked for, and killing the child is a complete cancel.
 *
 * Two things are enforced at this boundary rather than trusted:
 *
 * * **the contract** — each line must be one of the four event shapes shared with the web app
 *   (`siteprobeEventSchema`). A line that is not is reported as malformed, because a tool that
 *   starts printing prose on stdout otherwise turns into undefined fields in the UI;
 * * **the home** — passed explicitly (`SITEPROBE_HOME`), so this run writes its adapters, exports
 *   and sessions into T³'s data root even though the tool would also find them by itself.
 */
export interface SiteprobeProcessOptions {
  args: string[];
  /**
   * What goes between the interpreter and `args`. The default is the contract's own entry
   * (`integration.py`); the one-link reader is a different script on the same tool, so its caller
   * passes `linkArgs` instead.
   */
  prefix?: string[];
  onEvent: (event: SiteprobeLine) => void;
  /** Defaults to 15 minutes: a large crawl is slow, but a hung one must not hold a job forever. */
  timeoutMs?: number;
}

export interface SiteprobeProcessOutcome {
  /** The exit code, or null when the process was killed (timeout or cancel). */
  code: number | null;
  /** The tool's own diagnostics, kept for the failure message. */
  stderr: string;
  /** Lines on stdout that are not part of the contract, in order. */
  malformed: string[];
  timedOut: boolean;
}

export interface SiteprobeProcess {
  done: Promise<SiteprobeProcessOutcome>;
  kill(): void;
}

const STDERR_LIMIT = 8192;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function startSiteprobe(tooling: SiteprobeTooling, options: SiteprobeProcessOptions): SiteprobeProcess {
  if (!tooling.ok) {
    throw new Error(tooling.detail ?? 'the SiteProbe tool is unavailable');
  }
  const prefix = options.prefix ?? tooling.pythonArgs;
  const child: ChildProcess = spawn(tooling.python, [...prefix, ...options.args], {
    cwd: tooling.tool,
    env: {
      ...process.env,
      SITEPROBE_HOME: tooling.home,
      // The tool prints Chinese labels; without a declared encoding a Windows pipe hands back
      // mojibake, and `-u` keeps the events arriving while the run is still going.
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    },
    windowsHide: true,
  });

  const malformed: string[] = [];
  let stderr = '';
  let timedOut = false;
  let killed = false;

  const reader = createInterface({ input: child.stdout! });
  reader.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      malformed.push(text);
      return;
    }
    const event = siteprobeLineSchema.safeParse(parsed);
    if (!event.success) {
      malformed.push(text);
      return;
    }
    options.onEvent(event.data);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_LIMIT) {
      stderr += chunk.toString('utf8');
    }
  });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const done = new Promise<SiteprobeProcessOutcome>((resolveOutcome, rejectOutcome) => {
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectOutcome(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveOutcome({
        code: killed ? null : code,
        stderr: stderr.slice(0, STDERR_LIMIT),
        malformed,
        timedOut,
      });
    });
  });

  return {
    done,
    kill(): void {
      killed = true;
      child.kill();
    },
  };
}

export interface SiteprobeRunInvocation {
  input?: string | undefined;
  selection?: string | undefined;
  site?: string | undefined;
  kind?: string | undefined;
  review?: boolean | undefined;
  limit?: number | undefined;
  refresh?: boolean | undefined;
}

/** Every run's argv, in one place, so the job store never composes a command inline. */
export function runArguments(request: SiteprobeRunInvocation): string[] {
  if (request.selection) {
    return ['selection', request.selection];
  }
  const args = ['run', request.input ?? ''];
  if (request.site) args.push('--site', request.site);
  if (request.kind) args.push('--kind', request.kind);
  if (request.review) args.push('--review');
  if (request.limit) args.push('--limit', String(request.limit));
  if (request.refresh) args.push('--refresh');
  return args;
}

export interface SiteprobeLoginProcess {
  /** The door's own exit code, reported once the bat and the window it opened are done. */
  done: Promise<{ code: number | null; stderr: string }>;
  /** Every line the door printed, for the job's log; the window may have closed already. */
  onLine?: (line: string) => void;
  /**
   * Tell the door the person has finished signing in.
   *
   * The tool waits for a line on stdin, and this writes one — so the answer comes from the page the
   * person is already looking at, instead of from a console window they would have to find. Measured
   * on the first real sign-in: the window was behind the browser, the person pressed Enter in T³, and
   * nothing could happen.
   */
  finish(): void;
  kill(): void;
}

/**
 * Open the tool's login door.
 *
 * Not through `startSiteprobe`: that runs the interpreter under a JSON contract on stdout, and this
 * runs a batch file whose whole purpose is to hold a conversation — it prints an instruction, waits
 * for the person to sign in, and waits again for them to press Enter.
 *
 * Two shapes were measured on 2026-09-22 before this one was kept:
 *
 * * `cmd /c start "" /wait <bat> <input>` — the bat runs, in its own console, and **the wrapper never
 *   closes**: it was still alive after 8s with the work already finished, so a job waiting on it
 *   would wait forever. Rejected;
 * * `cmd /c <bat> <input>` — exit 7 after 2.1s for a bat that exits 7, with stdout readable. Kept.
 *
 * The consequence is worth stating: the bat inherits **this server's console**, which is the window
 * `T3.bat` opened for it — so the instruction and the Enter prompt appear there, where the person can
 * answer them. A server started without a console (a service, an IDE) cannot prompt; the tool's own
 * login door treats a closed stdin as "carry on with the session that exists" rather than hanging.
 */
export function startSiteprobeLogin(tooling: SiteprobeTooling, input: string,
                                    onLine?: (line: string) => void): SiteprobeLoginProcess {
  if (!tooling.ok) {
    throw new Error(tooling.detail ?? 'the SiteProbe tool is unavailable');
  }
  if (process.platform !== 'win32') {
    throw new Error('the login door is a Windows batch file; run it from a terminal instead');
  }
  const bat = join(tooling.tool, LOGIN_BAT);
  if (!existsSync(bat)) {
    throw new Error(`the tool has no ${LOGIN_BAT}; update the tool or sign in from a terminal`);
  }
  // The address travels in the environment, not as an argument: `cmd` splits batch arguments on
  // `=`, and every favourite or search address carries one — measured on a real favourite URL,
  // which arrived as `…/albums?folder` plus `4717648`, so the door saw a truncated address and
  // the `--no-pause` flag was read as the *second* argument and never matched.
  const child = spawn('cmd', ['/c', bat, '--no-pause'], {
    cwd: tooling.tool,
    // `PYTHONIOENCODING` matters here exactly as much as in the JSON runs: the door prints Chinese,
    // Python encodes a *piped* stdout by the locale (cp936 on this machine) whatever the console's
    // codepage is, and the log line arrived as `??????` — measured in the app on 2026-09-22.
    // `PYTHONUNBUFFERED` for the same reason as the builder's: the door *waits on the person*, and
    // its "waiting for the login to finish" line would otherwise sit in the buffer until exit.
    env: { ...process.env, SITEPROBE_HOME: tooling.home, PYTHONIOENCODING: 'utf-8',
           SITEPROBE_LOGIN_TARGET: input, PYTHONUNBUFFERED: '1' },
    windowsHide: false,
    // stdin is a pipe: the tool blocks on one line to know the person is done, and this server is
    // what writes it (`finish`). A console the person has to find is not an interaction.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // A late Enter can race the door exiting; writes to its closed pipe emit EPIPE asynchronously.
  child.stdin?.on('error', () => {});
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8');
  });
  if (onLine) {
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      const text = line.trim();
      if (text) onLine(text);
    });
  }
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
  return {
    done,
    ...(onLine ? { onLine } : {}),
    finish: () => {
      child.stdin?.write(String.fromCharCode(10));
    },
    kill: () => {
      // The tree, not just this `cmd`: the door's work is a python process that opens a browser, and
      // killing the wrapper alone would leave a window doing something the person just cancelled.
      if (child.pid === undefined) return;
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    },
  };
}

export const LOGIN_BAT = '登录.bat';

export interface SiteprobeBuildProcess {
  /** The builder's own exit code: 0 installed, 1 refused, 2 could not read a page. */
  done: Promise<{ code: number | null; stderr: string }>;
  kill(): void;
}

/**
 * Run the adapter builder for one site, streaming its console lines.
 *
 * Not through `startSiteprobe` either: the builder's stdout is human guidance ("capturing …",
 * "opening the page (annotate)"), not a JSON contract — and its running time is *human*, because it
 * stops and opens an annotation page per work and waits for the person to submit. So the same shape
 * as the login door: plain lines up to the job's log, no timeout here (the person is the clock), and
 * the tree kill for a cancel, because the builder's children include a headless Chrome.
 */
export function startSiteprobeBuild(tooling: SiteprobeTooling, urls: readonly string[],
                                    onLine?: (line: string) => void,
                                    lang?: string, kind?: string): SiteprobeBuildProcess {
  if (!tooling.ok) {
    throw new Error(tooling.detail ?? 'the SiteProbe tool is unavailable');
  }
  // Two builders ship side by side and take the same three flags: `build_adapter.py` learns a work's
  // fields from one to three works, `build_listing.py` learns a *listing's* card rules from its first
  // two pages and takes the listing's kind. A `kind` on the request is what selects the second — the
  // same flag the tool's own bat passes (`--kind=search`), so T³ drives the documented door.
  const args = kind === undefined
    ? [...tooling.buildArgs, '--browser', '--install', ...urls]
    : [...tooling.listingArgs, '--browser', '--install', `--kind=${kind}`, ...urls];
  const child = spawn(tooling.python, args, {
    cwd: tooling.tool,
    // `PYTHONUNBUFFERED` matters here as much as the encoding, and more than in a JSON run: the
    // builder *waits on the person*, so a block-buffered stdout keeps `annotation page: …` and
    // `opening the page (annotate)` inside Python's buffer while the run sits at that wait —
    // measured on 2026-10-03, where the page was served and T³ never said so, so the state that
    // sends the person to annotate never arrived.
    env: { ...process.env, SITEPROBE_HOME: tooling.home, PYTHONIOENCODING: 'utf-8',
           PYTHONUNBUFFERED: '1',
           // The pages this run opens are read by someone inside T³, so they are served in T³'s
           // language — the request carries it, because a Python process cannot ask the browser.
           ...(lang ? { SITEPROBE_LANG: lang } : {}) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8');
  });
  if (onLine) {
    const reader = createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      const text = line.trim();
      if (text) onLine(text);
    });
  }
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
  return {
    done,
    kill: () => {
      if (child.pid === undefined) return;
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    },
  };
}

export interface SiteprobeOnceResult {
  code: number | null;
  events: SiteprobeLine[];
  malformed: string[];
  stderr: string;
}

/**
 * Run the tool once and wait, for the two questions that are answered in a moment.
 *
 * `sites` and `resolve` are registry lookups — measured at 0.2–0.3s end to end — so they are asked
 * directly instead of becoming jobs: a UI needs the answer to draw its menu, and a job id would only
 * add a second round trip to every keystroke-level interaction.
 */
export async function runSiteprobeOnce(
  tooling: SiteprobeTooling,
  args: string[],
  timeoutMs = 60_000,
): Promise<SiteprobeOnceResult> {
  const events: SiteprobeLine[] = [];
  const process = startSiteprobe(tooling, {
    args,
    timeoutMs,
    onEvent: (event) => events.push(event),
  });
  const outcome = await process.done;
  return {
    code: outcome.code,
    events,
    malformed: outcome.malformed,
    stderr: outcome.stderr,
  };
}

export interface SiteprobeJsonResult {
  code: number | null;
  /** Each stdout line parsed as JSON, in order; a line that is not JSON is left in `raw`. */
  documents: unknown[];
  raw: string[];
  stderr: string;
  timedOut: boolean;
}

/**
 * Run the tool once and read its **own** JSON back, for a door whose output is not the event
 * contract: `fetch_work_meta.py <url>` (the Level 0 one-link reader) prints one object describing
 * what it found, in its own vocabulary (`outcome`, `kind`, `title`, `cover`). Which schema that
 * document has belongs to that door, so this parses nothing beyond JSON and lets the caller decide.
 */
export async function runSiteprobeJson(
  tooling: SiteprobeTooling,
  args: string[],
  options: { prefix?: string[]; timeoutMs?: number } = {},
): Promise<SiteprobeJsonResult> {
  if (!tooling.ok) {
    throw new Error(tooling.detail ?? 'the SiteProbe tool is unavailable');
  }
  const prefix = options.prefix ?? tooling.linkArgs;
  const documents: unknown[] = [];
  const raw: string[] = [];
  let stderr = '';
  let timedOut = false;

  const child = spawn(tooling.python, [...prefix, ...args], {
    cwd: tooling.tool,
    env: { ...process.env, SITEPROBE_HOME: tooling.home, PYTHONIOENCODING: 'utf-8',
           PYTHONUNBUFFERED: '1' },
    windowsHide: true,
  });
  const reader = createInterface({ input: child.stdout! });
  reader.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    try {
      documents.push(JSON.parse(text));
    } catch {
      raw.push(text);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8');
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs ?? 120_000);

  const code = await new Promise<number | null>((resolveOutcome, rejectOutcome) => {
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectOutcome(error);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolveOutcome(exitCode);
    });
  });

  return { code, documents, raw, stderr: stderr.slice(0, STDERR_LIMIT), timedOut };
}
