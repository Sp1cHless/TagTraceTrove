import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import type { SiteprobeRun } from '../../packages/shared/src/index.js';
import { createMigratedMemoryDatabase } from '../../apps/server/src/database/testing.js';
import { createApiApp } from '../../apps/server/src/http/app.js';
import { createSiteprobeRuntime } from '../../apps/server/src/siteprobe/runtime.js';
import AdvancedImportPanel from '../../apps/web/src/components/AdvancedImportPanel.vue';
import { createGalleryApi, type GalleryApi } from '../../apps/web/src/api/gallery.js';
import { createApiClient } from '../../apps/web/src/api/client.js';
import { setLocale } from '../../apps/web/src/i18n.js';

vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://isolated/' });
  for (const key of ['window', 'document', 'Document', 'Element', 'HTMLElement', 'HTMLInputElement',
    'SVGElement', 'Node', 'ShadowRoot', 'Event', 'localStorage', 'navigator']) {
    Object.defineProperty(globalThis, key, {
      value: key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window], configurable: true,
    });
  }
});

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../apps/server/tests/fixtures');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('SiteProbe concurrency check did not settle');
    await flushPromises();
    await pause();
  }
}

async function setup() {
  setLocale('en');
  const dataDir = await mkdtemp(join(tmpdir(), 't3-siteprobe-concurrency-'));
  const database = createMigratedMemoryDatabase();
  const runtime = createSiteprobeRuntime({ dataDir, overrides: {
    tool: fixtures, python: process.execPath,
    pythonArgs: [join(fixtures, 'siteprobe-stub.mjs')],
    buildArgs: [join(fixtures, 'siteprobe-build-stub.mjs')], home: join(dataDir, 'siteprobe'),
  } });
  const app = createApiApp(database, { dataDir, assetRoot: join(dataDir, 'assets'), siteprobeRuntime: runtime });
  const api = createGalleryApi(createApiClient({ baseUrl: 'http://isolated/api',
    fetchImplementation: async (input, init) => app.request(new URL(String(input)).pathname, init),
  }));
  cleanups.push(async () => { runtime.close(); database.close(); await rm(dataDir, { recursive: true, force: true }); });
  const post = (body: unknown) => app.request('/api/siteprobe/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { dataDir, runtime, api, post };
}

function snapshot(overrides: Partial<SiteprobeRun> = {}): SiteprobeRun {
  return { id: 'old-task', command: 'run', input: 'https://demo.test/work/1',
    site: null, kind: null, review: false, status: 'running', events: [], eventsDropped: 0,
    result: null, error: null, selection: null, startedAt: new Date().toISOString(), finishedAt: null,
    ...overrides };
}

async function mounted(api: GalleryApi) {
  let ready = false;
  const wrapper = mount(AdvancedImportPanel, { props: { api: { ...api,
    async listSiteprobeRuns() {
      try { return await api.listSiteprobeRuns(); } finally { ready = true; }
    },
  } } });
  cleanups.push(async () => wrapper.unmount());
  await until(() => ready);
  // Mounting reads the registry then the run list, independently of whether a kind is selected.
  await flushPromises();
  return wrapper;
}

it('SiteProbe concurrency: a failed launch leaves no phantom run and the next import completes', async () => {
  const f = await setup();
  const failed = await f.post({ login: 'https://demo.test/work/1' });
  expect(failed.status).toBe(500);
  expect(f.runtime.jobs.list()).toEqual([]);
  const response = await f.post({ input: 'https://demo.test/work/2' });
  expect(response.status).toBe(201);
  const job = await response.json() as SiteprobeRun;
  await until(() => f.runtime.jobs.get(job.id)?.status === 'done');
});

it('SiteProbe concurrency: a waiting builder allows imports while export writers stay exclusive and logged', async () => {
  const f = await setup();
  const marker = join(f.dataDir, 'annotation-submitted');
  vi.stubEnv('BUILD_MARKER', marker);
  const builder = await (await f.post({ build: ['https://demo.test/work/1'] })).json() as SiteprobeRun;
  await until(() => (f.runtime.jobs.get(builder.id)?.events.length ?? 0) > 0);
  const response = await f.post({ input: 'https://demo.test/work/2' });
  expect(response.status).toBe(201);
  const imported = await response.json() as SiteprobeRun;
  await until(() => f.runtime.jobs.get(imported.id)?.status === 'done');
  expect(f.runtime.jobs.get(builder.id)?.status).toBe('running');
  const slow = await (await f.post({ input: 'slow' })).json() as SiteprobeRun;
  const blocked = await f.post({ input: 'https://demo.test/work/3' });
  expect(blocked.status).toBe(409);
  const payload = await blocked.json() as { error: { details: { runId: string; logPath: string } } };
  expect(payload.error.details.runId).toBe(slow.id);
  const log = await readFile(payload.error.details.logPath, 'utf8');
  expect(log).toContain('kind        run-conflict');
  expect(log).toContain(slow.id);
  expect(log).toContain('https://demo.test/work/3');
  f.runtime.jobs.cancel(slow.id);
  expect((await f.post({ input: 'https://demo.test/work/4' })).status).toBe(201);
  const secondBuilder = await f.post({ build: ['https://demo.test/work/5'] });
  expect(secondBuilder.status).toBe(409);
  const secondPayload = await secondBuilder.json() as { error: { details: { logPath: string } } };
  expect(secondPayload.error.details.logPath).not.toBe(payload.error.details.logPath);
  expect(await readFile(payload.error.details.logPath, 'utf8')).toBe(log);
  await writeFile(marker, 'done');
  await until(() => f.runtime.jobs.get(builder.id)?.status === 'done');
});

it.each(['run', 'selection', 'login', 'build'] as const)(
  'SiteProbe concurrency: recovered %s with no kind always has a stop control', async (command) => {
    const f = await setup();
    const task = snapshot({ command, events: [{ event: 'progress', message: 'Waiting on the old task' }] });
    const api = { ...f.api, listSiteprobeRuns: vi.fn(async () => [task]),
      getSiteprobeRun: vi.fn(async () => task),
      cancelSiteprobeRun: vi.fn(async () => snapshot({ command, status: 'cancelled' })),
    };
    const wrapper = await mounted(api);
    await until(() => wrapper.find('[data-testid="siteprobe-cancel"]').exists());
    expect(wrapper.get('[data-testid="siteprobe-active-run"]').text()).toContain(task.input);
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://unknown.test/work/2');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    expect(wrapper.find('[data-testid="siteprobe-cancel"]').exists()).toBe(true);
    await wrapper.get('[data-testid="siteprobe-cancel"]').trigger('click');
    expect(api.cancelSiteprobeRun).toHaveBeenCalledWith(task.id);
  });

it('SiteProbe concurrency: a conflict restores the blocker, keeps the requested link and exposes its log', async () => {
  const f = await setup();
  const wrapper = await mounted(f.api);
  await until(() => !wrapper.find('[data-testid="siteprobe-unavailable"]').exists());
  await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/work/2');
  await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
  await until(() => wrapper.find('[data-testid="siteprobe-run"]').exists());
  const old = await (await f.post({ input: 'slow' })).json() as SiteprobeRun;
  await wrapper.get('[data-testid="siteprobe-run"]').trigger('click');
  await until(() => wrapper.find('[data-testid="siteprobe-cancel"]').exists());
  expect(wrapper.get('[data-testid="siteprobe-error"]').text()).toContain('Another task is still running');
  expect(wrapper.get('[data-testid="siteprobe-error"]').text()).toContain('run-conflict');
  expect((wrapper.get('[data-testid="siteprobe-source"]').element as HTMLInputElement).value)
    .toBe('https://demo.test/work/2');
  expect(wrapper.get('[data-testid="siteprobe-active-run"]').text()).toContain('slow');
  await wrapper.get('[data-testid="siteprobe-cancel"]').trigger('click');
  await until(() => !(wrapper.get('[data-testid="siteprobe-run"]').element as HTMLButtonElement).disabled);
  expect(f.runtime.jobs.get(old.id)?.status).toBe('cancelled');
  expect((wrapper.get('[data-testid="siteprobe-run"]').element as HTMLButtonElement).disabled).toBe(false);
});

it('SiteProbe concurrency: rapid clicks during source validation and launch start one import', async () => {
  const f = await setup();
  let resolveValidation!: (answer: Awaited<ReturnType<GalleryApi['siteprobeResolve']>>) => void;
  let resolveLaunch!: (answer: SiteprobeRun) => void;
  const api = { ...f.api,
    siteprobeResolve: vi.fn(async (request: Parameters<GalleryApi['siteprobeResolve']>[0]) => request.input.endsWith('/new')
      ? new Promise<Awaited<ReturnType<GalleryApi['siteprobeResolve']>>>((resolve) => { resolveValidation = resolve; })
      : f.api.siteprobeResolve(request)),
    startSiteprobeRun: vi.fn(() => new Promise<SiteprobeRun>((resolve) => { resolveLaunch = resolve; })),
    getSiteprobeRun: vi.fn(async () => snapshot()),
  };
  const wrapper = await mounted(api);
  await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/work/1');
  await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
  await until(() => wrapper.find('[data-testid="siteprobe-run"]').exists());
  await wrapper.get('[data-testid="siteprobe-kind-work"]').trigger('click');
  await wrapper.get('[data-testid="siteprobe-source"]').setValue('https://demo.test/work/new');
  const button = wrapper.get('[data-testid="siteprobe-run"]');
  await button.trigger('click');
  await button.trigger('click');
  expect(api.siteprobeResolve.mock.calls.filter(([request]) => request.input.endsWith('/new'))).toHaveLength(1);
  expect(api.startSiteprobeRun).not.toHaveBeenCalled();
  resolveValidation(await f.api.siteprobeResolve({ input: 'https://demo.test/work/new' }));
  await until(() => api.startSiteprobeRun.mock.calls.length === 1);
  await button.trigger('click');
  expect(api.startSiteprobeRun).toHaveBeenCalledTimes(1);
  resolveLaunch(snapshot());
  await flushPromises();
});

it('SiteProbe concurrency: an adopted builder permits importing a new link without cancelling the build', async () => {
  const f = await setup();
  const task = snapshot({ command: 'build' });
  const api = { ...f.api, listSiteprobeRuns: vi.fn(async () => [task]),
    startSiteprobeRun: vi.fn(async () => snapshot({ id: 'new-import' })),
    getSiteprobeRun: vi.fn(async () => task), cancelSiteprobeRun: vi.fn(),
  };
  const wrapper = await mounted(api);
  await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/work/2');
  await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
  await until(() => wrapper.find('[data-testid="siteprobe-run"]').exists());
  expect((wrapper.get('[data-testid="siteprobe-run"]').element as HTMLButtonElement).disabled).toBe(false);
  await wrapper.get('[data-testid="siteprobe-run"]').trigger('click');
  await until(() => api.startSiteprobeRun.mock.calls.length === 1);
  expect(api.startSiteprobeRun).toHaveBeenCalledWith(expect.objectContaining({ input: 'https://demo.test/work/2' }));
  expect(api.cancelSiteprobeRun).not.toHaveBeenCalled();
});
