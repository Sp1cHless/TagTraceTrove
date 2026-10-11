// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { ImportPreview, SiteprobeRun } from '@t3/shared';

import AdvancedImportPanel from '../src/components/AdvancedImportPanel.vue';
import { messages } from '../src/i18n.js';
import type { GalleryApi } from '../src/api/gallery.js';

/**
 * The advanced import page: an address in, an export out.
 *
 * These tests are the specification's branches, in order: no rule → go build one; a rule → the kinds
 * that site actually declares; an address of the wrong shape → ask again rather than crawl; one work
 * → straight to the import review; several → ask whether to filter, and follow either answer. The
 * run itself is the tool's, so the panel is tested against the tool's *events*, which is what it
 * actually reads.
 */
const SITES = {
  event: 'sites' as const,
  home: '/home/siteprobe',
  sites: [
    {
      key: 'demo.test',
      display_name: 'Demo',
      export_group: 'demo_test',
      hosts: ['demo.test'],
      targets: [
        { kind: 'work', label: 'Work', single: true, accepts_name: false, source: 'installed' },
        { kind: 'search', label: 'Search', single: false, accepts_name: true, source: 'installed' },
        { kind: 'favorite', label: '收藏夹', single: false, accepts_name: false, source: 'installed' },
      ],
      adapters: [{ source: 'installed', reads: ['work', 'search', 'favorite'], readme: true }],
    },
    {
      key: 'plain.test',
      display_name: 'Plain',
      export_group: 'plain_test',
      hosts: ['plain.test'],
      targets: [
        { kind: 'work', label: 'Work', single: true, accepts_name: false, source: 'local' },
      ],
      adapters: [{ source: 'local', reads: ['work'], readme: false }],
    },
    {
      // Two files for one site: a written adapter and a rule set learned for one of its listings.
      // Each target names the layer that answers it, which is the only case where that is a question.
      key: 'two.test',
      display_name: 'Two',
      export_group: 'two_test',
      hosts: ['two.test'],
      targets: [
        { kind: 'work', label: 'Work', single: true, accepts_name: false, source: 'installed' },
        { kind: 'search', label: 'Search', single: false, accepts_name: false, source: 'local' },
      ],
      adapters: [
        { source: 'installed', reads: ['work'], readme: false },
        { source: 'local', reads: ['search'], readme: false },
      ],
    },
  ],
};

