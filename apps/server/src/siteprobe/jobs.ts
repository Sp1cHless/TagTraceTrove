import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { SiteprobeEvent, SiteprobeRun } from '@t3/shared';

import type { SiteprobeTooling } from './home.js';
import { writeSiteprobeErrorLog } from './log.js';
import { runArguments, startSiteprobe, startSiteprobeBuild, startSiteprobeLogin,
         type SiteprobeLoginProcess, type SiteprobeProcess,
         type SiteprobeProcessOutcome } from './transport.js';

/**
 * The runs T³ has started, and what each one said.
 *
 * In memory on purpose: a run is a live child process, so it cannot outlive the server anyway, and
 * the artifacts that must survive (the export tree, the crawl state) already live on disk under the
 * tool's home. What this adds is a place for the browser to poll, plus two things a bare subprocess
 * call cannot offer:
 *
 * * **cancel**, because a crawl of a few hundred works is long enough that a person changes their
 *   mind about it, and killing the child is a complete undo;
 * * **the selection watch** (the plan's C1), because a review run's product is a page a person
 *   interacts with, and the `selection_*.json` it saves appears later, in the listing directory,
 *   written by the browser's download — nothing in the process's own output can announce it.
 */
export interface SiteprobeRunInput {
  input?: string | undefined;
  selection?: string | undefined;
  /** A URL on the site to sign in to, or its key: the login door runs in a console window. */
  login?: string | undefined;
  /**
   * One to three addresses to build from: work URLs (a work adapter), or a listing's first page and
   * its second page when `kind` is present (a listing adapter).
   */
  build?: string[] | undefined;
  /** The language T³ is in, for the pages that build opens (`SITEPROBE_LANG`). */
  lang?: 'zh' | 'en' | undefined;
  site?: string | undefined;
  /**
   * Which target kind: for a run, what to read (`work`, `search`, …); for a **build**, the listing
   * being learned — its presence is what makes the build a listing build.
   */
  kind?: string | undefined;
  review?: boolean | undefined;
  limit?: number | undefined;
  refresh?: boolean | undefined;
}

export interface SiteprobeJobStoreOptions {
  tooling: SiteprobeTooling;
  /** Where an internal fault's log goes (`<dataDir>/logs/`); absent in a test that only wants jobs. */
  dataDir?: string | undefined;
  /** How long a review run waits for a selection before the watch gives up. */
  selectionTimeoutMs?: number;
  watchIntervalMs?: number;
}

export interface SiteprobeJobStore {
  start(request: SiteprobeRunInput): SiteprobeRun;
  /**
   * Take a selection the browser downloaded and put it where the watch is looking.
   *
   * Throws when the run is unknown, when it never produced a review page, or when the file is not
   * JSON — a caller that hands over the wrong file should hear why rather than wait an hour.
   */
  acceptSelection(runId: string, upload: { name: string; content: string }): SiteprobeRun;
  /**
   * Tell a running login job that the person has finished signing in.
   *
   * The door waits for one line on stdin; this is the line. Throws when the run is not a login job
   * that is still going, because a caller that answers the wrong thing should hear why.
   */
  finishLogin(runId: string): SiteprobeRun;
  get(id: string): SiteprobeRun | null;
  list(): SiteprobeRun[];
  cancel(id: string): boolean;
  /** Stops every watch and kills every child; used when the server shuts down. */
  close(): void;
}

/** A scan prints a line per work; the caller reads the tail, so the head is what gets dropped. */
const MAX_EVENTS = 400;
const DEFAULT_SELECTION_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_WATCH_INTERVAL_MS = 2000;

interface JobState {
  snapshot: SiteprobeRun;
  process: SiteprobeProcess | null;
  /** Set for a login job: the door waiting for the person to say they are done. */
  login: SiteprobeLoginProcess | null;
  watch: NodeJS.Timeout | null;
  watchDeadline: number;
  /** The listing a review run wrote, which is where a selection belongs. */
  listing: string | null;
}

