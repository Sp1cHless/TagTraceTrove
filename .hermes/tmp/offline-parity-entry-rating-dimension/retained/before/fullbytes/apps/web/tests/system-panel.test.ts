// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AdvancedEditingPage from '../src/AdvancedEditingPage.vue';
import { clearClientErrors } from '../src/client-errors.js';
import { createMemoryOfflineStore } from '../src/offline/memory-offline-store.js';
import { setLocale } from '../src/i18n.js';
import type { GalleryApi } from '../src/api/gallery.js';

/**
 * The System page is the one place that talks to the desktop directly instead of through the
 * library API, so its contract is: it must show what the desktop says, never invent a backup
 * result, and keep the switch following the server rather than the click.
 */
function diagnosticsPayload(overrides: Record<string, unknown> = {}) {
  return {
    logPath: 'D:/repo/t3-server.log',
    logBytes: 2048,
    logTruncated: false,
    logTail: 'Error: SQLITE_BUSY\n    at somewhere',
    dataDir: 'D:/repo/apps/server/.data',
    databasePath: 'D:/repo/apps/server/.data/library.db',
    backupsDir: 'D:/repo/apps/server/.data/backups',
    backupCount: 1,
    settings: { autoAllowMobileConnection: true },
    settingsPath: 'D:/repo/apps/server/.data/t3-settings.json',
    settingsProblem: null,
    stagedRestore: null,
    nodeVersion: 'v22.23.2',
    platform: 'win32 x64',
    ...overrides,
  };
}

const backupsPayload = [{
  name: 'library-20261009T120000.db',
  createdAt: '2026-10-09T12:00:00.000Z',
  bytes: 5_242_880,
  entryCount: 6203,
  producerCount: 1180,
  schemaVersion: 42,
}];

interface Stub {
  calls: Array<{ url: string; method: string }>;
}

function stubFetch(options: {
  diagnostics?: unknown;
  backups?: unknown[];
  created?: unknown;
  staged?: unknown;
  settingsResult?: unknown;
  settingsFailure?: string;
} = {}): Stub {
  const stub: Stub = { calls: [] };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    stub.calls.push({ url, method });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
    if (url.endsWith('/api/system/diagnostics')) return json(options.diagnostics ?? diagnosticsPayload());
    if (url.endsWith('/api/system/backups') && method === 'GET') return json({ backups: options.backups ?? backupsPayload });
    if (url.endsWith('/api/system/backups') && method === 'POST') {
      return json({ backup: options.created ?? backupsPayload[0] });
    }
    if (url.includes('/api/system/backups/') && method === 'DELETE') return json({ removed: 'x' });
    if (url.endsWith('/api/system/restore') && method === 'POST') {
      return json({ staged: options.staged ?? null, restartRequired: true });
    }
    if (url.endsWith('/api/system/settings') && method === 'PUT') {
      if (options.settingsFailure !== undefined) return json({ error: { message: options.settingsFailure } }, 400);
      return json({ settings: options.settingsResult ?? { autoAllowMobileConnection: false } });
    }
    return json({ error: { message: `unexpected ${method} ${url}` } }, 500);
  }));
  return stub;
}

async function openSystemTab() {
  const api = {
    assetUrl: (path: string) => path,
    commonTemplate: async () => null,
    listTemplates: async () => [],
    listRatingSlots: async () => [],
  } as unknown as GalleryApi;
  const wrapper = mount(AdvancedEditingPage, {
    props: { api, store: createMemoryOfflineStore(), online: true },
    global: { stubs: { SourceMaintenancePanel: true } },
  });
  await wrapper.get('[data-testid="advanced-tab-system"]').trigger('click');
  await flushPromises();
  return wrapper;
}