function runSnapshot(overrides: Partial<SiteprobeRun> = {}): SiteprobeRun {
  return {
    id: 'run-1',
    command: 'run',
    input: 'https://demo.test/work/42',
    site: 'demo.test',
    kind: 'work',
    review: false,
    status: 'running',
    events: [],
    eventsDropped: 0,
    result: null,
    error: null,
    selection: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

const RESULT = {
  event: 'result' as const,
  command: 'run' as const,
  site: 'demo.test',
  kind: 'work',
  ref: '42',
  works: 1,
  listing: '/home/siteprobe/export/demo_test/single',
  export: '/home/siteprobe/export/demo_test/single/metadata.json',
  review_html: null,
  origin: null,
  media: {},
  warnings: [],
};

function api(overrides: Partial<GalleryApi> = {}): GalleryApi {
  return {
    siteprobeSites: vi.fn(async () => SITES),
    siteprobeStatus: vi.fn(async () => ({
      ok: true, home: '/home/siteprobe', tool: '/t', python: '/p', detail: null,
    })),
    siteprobeResolve: vi.fn(async () => ({
      event: 'resolve', matched: false, input: 'x', reason: 'NO_MATCH', detail: 'nothing claims it',
    })),
    siteprobeReadme: vi.fn(async (site: string) => ({
      site, source: 'installed', text: '# Demo<br>\n\nWhat it covers.',
    })),
    revealSiteprobeFolder: vi.fn(async (folder: string) => ({
      folder, path: `/home/siteprobe/${folder}`,
    })),
    siteprobeExportFileUrl: vi.fn((path: string) => `http://127.0.0.1:8765/api/siteprobe/export-file?path=${encodeURIComponent(path)}`),
    siteprobeLoginDone: vi.fn(async (runId: string) => runSnapshot({
      id: runId, command: 'login', status: 'running',
    })),
    uploadSiteprobeSelection: vi.fn(async (runId: string) => runSnapshot({
      id: runId, selection: '/export/demo_test/search_x/selection_kakao.json',
    })),
    startSiteprobeRun: vi.fn(async () => runSnapshot()),
    getSiteprobeRun: vi.fn(async () => runSnapshot()),
    cancelSiteprobeRun: vi.fn(async () => runSnapshot({ status: 'cancelled' })),
    previewSiteProbeExportPath: vi.fn(async () => ({ source: 'demo.test' } as unknown as ImportPreview)),
    ...overrides,
  } as unknown as GalleryApi;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function mounted(overrides: Partial<GalleryApi> = {}) {
  const client = api(overrides);
  const wrapper = mount(AdvancedImportPanel, { props: { api: client } });
  await sleep(0);
  return { wrapper, client };
}

/** A matched resolve answer, for the address the test pastes. */
function matched(kind: string, site = 'demo.test') {
  return {
    event: 'resolve' as const,
    matched: true as const,
    input: 'x',
    site,
    display_name: 'Demo',
    export_group: 'demo_test',
    source: 'installed',
    kind,
    label: kind,
    single: kind === 'work',
    ref: { id: '42' },
  };
}

describe('the advanced import page', () => {
  it('takes back a crawl that is still running when the page is opened again', async () => {
    // A run is a child process on the server, so leaving the page does not end it. The panel used to
    // forget it completely — a crawl of a few hundred works kept going with nothing left to watch
    // it, no progress and no cancel. Mounting asks what the server still holds.
    const running = runSnapshot({
      id: 'run-9',
      status: 'running',
      events: [{ event: 'progress', message: 'scanning https://demo.test/work/42' }],
    });
    const { wrapper, client } = await mounted({
      listSiteprobeRuns: vi.fn(async () => [running]),
    });

    expect(wrapper.get('[data-testid="siteprobe-log"]').text())
      .toContain('scanning https://demo.test/work/42');
    // And the way out is back.
    await wrapper.get('[data-testid="siteprobe-cancel"]').trigger('click');
    expect(client.cancelSiteprobeRun).toHaveBeenCalledWith('run-9');
  });

  it('offers to build a rule when no site claims the address, and hands the address over', async () => {
    const { wrapper } = await mounted();
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://somewhere.test/x');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);

    expect(wrapper.find('[data-testid="siteprobe-no-match"]').exists()).toBe(true);
    await wrapper.get('[data-testid="siteprobe-build-rule"]').trigger('click');
    expect(wrapper.emitted('build-rule')?.[0]).toEqual(['https://somewhere.test/x']);
  });

  it('lists the kinds that site declares, with each one explained, and none of the others', async () => {
    const { wrapper } = await mounted();
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/work/42');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);

    expect(wrapper.get('[data-testid="siteprobe-rule-found"]').text()).toContain('demo.test');
    expect(wrapper.find('[data-testid="siteprobe-kind-work"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="siteprobe-kind-search"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="siteprobe-kind-playlist"]').exists()).toBe(true);
    // A kind this site does not declare is not offered — the tool would refuse it.
    expect(wrapper.find('[data-testid="siteprobe-kind-album"]').exists()).toBe(false);
    // Each row says what it covers, rather than leaving the name to explain itself.
    expect(wrapper.get('[data-testid="siteprobe-kind-search"]').text().length)
      .toBeGreaterThan('Search'.length + 20);
    // One adapter file: which layer answers is not a question, so the row does not raise it.
    expect(wrapper.find('[data-testid="siteprobe-kind-source-work"]').exists()).toBe(false);
  });

  it('opens the folder a downloaded adapter goes into, and names it when it cannot', async () => {
    // T³ ships clean: an adapter that needs a sign-in is downloaded and dropped into a folder, so the
    // page that says "no rule exists yet" has to say where. The browser names a layer and never a
    // path — the server picks the folder from the tool's own home.
    const { wrapper, client } = await mounted();
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://somewhere.test/x');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);

    await wrapper.get('[data-testid="siteprobe-open-folder"]').trigger('click');
    await sleep(0);
    expect(client.revealSiteprobeFolder).toHaveBeenCalledWith('installed');
    expect(wrapper.find('[data-testid="siteprobe-folder-problem"]').exists()).toBe(false);

    // A machine with no file manager reports the path instead of asking for a bug report.
    const failing = await mounted({
      revealSiteprobeFolder: vi.fn(async () => {
        throw new Error('the file manager did not open: spawn explorer.exe ENOENT '
          + '(folder: C:\\data\\siteprobe\\installed)');
      }),
    });
    await failing.wrapper.get('[data-testid="siteprobe-address"]').setValue('https://somewhere.test/x');
    await failing.wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);
    await failing.wrapper.get('[data-testid="siteprobe-open-folder"]').trigger('click');
    await sleep(0);

    expect(failing.wrapper.get('[data-testid="siteprobe-folder-problem"]').text())
      .toContain('C:\\data\\siteprobe\\installed');
  });

  it('says which layer answers each kind when two adapter files carry the site', async () => {
    // Measured on a real home: a learned rule set and a written adapter for one key, where the menu
    // named the outer layer for every kind — including the kinds only the inner one could answer.
    const { wrapper } = await mounted();
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://two.test/work/42');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);

    expect(wrapper.get('[data-testid="siteprobe-kind-source-work"]').text())
      .toBe(messages.en['siteprobe.layer.installed']);
    expect(wrapper.get('[data-testid="siteprobe-kind-source-search"]').text())
      .toBe(messages.en['siteprobe.layer.local']);
  });

  it('asks again when the address is not the kind that was chosen', async () => {
    const { wrapper, client } = await mounted({
      siteprobeResolve: vi.fn(async (input: { input: string }) => (
        input.input.startsWith('https://demo.test/work')
          ? matched('work')
          : { event: 'resolve' as const, matched: false as const, input: input.input,
              reason: 'INVALID_INPUT' as const, detail: 'that is not a search address' })),
    });
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/work/42');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);

    await wrapper.get('[data-testid="siteprobe-kind-search"]').trigger('click');
    await wrapper.get('[data-testid="siteprobe-source"]').setValue('https://demo.test/work/42');
    await wrapper.get('[data-testid="siteprobe-run"]').trigger('click');
    await sleep(0);

    expect(wrapper.get('[data-testid="siteprobe-input-problem"]').text()).toContain('A search');
    expect(client.startSiteprobeRun).not.toHaveBeenCalled();
  });

  it('takes one work straight to the import review', async () => {
    const { wrapper, client } = await mounted({
      siteprobeResolve: vi.fn(async () => matched('work')),
      startSiteprobeRun: vi.fn(async () => runSnapshot({
        status: 'done', result: RESULT, events: [
          { event: 'progress', message: 'read 1 work document(s)' },
          { ...RESULT },
        ],
      })),
      getSiteprobeRun: vi.fn(async () => runSnapshot({
        status: 'done', result: RESULT, events: [{ ...RESULT }],
      })),
    });
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/work/42');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);
    await wrapper.get('[data-testid="siteprobe-run"]').trigger('click');
    await sleep(900);

    // One work: no review step was asked for, and the export went to the import screen.
    expect(client.startSiteprobeRun).toHaveBeenCalledWith(expect.objectContaining({
      site: 'demo.test', kind: 'work', review: false,
    }));
    expect(client.previewSiteProbeExportPath).toHaveBeenCalledWith(RESULT.export);
    expect(wrapper.emitted('preview')?.[0]?.[0]).toMatchObject({ source: 'path' });
  });

  it('scans first for a listing, then asks whether to filter it', async () => {
    const reviewResult = {
      ...RESULT, works: null, export: null, review_html: '/home/siteprobe/export/demo_test/search_x/review.html',
    };
    const { wrapper, client } = await mounted({
      siteprobeResolve: vi.fn(async () => matched('search')),
      startSiteprobeRun: vi.fn(async () => runSnapshot({
        kind: 'search', review: true, status: 'done', result: reviewResult,
        events: [
          {
            event: 'review', site: 'demo.test', kind: 'search', ref: 'x',
            listing: '/home/siteprobe/export/demo_test/search_x',
            review_html: reviewResult.review_html, summary: { cards: 218 }, count: 218, warnings: [],
          },
          { ...reviewResult },
        ],
      })),
      getSiteprobeRun: vi.fn(async () => runSnapshot({
        kind: 'search', review: true, status: 'done', result: reviewResult,
        events: [{ event: 'review', site: 'demo.test', kind: 'search', ref: 'x',
                   listing: '/home/siteprobe/export/demo_test/search_x',
                   review_html: reviewResult.review_html, summary: { cards: 218 }, count: 218,
                   warnings: [] }],
      })),
    });
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/search/photos?search_query=x');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);
    await wrapper.get('[data-testid="siteprobe-run"]').trigger('click');
    await sleep(900);

    expect(client.startSiteprobeRun).toHaveBeenCalledWith(expect.objectContaining({ review: true }));
    const ask = wrapper.get('[data-testid="siteprobe-ask-filter"]');
    expect(ask.text()).toContain('218');
    expect(wrapper.emitted('preview')).toBeUndefined();

    // "Import all of them" runs again without the review step, and that export is imported.
    await wrapper.get('[data-testid="siteprobe-import-all"]').trigger('click');
    await sleep(0);
    expect(client.startSiteprobeRun).toHaveBeenLastCalledWith(expect.objectContaining({ review: false }));
  });

  it('opens the picker page over http, then downloads only what the selection names', async () => {
    const reviewResult = {
      ...RESULT, works: null, export: null,
      review_html: '/home/siteprobe/export/demo_test/search_x/review.html',
    };
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    let polls = 0;
    const { wrapper, client } = await mounted({
      siteprobeResolve: vi.fn(async () => matched('search')),
      startSiteprobeRun: vi.fn(async () => runSnapshot({ kind: 'search', review: true })),
      getSiteprobeRun: vi.fn(async () => {
        polls += 1;
        if (polls === 1) {
          return runSnapshot({
            kind: 'search', review: true, status: 'done', result: reviewResult,
            events: [{ event: 'review', site: 'demo.test', kind: 'search', ref: 'x',
                       listing: '/home/siteprobe/export/demo_test/search_x',
                       review_html: reviewResult.review_html, summary: {}, warnings: [] }],
          });
        }
        // The page saved a selection beside itself; the panel picks it up.
        return runSnapshot({
          kind: 'search', review: true, status: 'done', result: reviewResult,
          selection: '/home/siteprobe/export/demo_test/search_x/selection_x.json',
          events: [],
        });
      }),
    });
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/search/photos?search_query=x');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);
    await wrapper.get('[data-testid="siteprobe-run"]').trigger('click');
    await sleep(900);

    await wrapper.get('[data-testid="siteprobe-filter"]').trigger('click');
    expect(openSpy).toHaveBeenCalled();
    expect(String(openSpy.mock.calls[0]?.[0])).toContain('/api/siteprobe/export-file?path=');
    await sleep(4000);

    // The selection is a run of its own: the tool reads the chosen works and nothing else.
    expect(client.startSiteprobeRun).toHaveBeenLastCalledWith({
      selection: '/home/siteprobe/export/demo_test/search_x/selection_x.json',
    });
    openSpy.mockRestore();
    // The waits above are deliberate sleeps (900 + 4000 ms) for a watch that polls. Measured at
    // 4.94–5.03 s — the default 5 s budget to within a hair, and a full parallel run crosses it,
    // which failed this test once for no reason in the code. It gets its own budget.
  }, 15_000);

  it('offers the sign-in door for a playlist that needs one', async () => {
    const { wrapper, client } = await mounted({
      siteprobeResolve: vi.fn(async () => matched('favorite')),
      startSiteprobeRun: vi.fn(async () => runSnapshot({ command: 'login', status: 'done' })),
    });
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/user/x/favorite/albums?folder=7');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);
    await wrapper.get('[data-testid="siteprobe-kind-playlist"]').trigger('click');
    expect(wrapper.find('[data-testid="siteprobe-login"]').exists()).toBe(false);

    await wrapper.get('[data-testid="siteprobe-playlist-login"]').setValue(true);
    await wrapper.get('[data-testid="siteprobe-login"]').trigger('click');
    await sleep(0);

    // The login door is a job like any other; the panel does not pretend to know a password.
    expect(client.startSiteprobeRun).toHaveBeenCalledWith({
      login: 'https://demo.test/user/x/favorite/albums?folder=7',
    });
  });

  it('says "I have signed in" from the page, and then the run continues', async () => {
    let loginAnswered = false;
    const calls: unknown[] = [];
    const { wrapper, client } = await mounted({
      siteprobeResolve: vi.fn(async () => matched('favorite')),
      startSiteprobeRun: vi.fn(async (request: Record<string, unknown>) => {
        calls.push(request);
        return 'login' in request
          ? runSnapshot({ command: 'login', status: 'running' })
          : runSnapshot({ kind: 'favorite', review: true });
      }),
      getSiteprobeRun: vi.fn(async () => runSnapshot({
        command: 'login', status: loginAnswered ? 'done' : 'running',
      })),
      siteprobeLoginDone: vi.fn(async (runId: string) => {
        loginAnswered = true;
        return runSnapshot({ id: runId, command: 'login', status: 'running' });
      }),
    });
    await wrapper.get('[data-testid="siteprobe-address"]')
      .setValue('https://demo.test/user/x/favorite/albums?folder=7');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);
    await wrapper.get('[data-testid="siteprobe-kind-playlist"]').trigger('click');
    await wrapper.get('[data-testid="siteprobe-playlist-login"]').setValue(true);
    await wrapper.get('[data-testid="siteprobe-login"]').trigger('click');
    await sleep(900);

    // Signing in happens in the browser; the answer happens here, on the page the person is on —
    // their words after the first real sign-in, which asked them to find a console window.
    await wrapper.get('[data-testid="siteprobe-login-done"]').trigger('click');
    await sleep(1200);

    expect(client.siteprobeLoginDone).toHaveBeenCalledWith('run-1');
    expect(calls[0]).toMatchObject({
      login: 'https://demo.test/user/x/favorite/albums?folder=7',
    });
    expect(calls[1]).toMatchObject({ site: 'demo.test', kind: 'favorite', review: true });
  });

  it('continues into the run once the sign-in door closes', async () => {
    const calls: unknown[] = [];
    const { wrapper, client } = await mounted({
      siteprobeResolve: vi.fn(async () => matched('favorite')),
      startSiteprobeRun: vi.fn(async (request: Record<string, unknown>) => {
        calls.push(request);
        return 'login' in request
          ? runSnapshot({ command: 'login', status: 'done' })
          : runSnapshot({ kind: 'favorite', review: true });
      }),
      getSiteprobeRun: vi.fn(async () => runSnapshot({ command: 'login', status: 'done' })),
    });
    await wrapper.get('[data-testid="siteprobe-address"]')
      .setValue('https://demo.test/user/x/favorite/albums?folder=7');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);
    await wrapper.get('[data-testid="siteprobe-kind-playlist"]').trigger('click');
    await wrapper.get('[data-testid="siteprobe-playlist-login"]').setValue(true);
    await wrapper.get('[data-testid="siteprobe-login"]').trigger('click');
    await sleep(900);

    // The door opened and closed: the person signed in, so what they were setting up is the run —
    // the specification's "when the bat finishes, come back to the import part".
    expect(calls[0]).toMatchObject({
      login: 'https://demo.test/user/x/favorite/albums?folder=7',
    });
    expect(calls[1]).toMatchObject({ site: 'demo.test', kind: 'favorite', review: true });
    expect(client.startSiteprobeRun).toHaveBeenCalledTimes(2);
  });

  it('shows the adapter readme only for a site that has one', async () => {
    const { wrapper, client } = await mounted();
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/work/42');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);
    expect(wrapper.find('[data-testid="siteprobe-readme-toggle"]').exists()).toBe(true);

    await wrapper.get('[data-testid="siteprobe-readme-toggle"]').trigger('click');
    await sleep(0);
    expect(client.siteprobeReadme).toHaveBeenCalledWith('demo.test');
    expect(wrapper.get('[data-testid="siteprobe-readme"]').text()).toContain('What it covers');

    // A site whose folder has no readme shows no badge to open.
    const plain = await mounted();
    await plain.wrapper.get('[data-testid="siteprobe-address"]').setValue('https://plain.test/work/1');
    await plain.wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);
    expect(plain.wrapper.find('[data-testid="siteprobe-readme-toggle"]').exists()).toBe(false);
  });

  it('takes a selection the browser downloaded, for a review page that saves one that way', async () => {
    const reviewResult = {
      ...RESULT, works: null, export: null,
      review_html: '/home/siteprobe/export/demo_test/search_x/review.html',
    };
    const { wrapper, client } = await mounted({
      siteprobeResolve: vi.fn(async () => matched('search')),
      startSiteprobeRun: vi.fn(async () => runSnapshot({ kind: 'search', review: true })),
      getSiteprobeRun: vi.fn(async () => runSnapshot({
        kind: 'search', review: true, status: 'done', result: reviewResult,
        events: [{ event: 'review', site: 'demo.test', kind: 'search', ref: 'x',
                   listing: '/home/siteprobe/export/demo_test/search_x',
                   review_html: reviewResult.review_html, summary: {}, warnings: [] }],
      })),
    });
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/search/photos?search_query=x');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);
    await wrapper.get('[data-testid="siteprobe-run"]').trigger('click');
    await sleep(900);

    // The person chose to filter, which opens the picker page and starts the wait.
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    await wrapper.get('[data-testid="siteprobe-filter"]').trigger('click');
    await sleep(0);
    expect(client.siteprobeExportFileUrl).toHaveBeenCalledWith(
      reviewResult.review_html, 'run-1');
    openSpy.mockRestore();

    // While it waits, the file itself can be handed over: hitomi's page saves by downloading, and the
    // watch beside the page would otherwise never see it.
    const picker = wrapper.get('[data-testid="siteprobe-selection-file"]');
    const file = new File([JSON.stringify({ selected_source_ids: ['42'] })],
                          'selection_kakao.json', { type: 'application/json' });
    Object.defineProperty(picker.element, 'files', { value: [file], configurable: true });
    await picker.trigger('change');
    await sleep(0);

    expect(client.uploadSiteprobeSelection).toHaveBeenCalledWith(
      'run-1', expect.objectContaining({ name: 'selection_kakao.json' }));
    expect(wrapper.get('[data-testid="siteprobe-selection-taken"]').text())
      .toContain('selection_kakao.json');
  });

  it('asks for a bug report only when the tool crashed, not when a crawl has a verdict', async () => {
    const refused = await mounted({
      siteprobeResolve: vi.fn(async () => matched('work')),
      startSiteprobeRun: vi.fn(async () => runSnapshot({
        status: 'failed', error: { code: 'RUN_FAILED', message: 'the site refused' },
      })),
      getSiteprobeRun: vi.fn(async () => runSnapshot({
        status: 'failed', error: { code: 'RUN_FAILED', message: 'the site refused' },
      })),
    });
    await refused.wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/work/1');
    await refused.wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);
    await refused.wrapper.get('[data-testid="siteprobe-run"]').trigger('click');
    await sleep(900);

    // A verdict from the tool: the person reads it and decides. Nothing to report.
    const verdict = refused.wrapper.get('[data-testid="siteprobe-error"]');
    expect(verdict.text()).toContain('the site refused');
    expect(verdict.text()).not.toContain('report');
    expect(refused.wrapper.find('[data-testid="siteprobe-copy-diagnostics"]').exists()).toBe(false);

    const crashed = await mounted({
      siteprobeResolve: vi.fn(async () => matched('work')),
      startSiteprobeRun: vi.fn(async () => runSnapshot({
        status: 'failed',
        error: { code: 'INTERNAL', message: 'SSLError: closed', logPath: '/data/logs/siteprobe-run-1.log' },
      })),
      getSiteprobeRun: vi.fn(async () => runSnapshot({
        status: 'failed',
        error: { code: 'INTERNAL', message: 'SSLError: closed', logPath: '/data/logs/siteprobe-run-1.log' },
      })),
    });
    await crashed.wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/work/1');
    await crashed.wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await sleep(0);
    await crashed.wrapper.get('[data-testid="siteprobe-run"]').trigger('click');
    await sleep(900);

    // A crash: the log is named, the report is asked for, and the details can be copied.
    const crash = crashed.wrapper.get('[data-testid="siteprobe-error"]');
    expect(crash.text()).toContain('report');
    expect(crash.text()).toContain('/data/logs/siteprobe-run-1.log');
    expect(crashed.wrapper.find('[data-testid="siteprobe-copy-diagnostics"]').exists()).toBe(true);
  });

  it('says so when there is no tool to fetch with', async () => {
    const { wrapper } = await mounted({
      siteprobeSites: vi.fn(async () => {
        throw new Error('the tool is not built');
      }),
    });
    await sleep(0);

    expect(wrapper.get('[data-testid="siteprobe-unavailable"]').text()).toContain('not built');
  });
});
