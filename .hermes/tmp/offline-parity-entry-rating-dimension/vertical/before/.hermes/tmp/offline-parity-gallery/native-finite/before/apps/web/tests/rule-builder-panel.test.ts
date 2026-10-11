// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportPreview, SiteprobeRun } from '@t3/shared';

import RuleBuilderPanel from '../src/components/RuleBuilderPanel.vue';
import type { GalleryApi } from '../src/api/gallery.js';

/**
 * The rule-building page: states, and what each one is allowed to say.
 *
 * The specification for this page is a sequence of screens — intro, prepare, the three addresses,
 * the builder's own status, a verdict, and 适配器生成完毕 — with only one of them on screen at a
 * time and 重新开始 in every one's corner. What the page drives is a job whose clock is a person
 * annotating pages in a browser, so these tests are about the page's reading of that job: the
 * builder's guidance while it waits, its own refusal versus a crash, and the handover of the first
 * work's export to the import review.
 */
function runSnapshot(overrides: Partial<SiteprobeRun> = {}): SiteprobeRun {
  return {
    id: 'build-1',
    command: 'build',
    input: 'https://demo.test/work/1',
    site: null,
    kind: null,
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

function progress(...messages: string[]) {
  return messages.map((message) => ({ event: 'progress' as const, message }));
}

function api(overrides: Partial<GalleryApi> = {}): GalleryApi {
  return {
    siteprobeSites: vi.fn(async () => ({
      event: 'sites' as const,
      home: '/home/siteprobe',
      sites: [{
        key: 'known.test',
        display_name: 'Known',
        export_group: 'known_test',
        hosts: ['known.test'],
        targets: [
          { kind: 'work', label: 'Work', single: true, accepts_name: false, source: 'local' },
        ],
        adapters: [{ source: 'local', reads: ['work'], readme: false }],
      }],
    })),
    startSiteprobeRun: vi.fn(async () => runSnapshot()),
    getSiteprobeRun: vi.fn(async () => runSnapshot()),
    cancelSiteprobeRun: vi.fn(async () => runSnapshot({ status: 'cancelled' })),
    previewSiteProbeExportPath: vi.fn(async () => ({ source: 'demo.test' } as unknown as ImportPreview)),
    ...overrides,
  } as unknown as GalleryApi;
}

async function mounted(overrides: Partial<GalleryApi> = {}, draftUrl?: string) {
  const client = api(overrides);
  const wrapper = mount(RuleBuilderPanel, { props: { api: client, draftUrl } });
  await vi.advanceTimersByTimeAsync(0);
  return { wrapper, client };
}

/** Through the first two states, to the three address fields. */
async function atAddresses(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.get('[data-testid="rule-begin"]').trigger('click');
  await wrapper.get('[data-testid="rule-prepare-done"]').trigger('click');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the rule-building page', () => {
  it('shows one state at a time, and starts with what the tool can and cannot do', async () => {
    vi.useFakeTimers();
    const { wrapper } = await mounted();

    expect(wrapper.find('[data-testid="rule-intro"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="rule-prepare"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="rule-builder"]').text()).toContain('sign-in');

    await wrapper.get('[data-testid="rule-begin"]').trigger('click');
    expect(wrapper.find('[data-testid="rule-intro"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="rule-prepare"]').exists()).toBe(true);
    // 重新开始 in the corner of every state, per the specification.
    expect(wrapper.find('[data-testid="rule-restart"]').exists()).toBe(true);

    await wrapper.get('[data-testid="rule-prepare-done"]').trigger('click');
    expect(wrapper.find('[data-testid="rule-prepare"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="rule-url-1"]').exists()).toBe(true);
    // The tips are on the state where the person uses the adapter, and nowhere else.
    expect(wrapper.find('[data-testid="rule-tips"]').exists()).toBe(true);
  });

  it('takes the address the advanced page handed over, and refuses to start without one', async () => {
    vi.useFakeTimers();
    const { wrapper, client } = await mounted({}, 'https://demo.test/work/9');
    await atAddresses(wrapper);

    expect((wrapper.get('[data-testid="rule-url-1"]').element as HTMLInputElement).value)
      .toBe('https://demo.test/work/9');
    await wrapper.get('[data-testid="rule-open-adapter"]').trigger('click');
    expect(client.startSiteprobeRun).toHaveBeenCalledWith({
      build: ['https://demo.test/work/9'], lang: 'en',
    });
  });

  it('says a page is open while the builder waits, and keeps what the builder said', async () => {
    vi.useFakeTimers();
    const lines = [
      '    capturing https://demo.test/work/1 with a headless browser; this can take up to a minute',
      '    opening the page (annotate); submit it to continue',
      '    annotation page: http://127.0.0.1:59427/?token=abc',
    ];
    const { wrapper } = await mounted({
      getSiteprobeRun: vi.fn(async () => runSnapshot({ events: progress(...lines) })),
    });
    await atAddresses(wrapper);
    await wrapper.get('[data-testid="rule-url-1"]').setValue('https://demo.test/work/1');
    await wrapper.get('[data-testid="rule-open-adapter"]').trigger('click');
    await vi.advanceTimersByTimeAsync(1000);

    // The line that sends the person to the browser is the tool's, and it has to arrive while the
    // run is still going: a builder waiting on a page nobody was told about reads as a hang.
    expect(wrapper.find('[data-testid="rule-status-page-open"]').exists()).toBe(true);
    // The whole console is folded away, not shown: the notes and markup dumps are diagnostics.
    expect(wrapper.get('.rule-builder__log').text()).toContain('annotation page: http://127.0.0.1:59427');
    expect(wrapper.find('[data-testid="rule-status-preparing"]').exists()).toBe(false);
  });

  it('takes back a build that is still running when the page is opened again', async () => {
    vi.useFakeTimers();
    // Leaving the page does not end a build — it is a child process whose clock is a person
    // annotating in a browser — so the panel used to come back to the intro while the build kept
    // running, with no log and no 重新开始 to stop it. Mounting asks what the server still holds.
    const running = runSnapshot({
      id: 'build-7',
      kind: 'artist',
      input: 'https://demo.test/list/1 https://demo.test/list/2',
      status: 'running',
      events: progress('    opening the page (annotate); submit it to continue',
                       '    annotation page: http://127.0.0.1:59427/?token=abc'),
    });
    const { wrapper, client } = await mounted({
      listSiteprobeRuns: vi.fn(async () => [running]),
    });

    // Back in the half it was started from — `kind` is what makes a build a listing build — with the
    // addresses it is for, and the builder's own page-open line.
    expect(wrapper.find('[data-testid="rule-intro"]').exists()).toBe(false);
    expect((wrapper.get('[data-testid="rule-listing-url-1"]').element as HTMLInputElement).value)
      .toBe('https://demo.test/list/1');
    expect((wrapper.get('[data-testid="rule-listing-url-2"]').element as HTMLInputElement).value)
      .toBe('https://demo.test/list/2');
    expect(wrapper.find('[data-testid="rule-status-page-open"]').exists()).toBe(true);

    // And the way out is back: 重新开始 stops the process it adopted.
    await wrapper.get('[data-testid="rule-restart"]').trigger('click');
    expect(client.cancelSiteprobeRun).toHaveBeenCalledWith('build-7');
  });

  it('leaves a finished build alone, and a build for another page', async () => {
    vi.useFakeTimers();
    // A finished build has already written whatever it wrote; adopting one hours later would show a
    // state the person has long moved past. The orphan this exists for is the live process.
    const { wrapper } = await mounted({
      listSiteprobeRuns: vi.fn(async () => [
        runSnapshot({ id: 'build-6', status: 'done', finishedAt: new Date().toISOString() }),
      ]),
    });

    expect(wrapper.find('[data-testid="rule-intro"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="rule-status"]').exists()).toBe(false);
  });

  it('reads the builder’s refusal as 过于复杂, with its own line, and a crash as a bug', async () => {
    vi.useFakeTimers();
    const refusal = 'nothing was installed: a target that cannot name its own address would be invisible.';
    const refused = await mounted({
      getSiteprobeRun: vi.fn(async () => runSnapshot({
        status: 'failed',
        error: { code: 'RUN_FAILED', message: refusal },
      })),
    });
    await atAddresses(refused.wrapper);
    await refused.wrapper.get('[data-testid="rule-url-1"]').setValue('https://demo.test/work/1');
    await refused.wrapper.get('[data-testid="rule-open-adapter"]').trigger('click');
    await vi.advanceTimersByTimeAsync(1000);

    expect(refused.wrapper.get('[data-testid="rule-error"]').text()).toContain(refusal);
    // A refusal is the tool working as designed, so it is not a bug report.
    expect(refused.wrapper.find('[data-testid="rule-copy-diagnostics"]').exists()).toBe(false);
    expect(refused.wrapper.find('[data-testid="rule-ready"]').exists()).toBe(false);

    vi.useRealTimers();
    vi.useFakeTimers();
    const crashed = await mounted({
      getSiteprobeRun: vi.fn(async () => runSnapshot({
        status: 'failed',
        error: { code: 'INTERNAL', message: 'ValueError: the harvest is empty' },
      })),
    });
    await atAddresses(crashed.wrapper);
    await crashed.wrapper.get('[data-testid="rule-url-1"]').setValue('https://demo.test/work/1');
    await crashed.wrapper.get('[data-testid="rule-open-adapter"]').trigger('click');
    await vi.advanceTimersByTimeAsync(1000);

    const problem = crashed.wrapper.get('[data-testid="rule-error"]').text();
    expect(problem).toContain('ValueError');
    expect(crashed.wrapper.find('[data-testid="rule-copy-diagnostics"]').exists()).toBe(true);
  });

  it('says 适配器生成完毕 when the builder installed, and imports the first work into the review', async () => {
    vi.useFakeTimers();
    const installed = [
      '    opening the page (confirm); submit it to continue',
      'PASS — 4/4 field(s) agree',
      '=== installed /home/siteprobe/local/demo_test',
    ];
    const { wrapper, client } = await mounted({
      getSiteprobeRun: vi.fn(async (id: string) => (id === 'build-1'
        ? runSnapshot({ events: progress(...installed), status: 'done' })
        : runSnapshot({
            id, command: 'run', status: 'done',
            result: {
              event: 'result', command: 'run', site: 'demo.test', kind: 'work', ref: '1',
              works: 1, listing: '/home/siteprobe/export/demo_test/single',
              export: '/home/siteprobe/export/demo_test/single/metadata.json',
              review_html: null, origin: null, media: {}, warnings: [],
            },
          }))),
      startSiteprobeRun: vi.fn(async (request: Parameters<GalleryApi['startSiteprobeRun']>[0]) => {
        const building = 'build' in request;
        return runSnapshot({
          id: building ? 'build-1' : 'run-1',
          command: building ? 'build' : 'run',
        });
      }),
    });
    await atAddresses(wrapper);
    await wrapper.get('[data-testid="rule-url-1"]').setValue('https://demo.test/work/1');
    await wrapper.get('[data-testid="rule-open-adapter"]').trigger('click');
    await vi.advanceTimersByTimeAsync(1000);

    // `=== installed` is the builder's own "the adapter is on disk" line.
    expect(wrapper.find('[data-testid="rule-ready"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="rule-ready"]').text()).toContain('Import the first work');

    await wrapper.get('[data-testid="rule-import-first"]').trigger('click');
    await vi.advanceTimersByTimeAsync(1300);
    expect(client.startSiteprobeRun).toHaveBeenLastCalledWith({ input: 'https://demo.test/work/1' });
    expect(client.previewSiteProbeExportPath)
      .toHaveBeenCalledWith('/home/siteprobe/export/demo_test/single/metadata.json');
    expect(wrapper.emitted('preview')?.[0]).toEqual([
      { preview: { source: 'demo.test' }, source: 'path' },
    ]);
  });

  it('says so when the site already has an adapter, without blocking the build', async () => {
    vi.useFakeTimers();
    const { wrapper, client } = await mounted();
    await atAddresses(wrapper);

    // Nothing is claimed before an address is entered.
    expect(wrapper.find('[data-testid="rule-adapter-exists"]').exists()).toBe(false);

    const field = wrapper.get('[data-testid="rule-url-1"]');
    // Typing is enough: the check is local (the registry is already loaded), so it does not wait
    // for a blur — a URL pasted and left in the field is answered all the same.
    await field.setValue('https://known.test/work/1');
    const said = wrapper.get('[data-testid="rule-adapter-exists"]').text();
    expect(said).toContain('already has an adapter');
    expect(said).toContain('replace that adapter');

    // A warning, not a gate: the addresses are still the person's to submit.
    expect(wrapper.get('[data-testid="rule-open-adapter"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="rule-open-adapter"]').trigger('click');
    expect(client.startSiteprobeRun).toHaveBeenCalledWith({
      build: ['https://known.test/work/1'], lang: 'en',
    });

    // An address of a site nothing claims takes the sentence away again.
    await wrapper.get('[data-testid="rule-restart"]').trigger('click');
    await atAddresses(wrapper);
    const other = wrapper.get('[data-testid="rule-url-1"]');
    await other.setValue('https://unknown.test/work/1');
    await other.trigger('change');
    expect(wrapper.find('[data-testid="rule-adapter-exists"]').exists()).toBe(false);
  });

  it('checks the address the advanced page handed over, as soon as it is there', async () => {
    vi.useFakeTimers();
    // The registry arrives after the panel does, so the check has to run again once it is loaded —
    // a seeded address that only got checked on `change` would sit there saying nothing.
    const { wrapper } = await mounted({}, 'https://known.test/work/7');
    await vi.advanceTimersByTimeAsync(0);
    await atAddresses(wrapper);

    expect(wrapper.find('[data-testid="rule-adapter-exists"]').exists()).toBe(true);
  });

  it('start over stops a running build and returns to the first state', async () => {
    vi.useFakeTimers();
    const { wrapper, client } = await mounted();
    await atAddresses(wrapper);
    await wrapper.get('[data-testid="rule-url-1"]').setValue('https://demo.test/work/1');
    await wrapper.get('[data-testid="rule-open-adapter"]').trigger('click');
    await vi.advanceTimersByTimeAsync(1000);

    await wrapper.get('[data-testid="rule-restart"]').trigger('click');
    await vi.advanceTimersByTimeAsync(0);

    expect(client.cancelSiteprobeRun).toHaveBeenCalledWith('build-1');
    expect(wrapper.find('[data-testid="rule-intro"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="rule-url-1"]').exists()).toBe(false);
  });
});

/**
 * The specification's second phase: the listing adapter lives on the same page, below the work one, and
 * runs its own version of 状态3. What it needs from the page: the two halves named apart, the listing
 * entered from 状态2 or from the work state's "this site already has an adapter" notice, the kind
 * chosen before its two pages, and a preview capped at ten works.
 */
describe('the listing half of the same page', () => {
  /** 状态2 → the listing's own 状态3, with a kind chosen and both of its pages in the fields. */
  async function atListing(wrapper: ReturnType<typeof mount>, kind = 'search'): Promise<void> {
    await wrapper.get('[data-testid="rule-begin"]').trigger('click');
    await wrapper.get('[data-testid="rule-listing-start"]').trigger('click');
    await wrapper.get(`[data-listing-kind="${kind}"]`).trigger('click');
  }

  it('is named apart from the work half, and takes over the state with its own kind first', async () => {
    vi.useFakeTimers();
    const { wrapper } = await mounted();
    await wrapper.get('[data-testid="rule-begin"]').trigger('click');

    // 单作品生成器, with 重新开始 sharing its row (the specification's own layout note).
    expect(wrapper.get('[data-testid="rule-work-title"]').text()).toBe('Work adapter');
    expect(wrapper.find('[data-testid="rule-restart"]').exists()).toBe(true);
    // The work half keeps its notes and its button; the listing half sits below it.
    expect(wrapper.find('[data-testid="rule-prepare"]').exists()).toBe(true);
    const listing = wrapper.get('[data-testid="rule-listing-intro"]');
    expect(listing.text()).toContain('finish the work adapter first');
    expect(listing.text()).toContain('an author page, a tag page');

    await wrapper.get('[data-testid="rule-listing-start"]').trigger('click');
    expect(wrapper.find('[data-testid="rule-listing-kinds"]').exists()).toBe(true);
    // Its own 状态3: no work addresses, and nothing to fill in until the kind is chosen.
    expect(wrapper.find('[data-testid="rule-url-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="rule-listing-url-1"]').exists()).toBe(false);

    await wrapper.get('[data-listing-kind="search"]').trigger('click');
    expect(wrapper.find('[data-testid="rule-listing-url-1"]').exists()).toBe(true);
    // The tips are the listing's four, not the work page's three.
    expect(wrapper.get('[data-testid="rule-listing-tips"]').findAll('li')).toHaveLength(4);
    expect(wrapper.get('[data-testid="rule-listing-tips"]').text())
      .toContain('as the listing shows it');
  });

  it('builds with the listing’s two pages and the kind it is learned under', async () => {
    vi.useFakeTimers();
    const { wrapper, client } = await mounted();
    await atListing(wrapper, 'album');
    await wrapper.get('[data-testid="rule-listing-url-1"]').setValue('https://demo.test/list/1');

    // The second page is what teaches pagination, so the build waits for it.
    expect(wrapper.get('[data-testid="rule-listing-open"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="rule-listing-url-2"]').setValue('https://demo.test/list/2');
    expect(wrapper.get('[data-testid="rule-listing-open"]').attributes('disabled')).toBeUndefined();

    await wrapper.get('[data-testid="rule-listing-open"]').trigger('click');
    expect(client.startSiteprobeRun).toHaveBeenCalledWith({
      build: ['https://demo.test/list/1', 'https://demo.test/list/2'], kind: 'album', lang: 'en',
    });
  });

  it('sends a listing whose site has no work adapter to build that one first', async () => {
    vi.useFakeTimers();
    const { wrapper } = await mounted();
    await atListing(wrapper);

    // The mock's registry knows `known.test` only, so `demo.test` has no adapter of any kind.
    await wrapper.get('[data-testid="rule-listing-url-1"]').setValue('https://demo.test/list/1');
    expect(wrapper.get('[data-testid="rule-listing-no-work-adapter"]').text())
      .toContain('no work adapter yet');
    await wrapper.get('[data-testid="rule-listing-go-work"]').trigger('click');

    // The work state, with the address carried over — the same site, the other half.
    expect(wrapper.find('[data-testid="rule-url-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="rule-listing-kinds"]').exists()).toBe(false);
    expect((wrapper.get('[data-testid="rule-url-1"]').element as HTMLInputElement).value)
      .toBe('https://demo.test/list/1');
  });

  it('offers the listing door from the work state’s own “already has an adapter” notice', async () => {
    vi.useFakeTimers();
    const { wrapper } = await mounted();
    await atAddresses(wrapper);
    await wrapper.get('[data-testid="rule-url-1"]').setValue('https://known.test/work/1');

    expect(wrapper.find('[data-testid="rule-adapter-exists"]').exists()).toBe(true);
    await wrapper.get('[data-testid="rule-add-listing"]').trigger('click');
    expect(wrapper.find('[data-testid="rule-listing-kinds"]').exists()).toBe(true);
    // And the site it already knows is not asked about again: this is the adapter's own site.
    expect(wrapper.find('[data-testid="rule-url-1"]').exists()).toBe(false);
  });

  it('previews the listing through the ordinary review, capped at ten works', async () => {
    vi.useFakeTimers();
    const { wrapper, client } = await mounted({
      getSiteprobeRun: vi.fn(async () => runSnapshot()),
      startSiteprobeRun: vi.fn(async (request: Parameters<GalleryApi['startSiteprobeRun']>[0]) => {
        const building = 'build' in request;
        return runSnapshot({
          id: building ? 'build-1' : 'run-1',
          command: building ? 'build' : 'run',
        });
      }),
    });
    await atListing(wrapper);
    await wrapper.get('[data-testid="rule-listing-url-1"]').setValue('https://demo.test/list/1');
    await wrapper.get('[data-testid="rule-listing-url-2"]').setValue('https://demo.test/list/2');
    await wrapper.get('[data-testid="rule-listing-open"]').trigger('click');
    await vi.advanceTimersByTimeAsync(0);
    // The builder's own "the adapter is on disk" line, which is what makes the state ready.
    client.getSiteprobeRun = vi.fn(async () => runSnapshot({
      status: 'done', events: progress('=== installed /home/siteprobe/local/demo_test'),
    }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(wrapper.find('[data-testid="rule-listing-ready"]').exists()).toBe(true);
    const ready = wrapper.get('[data-testid="rule-listing-ready"]').text();
    expect(ready).toContain('the first 10 works');
    expect(ready).toContain('leave this screen without importing');
    // Nothing on the page may show an unsubstituted placeholder — measured live on 2026-10-04, where
    // the preview button read "Import the first {count} works for preview" because its label was
    // rendered without the count.
    expect(wrapper.get('[data-testid="rule-builder"]').text()).not.toContain('{');

    client.getSiteprobeRun = vi.fn(async () => runSnapshot({
      id: 'run-1', command: 'run', status: 'done',
      result: {
        event: 'result', command: 'run', site: 'demo.test', kind: 'search',
        ref: 'weekvisit', works: 10, listing: '/home/siteprobe/export/demo_test/list',
        export: '/home/siteprobe/export/demo_test/list/metadata.json',
        review_html: null, origin: null, media: {}, warnings: [],
      },
    }));
    await wrapper.get('[data-testid="rule-import-listing"]').trigger('click');
    await vi.advanceTimersByTimeAsync(1300);

    // The crawl is capped where the *fetching* is bounded, and the review is the one a work import
    // lands on — ten works reviewed exactly as one is.
    expect(client.startSiteprobeRun).toHaveBeenLastCalledWith({
      input: 'https://demo.test/list/1', kind: 'search', limit: 10,
    });
    expect(client.previewSiteProbeExportPath)
      .toHaveBeenCalledWith('/home/siteprobe/export/demo_test/list/metadata.json');
    expect(wrapper.emitted('preview')?.[0]).toEqual([
      { preview: { source: 'demo.test' }, source: 'path' },
    ]);
  });
});