export function createSiteprobeJobStore(options: SiteprobeJobStoreOptions): SiteprobeJobStore {
  const jobs = new Map<string, JobState>();
  const watchInterval = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const selectionTimeout = options.selectionTimeoutMs ?? DEFAULT_SELECTION_TIMEOUT_MS;

  function push(state: JobState, event: SiteprobeEvent): void {
    state.snapshot.events.push(event);
    if (event.event === 'error') {
      state.snapshot.error = { code: event.code, message: event.message };
    }
    while (state.snapshot.events.length > MAX_EVENTS) {
      state.snapshot.events.shift();
      state.snapshot.eventsDropped += 1;
    }
    if (event.event === 'result') {
      state.snapshot.result = event;
      state.snapshot.selection = event.selection ?? state.snapshot.selection;
    }
  }

  /**
   * Wait for the review page's export to appear beside the page.
   *
   * The page is a file the person opened; its export is written by the browser's download, into the
   * listing directory the page names. So the only signal is the file existing — measured on this
   * machine, the export lands as `selection_<ref>.json` next to `review.html`. The watch ends when
   * the file appears, when the run is cancelled, or at the deadline, so a page that is never used
   * cannot leak a timer.
   */
  function watchForSelection(state: JobState, listing: string): void {
    state.watchDeadline = Date.now() + selectionTimeout;
    const timer = setInterval(() => {
      const found = newestSelection(listing);
      if (found) {
        state.snapshot.selection = found;
        stopWatch(state);
        return;
      }
      if (Date.now() > state.watchDeadline) {
        stopWatch(state);
      }
    }, watchInterval);
    timer.unref?.();
    state.watch = timer;
  }

  function stopWatch(state: JobState): void {
    if (state.watch) {
      clearInterval(state.watch);
      state.watch = null;
    }
  }

  function finish(state: JobState, code: number | null, cancelled: boolean): void {
    state.process = null;
    state.snapshot.finishedAt = new Date().toISOString();
    if (cancelled) {
      state.snapshot.status = 'cancelled';
    } else if (code === 0 && !state.snapshot.error) {
      state.snapshot.status = 'done';
    } else {
      state.snapshot.status = 'failed';
      state.snapshot.error = state.snapshot.error ?? {
        code: 'RUN_FAILED',
        message: `the tool exited with code ${code ?? 'null'}`,
      };
    }
  }

  /**
   * Whether a failure is one to report.
   *
   * A Python traceback on stderr is a fault nobody planned for — an unhandled exception inside the
   * tool — and it is worth a log and a bug report. Everything else the tool reports is a verdict: a
   * bot check, a page with no title, a listing that listed nothing. Measured on a real run where an
   * SSL handshake failure escaped as a traceback and the panel told the person to report a bug that
   * was really "the site refused this request for a moment".
   */
  function isInternalFault(stderr: string): boolean {
    return /Traceback \(most recent call last\)/u.test(stderr);
  }

  /** The line a person should read: the last thing the tool said, not the whole stack. */
  function lastLine(text: string): string {
    const lines = text.split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean);
    return lines.at(-1) ?? '';
  }

  async function reportFault(state: JobState, outcome: SiteprobeProcessOutcome): Promise<void> {
    const internal = isInternalFault(outcome.stderr);
    const message = lastLine(outcome.stderr)
      || `the tool exited with code ${outcome.code ?? 'null'}`;
    state.snapshot.error = internal
      ? { code: 'INTERNAL', message }
      : { code: 'RUN_FAILED', message };
    if (!internal || !options.dataDir) return;
    // Awaited, and awaited by the caller before the status changes: the log has to exist *before*
    // the run stops being `running`, because a caller polls until exactly that moment — measured when
    // this was fire-and-forget and the panel named a crash without the path to report it.
    try {
      const path = await writeSiteprobeErrorLog(options.dataDir, {
        kind: 'run',
        context: {
          runId: state.snapshot.id,
          input: state.snapshot.input,
          site: state.snapshot.site,
          kind: state.snapshot.kind,
        },
        stderr: outcome.stderr,
        code: outcome.code,
        environment: {
          tool: options.tooling.tool,
          python: options.tooling.python,
          home: options.tooling.home,
        },
      });
      if (state.snapshot.error?.code === 'INTERNAL') state.snapshot.error.logPath = path;
    } catch {
      // A log that cannot be written is not worth failing the run again over: the panel still shows
      // the tool's own last line.
    }
  }

  return {
    start(request: SiteprobeRunInput): SiteprobeRun {
      if (!options.tooling.ok) {
        throw new Error(options.tooling.detail ?? 'the SiteProbe tool is unavailable');
      }
      const id = randomUUID();
      const state: JobState = {
        snapshot: {
          id,
          command: request.login ? 'login'
            : request.build ? 'build'
            : request.selection ? 'selection' : 'run',
          input: request.selection ?? request.input ?? (request.build?.join(' ') ?? ''),
          site: request.site ?? null,
          kind: request.kind ?? null,
          review: request.review ?? false,
          status: 'running',
          events: [],
          eventsDropped: 0,
          result: null,
          error: null,
          selection: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        },
        process: null,
        login: null,
        watch: null,
        watchDeadline: 0,
        listing: null,
      };
      jobs.set(id, state);

        if (request.build) {
          // The builder's clock is a person annotating pages; its lines are guidance. Everything
          // after its exit — learning, verification, installation — happened inside the tool, and an
          // exit of 0 is what "installed" means there.
          // The builder's refusals are printed, not thrown: its own [ERROR] line is the message a
          // person can act on, and the bare exit code is the fallback.
          const builderLines: string[] = [];
          const build = startSiteprobeBuild(options.tooling, request.build, (line) => {
            builderLines.push(line);
            push(state, { event: 'progress', message: line });
          }, request.lang, request.kind);
          state.process = {
            done: build.done.then<SiteprobeProcessOutcome>(({ code, stderr }) => (
              { code, stderr, malformed: [], timedOut: false })),
            kill: () => build.kill(),
          };
          void state.process.done.then((outcome) => {
            const cancelled = state.snapshot.status === 'cancelled';
            if (!cancelled && outcome.code !== 0 && !state.snapshot.error) {
              // A traceback is the one fault nobody planned for. Everything else the builder
              // reports is a verdict about the draft or the site: exit 2 is a page it could not
              // read, exit 1 is its own refusal ("nothing was installed: …"), and the panel says
              // 过于复杂 for both. Calling an exit-1 refusal a bug sent a person to report a tool
              // working as designed — measured on 2026-10-03, on a mock site whose derived target
              // named none of the addresses it was learned from.
              const crash = isInternalFault(outcome.stderr);
              const said = crash
                ? (lastLine(outcome.stderr) || builderLines.at(-1))
                : ([...builderLines].reverse().find((line) => line.startsWith('[ERROR]'))
                   ?? builderLines.at(-1));
              state.snapshot.error = {
                code: crash ? 'INTERNAL' : 'RUN_FAILED',
                message: said ?? `the builder exited with code ${outcome.code ?? 'null'}`,
              };
            }
            stopWatch(state);
            finish(state, outcome.code, cancelled);
          }).catch((error: unknown) => {
            state.snapshot.status = 'failed';
            state.snapshot.error = { code: 'NOT_INSTALLED', message: (error as Error).message };
            state.snapshot.finishedAt = new Date().toISOString();
          });
          return structuredClone(state.snapshot);
        }
      if (request.login !== undefined) {
        // A job of the same shape, a different program: the tool's login door, which needs a console
        // window and a person. Its stdout is not a contract — the conversation happens in the window
        // — so this server says what it knows and waits for the door to close.
        push(state, {
          event: 'progress',
          message: 'Sign in in the browser window that just opened (or clear the check the site '
            + 'is showing), then press "I have signed in" on this page. That window closes itself '
            + 'once the session has been written.',
        });
        const login = startSiteprobeLogin(options.tooling, request.login, (line) => {
          // What the door prints, in the job's own log: the console may be behind other windows.
          push(state, { event: 'progress', message: line });
        });
        state.login = login;
        state.process = {
          done: login.done.then<SiteprobeProcessOutcome>(({ code, stderr }) => (
            { code, stderr, malformed: [], timedOut: false })),
          kill: () => login.kill(),
        };
        void state.process.done.then((outcome) => {
          const cancelled = state.snapshot.status === 'cancelled';
          if (!cancelled && outcome.code !== 0 && !state.snapshot.error) {
            state.snapshot.error = {
              code: 'RUN_FAILED',
              message: outcome.stderr.trim()
                || `the login door exited with code ${outcome.code ?? 'null'}`,
            };
          }
          stopWatch(state);
          finish(state, outcome.code, cancelled);
        }).catch((error: unknown) => {
          state.snapshot.status = 'failed';
          state.snapshot.error = { code: 'NOT_INSTALLED', message: (error as Error).message };
          state.snapshot.finishedAt = new Date().toISOString();
        });
        return structuredClone(state.snapshot);
      }

      const process = startSiteprobe(options.tooling, {
        args: runArguments(request),
        onEvent: (line) => {
          // A run's stream is the four run events; the one-shot answers (`sites`, `resolve`,
          // `readme`, `probe`) belong to their own questions and are ignored here rather than pushed
          // into a run's log.
          if (line.event === 'sites' || line.event === 'resolve' || line.event === 'readme'
            || line.event === 'probe') return;
          const event = line;
          push(state, event);
          if (event.event === 'review') {
            state.listing = event.listing;
            watchForSelection(state, event.listing);
          }
        },
      });
      state.process = process;

      void process.done.then(async (outcome) => {
        if (outcome.malformed.length > 0) {
          push(state, {
            event: 'error',
            code: 'INTERNAL',
            message: 'SiteProbe output does not match the loaded protocol. '
              + 'Restart T³ after updating SiteProbe. '
              + `${outcome.malformed.length} line(s) on stdout were not part of the contract: `
              + outcome.malformed.slice(0, 3).join(' | '),
          });
        }
        if (outcome.timedOut) {
          state.snapshot.error = { code: 'RUN_FAILED', message: 'the run exceeded its time budget' };
        }
        const cancelled = state.snapshot.status === 'cancelled';
        if (!cancelled && outcome.code !== 0 && !state.snapshot.error) {
          await reportFault(state, outcome);
        }
        if (!cancelled && outcome.code === 0 && !state.snapshot.error && !state.snapshot.result) {
          push(state, { event: 'error', code: 'INTERNAL',
            message: 'SiteProbe finished without a usable result. Restart T³ if SiteProbe was updated.' });
        }
        // A review run keeps its watch alive after the process ends: the page is exactly what the
        // person is looking at while the tool has already exited.
        if (!cancelled && !state.snapshot.error && state.snapshot.result?.review_html) {
          state.process = null;
          state.snapshot.status = 'done';
          state.snapshot.finishedAt = new Date().toISOString();
          return;
        }
        stopWatch(state);
        finish(state, outcome.code, cancelled);
      }).catch((error: unknown) => {
        state.snapshot.status = 'failed';
        state.snapshot.error = { code: 'NOT_INSTALLED', message: (error as Error).message };
        state.snapshot.finishedAt = new Date().toISOString();
        stopWatch(state);
      });

      return structuredClone(state.snapshot);
    },

    finishLogin(runId) {
      const state = jobs.get(runId);
      if (!state) throw new Error('Unknown SiteProbe run');
      if (!state.login || state.snapshot.status !== 'running') {
        throw new Error('That run is not a sign-in that is still waiting');
      }
      state.login.finish();
      push(state, {
        event: 'progress',
        message: 'The sign-in was reported finished; the door is writing the session.',
      });
      return structuredClone(state.snapshot);
    },

    acceptSelection(runId, upload) {
      const state = jobs.get(runId);
      if (!state) throw new Error('Unknown SiteProbe run');
      if (!state.listing) {
        throw new Error('This run produced no review page, so it has no listing to save a selection into');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(upload.content);
      } catch {
        throw new Error('That file is not JSON');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('That file is not a selection document');
      }
      const name = selectionFileName(upload.name);
      const target = join(state.listing, name);
      mkdirSync(state.listing, { recursive: true });
      writeFileSync(target, upload.content, 'utf8');
      // The watch would find it within a couple of seconds; setting it now is what makes the screen
      // move as soon as the person finishes, and the file is where the watch was looking anyway.
      state.snapshot.selection = target;
      stopWatch(state);
      return structuredClone(state.snapshot);
    },

    get(id: string): SiteprobeRun | null {
      const state = jobs.get(id);
      return state ? structuredClone(state.snapshot) : null;
    },

    list(): SiteprobeRun[] {
      return [...jobs.values()].map((state) => structuredClone(state.snapshot));
    },

    cancel(id: string): boolean {
      const state = jobs.get(id);
      if (!state) return false;
      if (state.snapshot.status !== 'running') {
        // A review run's process is already gone but its watch is not: cancelling withdraws it.
        stopWatch(state);
        return false;
      }
      state.snapshot.status = 'cancelled';
      state.snapshot.error = null;
      state.process?.kill();
      stopWatch(state);
      return true;
    },

    close(): void {
      for (const state of jobs.values()) {
        state.process?.kill();
        state.login?.kill();
        stopWatch(state);
      }
    },
  };
}

/**
 * The file name a handed-over selection is stored under.
 *
 * Only the base name survives: a browser's download name is data, not a path, and a name carrying
 * `..` or a separator is how a file would land outside the listing. The `selection_` prefix is what
 * the watch looks for, so it is added when the name does not already carry it.
 */
export function selectionFileName(downloaded: string): string {
  const base = downloaded.replaceAll(String.fromCharCode(92), '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[^\w.-]+/gu, '_').replace(/^\.+/u, '');
  const named = cleaned.toLowerCase().endsWith('.json') ? cleaned : `${cleaned}.json`;
  return named.startsWith('selection_') ? named : `selection_${named}`;
}

/** The selection file in this listing directory, newest first, or null when there is none yet. */
export function newestSelection(listing: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(listing);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((name) => name.startsWith('selection_') && name.endsWith('.json'))
    .map((name) => join(listing, name));
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    try {
      return statSync(right).mtimeMs - statSync(left).mtimeMs;
    } catch {
      return 0;
    }
  });
  return candidates[0] ?? null;
}
