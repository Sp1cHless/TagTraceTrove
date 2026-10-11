import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveSiteprobeTooling, findToolDirectory } from '../../src/siteprobe/home.js';
import { createSiteprobeRuntime } from '../../src/siteprobe/runtime.js';
import { newestSelection } from '../../src/siteprobe/jobs.js';
import { runSiteprobeOnce } from '../../src/siteprobe/transport.js';
import type { SiteprobeTooling } from '../../src/siteprobe/home.js';

const STUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'siteprobe-stub.mjs');

/** The stub, run through the real transport: no virtualenv, no network, same contract. */
function stubTooling(home: string): SiteprobeTooling {
  return {
    tool: dirname(STUB),
    python: process.execPath,
    pythonArgs: [STUB],
    linkArgs: [STUB],
    home,
    buildArgs: [STUB],
    listingArgs: [STUB],
    ok: true,
    detail: null,
  };
}

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 't3-siteprobe-test-'));
}

describe('locating the tool', () => {
  it('finds the checkout by walking up from the server package', () => {
    const found = findToolDirectory(join(process.cwd(), 'apps', 'server', 'src', 'siteprobe'));
    expect(found).toBeTruthy();
    expect(found!.endsWith('siteprobe')).toBe(true);
  });

  it('derives the home from the data root, and says what is missing when the venv is not built', () => {
    const dataDir = temporaryDirectory();
    const tooling = resolveSiteprobeTooling({ dataDir, env: {}, overrides: { tool: dataDir } });
    expect(tooling.ok).toBe(false);
    expect(tooling.detail).toContain('uv sync');
    // The home is `<dataDir>/siteprobe` — the same directory the tool resolves for itself, so a
    // bat double-clicked by hand and a run T³ started share one home (guidance §34).
    const withHome = resolveSiteprobeTooling({
      dataDir, env: {}, overrides: { tool: dataDir, python: process.execPath },
    });
    expect(withHome.home).toBe(join(dataDir, 'siteprobe'));
  });

  it('reports a missing checkout instead of failing later with an import error', () => {
    const tooling = resolveSiteprobeTooling({
      dataDir: temporaryDirectory(), env: {}, from: temporaryDirectory(),
    });
    expect(tooling.ok).toBe(false);
    expect(tooling.detail).toContain('was not found');
  });
});

describe('the transport boundary', () => {
  it('validates every line and reports the ones that are not the contract', async () => {
    const tooling = stubTooling(temporaryDirectory());
    const result = await runSiteprobeOnce(tooling, ['run', 'garbage']);
    expect(result.malformed).toEqual(['this line is not part of the contract']);
    expect(result.events).toEqual([]);
  });

  it('passes the home to the child, so a run writes where T³ looks', async () => {
    const home = temporaryDirectory();
    const result = await runSiteprobeOnce(stubTooling(home), ['sites']);
    const sites = result.events.find((event) => event.event === 'sites');
    expect(sites && sites.event === 'sites' && sites.home).toBe(home);
  });

  it('answers a miss as a miss, with the tool\'s own code', async () => {
    const result = await runSiteprobeOnce(stubTooling(temporaryDirectory()),
      ['resolve', 'https://elsewhere.test/x']);
    const resolve = result.events.find((event) => event.event === 'resolve');
    expect(result.code).toBe(2);
    expect(resolve && resolve.event === 'resolve' && resolve.matched).toBe(false);
  });
});