describe('the System page', () => {
  beforeEach(() => {
    setLocale('en');
    clearClientErrors();
    vi.unstubAllGlobals();
  });

  it('shows the desktop log, its paths, and the errors this page has seen', async () => {
    const stub = stubFetch();
    const wrapper = await openSystemTab();
    const report = wrapper.get('[data-testid="system-report"]').element as HTMLTextAreaElement;
    expect(report.value).toContain('SQLITE_BUSY');
    expect(report.value).toContain('D:/repo/apps/server/.data/library.db');
    expect(report.value).toContain('--- page errors since load (0) ---');
    expect(stub.calls.map((call) => call.url)).toContain('/api/system/diagnostics');
    // The log the desktop could not answer for is said plainly instead of looking empty.
    expect(wrapper.find('[data-testid="system-error"]').exists()).toBe(false);
  });

  it('copies the report, and says so', async () => {
    stubFetch();
    let copied = '';
    const writeText = vi.fn(async (text: string) => { copied = text; });
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const wrapper = await openSystemTab();
    await wrapper.get('[data-testid="system-copy"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(copied).toContain('SQLITE_BUSY');
    expect(wrapper.get('[data-testid="system-notice"]').text()).toMatch(/Copied/u);
  });

  it('lists backups and backs up on demand', async () => {
    const stub = stubFetch({ created: { ...backupsPayload[0]!, name: 'library-20261009T130000.db' } });
    const wrapper = await openSystemTab();
    expect(wrapper.get('[data-testid="system-backups"]').text()).toContain('library-20261009T120000.db');
    expect(wrapper.get('[data-testid="system-backups"]').text()).toContain('6203');
    await wrapper.get('[data-testid="system-backup"]').trigger('click');
    await flushPromises();
    expect(stub.calls.some((call) => call.method === 'POST' && call.url.endsWith('/api/system/backups'))).toBe(true);
    expect(wrapper.get('[data-testid="system-notice"]').text()).toContain('library-20261009T130000.db');
  });

  it('stages a restore and tells the person to restart, without claiming it is done', async () => {
    const staged = {
      stagedAt: '2026-10-09T13:10:00.000Z',
      bytes: 5_242_880,
      entryCount: 6100,
      producerCount: 1170,
      schemaVersion: 42,
    };
    stubFetch({ staged });
    const wrapper = await openSystemTab();
    const input = wrapper.get('[data-testid="system-restore-file"]');
    const file = new File([new Uint8Array([1, 2, 3])], 'library.db', { type: 'application/vnd.sqlite3' });
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    expect(wrapper.get('[data-testid="system-restore-upload"]').text()).toContain('library.db');
    await wrapper.get('[data-testid="system-restore-upload"]').trigger('click');
    await flushPromises();
    // The page must not claim the library is restored: it is waiting for a restart.
    expect(wrapper.get('[data-testid="system-notice"]').text()).toMatch(/open it again/u);
    expect(wrapper.get('[data-testid="system-restore-waiting"]').text()).toMatch(/restart/u);
  });

  it('keeps the phone-access switch following the server, and reports a refusal', async () => {
    stubFetch({ settingsResult: { autoAllowMobileConnection: false } });
    const wrapper = await openSystemTab();
    const toggle = wrapper.get('[data-testid="system-auto-mobile"]').element as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await wrapper.get('[data-testid="system-auto-mobile"]').setValue(false);
    await flushPromises();
    expect(wrapper.get('[data-testid="system-notice"]').text()).toMatch(/stay closed/u);

    stubFetch({ settingsFailure: 'Unknown or missing setting' });
    const refusing = await openSystemTab();
    await refusing.get('[data-testid="system-auto-mobile"]').setValue(false);
    await flushPromises();
    expect(refusing.get('[data-testid="system-error"]').text()).toContain('Unknown or missing setting');
  });

  it('still shows the page and says so when the desktop does not answer', async () => {
    // A desktop that has not been restarted since this page shipped has no system routes yet:
    // the page must read as "the desktop did not answer", not as a broken or empty page.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'Route not found' },
    }), { status: 404, headers: { 'content-type': 'application/json' } })));
    const wrapper = await openSystemTab();
    expect(wrapper.get('[data-testid="system-error"]').text()).toContain('Route not found');
    const report = wrapper.get('[data-testid="system-report"]').element as HTMLTextAreaElement;
    expect(report.value).toContain('did not answer');
    expect(report.value).toContain('--- page ---');
  });

  it('keeps title shortening inside the Templates tab and out of the tab row', async () => {
    stubFetch();
    const wrapper = await openSystemTab();
    expect(wrapper.find('[data-testid="advanced-tab-titles"]').exists()).toBe(false);
    await wrapper.get('[data-testid="advanced-tab-templates"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="advanced-templates"]').find('[data-testid="advanced-titles"]').exists()).toBe(true);
  });
});