describe('runs', () => {
  it('collects the events of a finished run and the export it produced', async () => {
    const home = temporaryDirectory();
    const runtime = createSiteprobeRuntime({ dataDir: home, overrides: {
      tool: dirname(STUB), python: process.execPath, pythonArgs: [STUB], home,
    } });
    const started = runtime.jobs.start({ input: 'https://demo.test/work/42' });
    expect(started.status).toBe('running');

    const finished = await waitFor(() => {
      const job = runtime.jobs.get(started.id);
      return job && job.status !== 'running' ? job : null;
    });
    expect(finished.status).toBe('done');
    // The stub builds its paths with forward slashes; what matters is that the export the tool
    // reported is the one under the home T³ passed it.
    expect(finished.result?.export?.replaceAll('\\', '/'))
      .toBe(`${home.replaceAll('\\', '/')}/export/demo_test/listing_x/metadata.json`);
    expect(finished.result?.origin).toEqual({ kind: 'search', ref: 'x' });
    expect(finished.events.some((event) => event.event === 'progress')).toBe(true);
    runtime.close();
  });

  it('keeps a review run open and picks up the selection the page writes beside it', async () => {
    const home = temporaryDirectory();
    const listing = join(home, 'export', 'demo_test', 'listing_x');
    mkdirSync(listing, { recursive: true });
    const runtime = createSiteprobeRuntime({
      dataDir: home,
      overrides: { tool: dirname(STUB), python: process.execPath, pythonArgs: [STUB], linkArgs: [STUB], home },
    });
    const started = runtime.jobs.start({ input: 'https://demo.test/search/x', review: true });

    const reviewed = await waitFor(() => {
      // The report event arrives while the process is still exiting, so wait for the settled run —
      // which is exactly the state whose watch is meant to stay open.
      const job = runtime.jobs.get(started.id);
      return job && job.status === 'done' && job.result?.review_html ? job : null;
    });
    expect(reviewed.status).toBe('done');
    expect(reviewed.result?.export).toBeNull();
    expect(reviewed.selection).toBeNull();

    // What the review page's "save" does: the browser writes the selection into the listing folder.
    writeFileSync(join(listing, 'selection_x.json'), '{"selected_source_ids":["42"]}');
    const watched = await waitFor(() => {
      const job = runtime.jobs.get(started.id);
      return job?.selection ? job : null;
    }, 4000);
    expect(watched.selection).toBe(join(listing, 'selection_x.json'));
    runtime.close();
  });

  it('cancels a run by killing the child, and reports it as cancelled', async () => {
    const home = temporaryDirectory();
    const runtime = createSiteprobeRuntime({
      dataDir: home,
      overrides: { tool: dirname(STUB), python: process.execPath, pythonArgs: [STUB], linkArgs: [STUB], home },
    });
    const started = runtime.jobs.start({ input: 'slow' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runtime.jobs.cancel(started.id)).toBe(true);
    // `cancel` marks the run at once; waiting for `finishedAt` is waiting for the child to be gone,
    // which is the part that must actually happen.
    const cancelled = await waitFor(() => {
      const job = runtime.jobs.get(started.id);
      return job && job.status === 'cancelled' && job.finishedAt ? job : null;
    });
    expect(cancelled.finishedAt).toBeTruthy();
    runtime.close();
  });

  it('tells a crash apart from a verdict, and leaves a log behind for the crash', async () => {
    const home = temporaryDirectory();
    const runtime = createSiteprobeRuntime({ dataDir: home, overrides: {
      tool: dirname(STUB), python: process.execPath, pythonArgs: [STUB], home,
    } });
    const started = runtime.jobs.start({ input: 'crash' });

    const crashed = await waitFor(() => {
      const job = runtime.jobs.get(started.id);
      return job && job.status !== 'running' ? job : null;
    });
    expect(crashed.status).toBe('failed');
    // A traceback is a fault nobody planned for: the person is asked to report it, and the evidence
    // is on disk rather than gone with the response.
    expect(crashed.error?.code).toBe('INTERNAL');
    expect(crashed.error?.message).toBe('SSLError: Connection closed abruptly');
    expect(crashed.error?.logPath).toBeTruthy();
    expect(readFileSync(String(crashed.error?.logPath), 'utf8')).toContain('Traceback');
    runtime.close();
  });

  it('reports a failed run with the code the tool gave, not just an exit code', async () => {
    const home = temporaryDirectory();
    const runtime = createSiteprobeRuntime({
      dataDir: home,
      overrides: { tool: dirname(STUB), python: process.execPath, pythonArgs: [STUB], linkArgs: [STUB], home },
    });
    const started = runtime.jobs.start({ input: 'boom' });
    const failed = await waitFor(() => {
      const job = runtime.jobs.get(started.id);
      return job && job.status === 'failed' ? job : null;
    });
    expect(failed.error).toEqual({ code: 'RUN_FAILED', message: 'the site refused' });
    runtime.close();
  });
});

describe('the login door', () => {
  /** A bat that takes its time, so "the job waits for the window" can be measured, not assumed. */
  function loginTooling(): { tooling: SiteprobeTooling; marker: string; home: string } {
    const tool = temporaryDirectory();
    const home = temporaryDirectory();
    const marker = join(tool, 'signed-in.txt');
    const crlf = String.fromCharCode(13, 10);
    const bat = ['@echo off',
                 'chcp 65001 >nul',
                 // The address off the environment, the flag off the command line — exactly the
                 // contract the real bat has, and the one `cmd`'s argument splitting made necessary.
                 `echo %SITEPROBE_LOGIN_TARGET% > "${marker}"`,
                 `echo %~1 >> "${marker}"`,
                 `echo %~2 >> "${marker}"`,
                 // Blocks on one line of stdin, the way the real door waits for the person in T³.
                 'set /p SIGNED_IN=',
                 'echo signed in >> "' + marker + '"',
                 // What the door was handed, and Chinese printed by a python forced out of UTF-8
                 // mode: the real door prints Chinese, and Python encodes a *piped* stdout by the
                 // locale — measured in the app as `??????` on the line that says where to sign in.
                 'echo PYTHONIOENCODING=%PYTHONIOENCODING%',
                 // The door waits on the person too, so its lines have to leave Python's buffer
                 // before the wait ends — the same env the builder needs, asked for by name.
                 'echo PYTHONUNBUFFERED=%PYTHONUNBUFFERED%',
                 'set "PYTHONUTF8=0"',
                 'python -X utf8=0 -c "print(chr(0x5df2) + chr(0x767b) + chr(0x5f55))"',
                 'exit /b 0'].join(crlf);
    writeFileSync(join(tool, '登录.bat'), `${bat}${crlf}`, 'latin1');
    return { tooling: { ...stubTooling(home), tool }, marker, home };
  }

  it.skipIf(process.platform !== 'win32')(
    'waits for the person to say they are done, and reports where to say it',
    async () => {
      const { tooling, marker } = loginTooling();
      // A pipe's encoding is what this test is about, so the ambient environment must not answer for
      // the door: this shell exports both variables, and inheriting them hides the difference.
      const ambient = { ...process.env };
      delete process.env.PYTHONIOENCODING;
      delete process.env.PYTHONUTF8;
      const runtime = createSiteprobeRuntime({ dataDir: tooling.home, overrides: {
        tool: tooling.tool, python: process.execPath, pythonArgs: [STUB], home: tooling.home,
      } });
      // An address with `=` in it, which is what a favourite or search page looks like: `cmd` splits
     // batch arguments on it, so passing this as an argument truncated the address *and* hid the flag
     // (measured on a real favourite URL: `?folder=4717648` arrived as a second argument).
     const target = 'https://demo.test/user/x/favorite/albums?folder=4717648';
    const started = runtime.jobs.start({ login: target });
      expect(started.command).toBe('login');
      expect(started.status).toBe('running');
      expect(started.events[0]).toMatchObject({ event: 'progress' });
      // The line the person reads points at the page they are on, not at a console window: there
      // was never a window on the machine where this was first used.
      expect(String((started.events[0] as { message: string }).message))
        .toContain('I have signed in');

      // Still running: the door is a person's sign-in, not a fire-and-forget spawn.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(runtime.jobs.get(started.id)?.status).toBe('running');
      expect(readFileSync(marker, 'utf8')).not.toContain('signed in');

      // "I have signed in" — the answer comes from the page, and the door finishes on it.
      const answered = runtime.jobs.finishLogin(started.id);
      expect(answered.status).toBe('running');
      const finished = await waitFor(() => {
        const job = runtime.jobs.get(started.id);
        return job && job.status !== 'running' ? job : null;
      });
      expect(finished.status).toBe('done');
      const recorded = readFileSync(marker, 'utf8');
      // Whole, with its `=` intact, because it travelled in the environment.
      expect(recorded).toContain(target);
      expect(recorded).toContain('signed in');
      // `--no-pause` is the only argument: the real bat ends in `pause`, and under the stdin pipe
      // this server holds open a pause never returns — measured on the real bat, still running after
      // six seconds, which is exactly how a finished sign-in looked like a stuck tool.
      expect(recorded.split(String.fromCharCode(10))[1]?.trim()).toBe('--no-pause');
      Object.assign(process.env, ambient);
      // The door's own words reach the log as text, not as replacement characters.
      const lines = finished.events.flatMap((event) => (
        event.event === 'progress' ? [event.message] : []));
      expect(lines.join(' ')).toContain('PYTHONIOENCODING=utf-8');
      expect(lines.join(' ')).toContain('PYTHONUNBUFFERED=1');
      expect(lines.join(' ')).toContain('已登录');
      runtime.close();
    },
    // The bat sleeps on purpose, so this test measures waiting rather than racing a 5s default.
    20_000);

  it.skipIf(process.platform !== 'win32')('refuses to answer a run that is not a sign-in', async () => {
    const home = temporaryDirectory();
    const runtime = createSiteprobeRuntime({ dataDir: home, overrides: {
      tool: dirname(STUB), python: process.execPath, pythonArgs: [STUB], home,
    } });
    const crawl = runtime.jobs.start({ input: 'https://demo.test/work/42' });
    expect(() => runtime.jobs.finishLogin(crawl.id)).toThrow('not a sign-in');
    runtime.close();
  });

  it.skipIf(process.platform !== 'win32')('cancels by stopping the wait', async () => {
    const { tooling } = loginTooling();
    const runtime = createSiteprobeRuntime({ dataDir: tooling.home, overrides: {
      tool: tooling.tool, python: process.execPath, pythonArgs: [STUB], home: tooling.home,
    } });
    const started = runtime.jobs.start({ login: 'demo.test' });
    expect(runtime.jobs.cancel(started.id)).toBe(true);
    expect(runtime.jobs.get(started.id)?.status).toBe('cancelled');
    runtime.close();
  });
});


describe('the adapter builder job', () => {
  /** The stub builder speaks the builder's console shape and waits the way it waits. */
  function buildRuntime(): { runtime: ReturnType<typeof createSiteprobeRuntime>; marker: string } {
    const tool = temporaryDirectory();
    const home = temporaryDirectory();
    const marker = join(tool, 'annotated.marker');
    writeFileSync(join(tool, 'BUILD_MARKER'), marker, 'utf8');
    const stub = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures',
                      'siteprobe-build-stub.mjs');
    const runtime = createSiteprobeRuntime({ dataDir: home, overrides: {
      tool, python: process.execPath, pythonArgs: [STUB], buildArgs: [stub],
      // The same stub stands in for the listing builder: it speaks the builder's console shape, and
      // it reports the `--kind` only a listing build carries.
      listingArgs: [stub], home,
    } });
    // The stub reads its marker path from the environment.
    process.env.BUILD_MARKER = marker;
    process.env.BUILD_HOME = home;
    return { runtime, marker };
  }

  it('streams the builder guidance as progress and finishes when the person is done', async () => {
    const { runtime, marker } = buildRuntime();
    const started = runtime.jobs.start({ build: ['https://built.test/work/1', 'https://built.test/work/2'] });
    expect(started.command).toBe('build');
    expect(started.status).toBe('running');
    expect(started.input).toBe('https://built.test/work/1 https://built.test/work/2');

    // The person annotates at their own pace; the job is running until they do.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(runtime.jobs.get(started.id)?.status).toBe('running');
    writeFileSync(marker, 'done', 'utf8');

    const finished = await waitFor(() => {
      const job = runtime.jobs.get(started.id);
      return job && job.status !== 'running' ? job : null;
    });
    expect(finished.status).toBe('done');
    expect(finished.error).toBeNull();
    const lines = finished.events.flatMap((event) => (
      event.event === 'progress' ? [event.message] : []));
    expect(lines.join(' ')).toContain('capturing https://built.test/work/1');
    // The line the web page keys its "the adapter is ready" step on.
    expect(lines.join(' ')).toContain('=== installed');
    runtime.close();
    delete process.env.BUILD_MARKER;
    delete process.env.BUILD_HOME;
  });

  it('builds a listing through the tool’s listing door, with the kind it is learned under', async () => {
    // A listing build is the *other* builder: the tool ships `build_listing.py` beside
    // `build_adapter.py`, and it is told which listing to learn with `--kind=` — the same flag its own
    // bat passes. The kind is the evidence that this door was used: `build_adapter.py` takes no such
    // flag, so the stub reporting one can only mean the transport chose the listing command.
    const { runtime, marker } = buildRuntime();
    const started = runtime.jobs.start({
      build: ['https://built.test/list/1', 'https://built.test/list/2'], kind: 'search',
    });
    expect(started.command).toBe('build');
    // The builder waits on the person; the guidance has to arrive while it waits, so the job is read
    // once mid-flight and then released — the same rhythm the streaming test above uses.
    await new Promise((resolve) => setTimeout(resolve, 700));
    writeFileSync(marker, 'done', 'utf8');
    const finished = await waitFor(() => {
      const job = runtime.jobs.get(started.id);
      return job && job.status !== 'running' ? job : null;
    });
    const lines = finished.events.flatMap((event) => (
      event.event === 'progress' ? [event.message] : [])).join(' ');

    expect(lines).toContain('kind: --kind=search');
    // Both pages of the listing reach the builder: the second one is how it learns to turn the page.
    expect(lines).toContain('capturing https://built.test/list/1');
    expect(lines).toContain('capturing https://built.test/list/2');
    runtime.close();
    delete process.env.BUILD_MARKER;
    delete process.env.BUILD_HOME;
  });

  it('says a page is open while the run is still waiting on the person', async () => {
    const { runtime } = buildRuntime();
    const started = runtime.jobs.start({ build: ['https://built.test/work/1'] });
    // The stub holds its lines in a buffer unless `PYTHONUNBUFFERED` is set, the way a piped
    // Python does; the page's address and "opening the page" are what the person acts on, and
    // they have to arrive *while the builder waits*, not at exit. Without the transport's env
    // this times out — measured on 2026-10-03, where the annotation page was served and T³
    // stayed on "preparing the adapter" with a one-line log.
    const lines = await waitFor(() => {
      const job = runtime.jobs.get(started.id);
      const spoken = job?.events.flatMap((event) => (
        event.event === 'progress' ? [event.message] : [])) ?? [];
      return spoken.some((line) => line.includes('opening the page (annotate)')) ? spoken : null;
    }, 4000);
    expect(runtime.jobs.get(started.id)?.status).toBe('running');
    expect(lines.join(' ')).toContain('annotation page: http://127.0.0.1:45555');
    runtime.close();
    delete process.env.BUILD_MARKER;
    delete process.env.BUILD_HOME;
  });

  it('reads the builder’s refusal as a verdict and a traceback as a bug', async () => {
    process.env.BUILD_REFUSE = '1';
    const refused = buildRuntime();
    const refusing = refused.runtime.jobs.start({ build: ['https://built.test/work/1'] });
    const settled = await waitFor(() => {
      const job = refused.runtime.jobs.get(refusing.id);
      return job && job.status !== 'running' ? job : null;
    });
    // Exit 1 with no traceback is the builder's own judgement — the draft did not survive it.
    // Reporting that as a bug sent a person to report a tool working as designed (measured on
    // 2026-10-03, when a mock site's derived target named none of the addresses it came from).
    expect(settled.status).toBe('failed');
    expect(settled.error?.code).toBe('RUN_FAILED');
    expect(settled.error?.message).toContain('nothing was installed');
    refused.runtime.close();
    delete process.env.BUILD_REFUSE;

    process.env.BUILD_CRASH = '1';
    const crashed = buildRuntime();
    const crashing = crashed.runtime.jobs.start({ build: ['https://built.test/work/1'] });
    const broken = await waitFor(() => {
      const job = crashed.runtime.jobs.get(crashing.id);
      return job && job.status !== 'running' ? job : null;
    });
    expect(broken.error?.code).toBe('INTERNAL');
    expect(broken.error?.message).toContain('ValueError');
    crashed.runtime.close();
    delete process.env.BUILD_CRASH;
    delete process.env.BUILD_MARKER;
    delete process.env.BUILD_HOME;
  });

  it('serves the pages it opens in the language T³ is in', async () => {
    // The annotation pages are read by someone inside T³, and the tool is a Python process that
    // cannot ask the browser — so the language travels with the request and out in the environment.
    const { runtime } = buildRuntime();
    const started = runtime.jobs.start({ build: ['https://built.test/work/1'], lang: 'en' });
    const lines = await waitFor(() => {
      const job = runtime.jobs.get(started.id);
      const spoken = job?.events.flatMap((event) => (
        event.event === 'progress' ? [event.message] : [])) ?? [];
      return spoken.some((line) => line.includes('language:')) ? spoken : null;
    }, 4000);
    expect(lines.join(' ')).toContain('language: en');
    runtime.close();
    delete process.env.BUILD_MARKER;
    delete process.env.BUILD_HOME;
  });

  it('cancels the whole tree, headless browser included', async () => {
    const { runtime } = buildRuntime();
    const started = runtime.jobs.start({ build: ['https://built.test/work/1'] });
    expect(runtime.jobs.cancel(started.id)).toBe(true);
    expect(runtime.jobs.get(started.id)?.status).toBe('cancelled');
    runtime.close();
    delete process.env.BUILD_MARKER;
    delete process.env.BUILD_HOME;
  });
});

describe('the selection watch', () => {
  it('takes the newest selection file and ignores everything else', () => {
    const listing = temporaryDirectory();
    expect(newestSelection(listing)).toBeNull();
    writeFileSync(join(listing, 'review.html'), '<html></html>');
    writeFileSync(join(listing, 'cards.json'), '[]');
    expect(newestSelection(listing)).toBeNull();
    writeFileSync(join(listing, 'selection_a.json'), '{}');
    expect(newestSelection(listing)).toBe(join(listing, 'selection_a.json'));
  });
});

async function waitFor<T>(probe: () => T | null, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the run');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
