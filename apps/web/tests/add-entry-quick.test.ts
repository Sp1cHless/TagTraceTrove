// @vitest-environment jsdom
import { mount } from '@vue/test-utils';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SiteprobeLinkMeta, SiteprobeResolveEvent, SiteprobeRun } from '@t3/shared';

import AddEntryPage from '../src/AddEntryPage.vue';
import { setLocale } from '../src/i18n.js';
import { showNsfw } from '../src/stores/preferences.js';
import type { GalleryApi } from '../src/api/gallery.js';

/**
 * The quick page: the form the phone uses, and the one-link fetch that fills it in.
 *
 * These are the requirements the page was rewritten for, so they are pinned here rather than left
 * to the app-level suite: the four pages, the cover-and-previews area with the work card's own
 * stack, the fetch's three outcomes (filled, needs the advanced path, a bug), and the fact that a
 * fetch is not offered offline. The fetch itself is stubbed — what is under test is what this page
 * does with each verdict.
 */

/**
 * The fetched cover's bytes come from the server's guarded media route, so a test that exercises the
 * found path answers that one request. A blob with a jpeg type is what the route returns.
 */
// Nothing is fetched for the cover any more: its bytes arrive in the answer as a data URL, and the
// page decodes them. (Before this, a test here had to stub `fetch` because the page had to go and
// read a file the tool had written.)

/** jsdom does not implement object URLs; the page makes one per chosen image. */
const objectUrls = { create: vi.fn((file: File) => `blob:${file.name}`), revoke: vi.fn() };
afterEach(() => {
  objectUrls.create.mockClear();
  objectUrls.revoke.mockClear();
});
Object.assign(URL, { createObjectURL: objectUrls.create, revokeObjectURL: objectUrls.revoke });

/** The run snapshot a completed work crawl answers with. */
function runFor(site: string): SiteprobeRun {
  return {
    id: 'run-1', command: 'run', input: 'x', site, kind: 'work',
    review: false, status: 'done', events: [], eventsDropped: 0,
    result: {
      event: 'result', command: 'run', site, kind: 'work',
      ref: '1', works: 1, listing: `/export/${site}/single`,
      export: `/export/${site}/single/metadata.json`, review_html: null, origin: null,
      media: {}, warnings: [],
    },
    error: null, selection: null, startedAt: new Date().toISOString(), finishedAt: null,
  };
}

function image(name: string): File {
  return new File(['x'], name, { type: 'image/jpeg' });
}

function api(overrides: Partial<GalleryApi> = {}): GalleryApi {
  return {
    fetchSiteProbeLinkMeta: vi.fn(async (): Promise<SiteprobeLinkMeta> => ({
      verdict: 'needs-advanced', outcome: 'no-title', detail: 'no title', title: null,
      coverDataUrl: null, coverMimeType: null, coverBytes: null, logPath: null,
    })),
    listLayout: vi.fn(async () => []),
    ...overrides,
  } as unknown as GalleryApi;
}

async function mounted(
  overrides: Partial<GalleryApi> = {},
  offline = false,
  galleries: Array<{ type: string; nsfw: boolean }> = [
    { type: 'game', nsfw: false },
    { type: 'comic', nsfw: false },
    { type: 'hentai', nsfw: true },
  ],
) {
  const client = api(overrides);
  const wrapper = mount(AddEntryPage, {
    props: {
      api: client,
      galleryTypes: ['game'],
      galleries,
      authors: [],
      submitting: false,
      offlineState: { mode: offline ? 'offline' : 'online' },
    },
  });
  await flushPromises();
  return { wrapper, client };
}

async function dropImages(wrapper: Awaited<ReturnType<typeof mounted>>['wrapper'],
                          target: 'cover' | 'preview', files: File[]): Promise<void> {
  const selector = target === 'cover'
    ? '[data-testid="entry-cover-dropzone"]'
    : '[data-testid="entry-preview-dropzone"]';
  await wrapper.get(selector).trigger('drop', { dataTransfer: { files } });
  await flushPromises();
}

describe('the two handovers the advanced page makes', () => {
  const SITES = {
    event: 'sites' as const,
    home: '/home/siteprobe',
    sites: [{
      key: 'demo.test', display_name: 'Demo', export_group: 'demo_test', hosts: ['demo.test'],
      targets: [
        { kind: 'work', label: 'Work', single: true, accepts_name: false, source: 'installed' },
      ],
      adapters: [{ source: 'installed', reads: ['work'], readme: false }],
    }],
  };

  it('carries an address with no rule to the rule-building page', async () => {
    const { wrapper } = await mounted({ siteprobeSites: vi.fn(async () => SITES) });
    await wrapper.get('[data-testid="add-entry-tab-advanced"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://unknown.test/work/1');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await flushPromises();
    await wrapper.get('[data-testid="siteprobe-build-rule"]').trigger('click');
    await flushPromises();

    // The third page opened on its guided flow, and the handed-over address is already in the
    // builder's first field: nothing to copy by hand.
    expect(wrapper.find('[data-testid="add-entry-rules"]').exists()).toBe(true);
    await wrapper.get('[data-testid="rule-begin"]').trigger('click');
    await wrapper.get('[data-testid="rule-prepare-done"]').trigger('click');
    expect(wrapper.get('[data-testid="rule-url-1"]').element)
      .toHaveProperty('value', 'https://unknown.test/work/1');
  });

  /** Through the advanced page and a crawl, to the review — the way a person gets there. */
  async function arriveAtReview(wrapper: Awaited<ReturnType<typeof mounted>>['wrapper']): Promise<void> {
    await wrapper.get('[data-testid="add-entry-tab-advanced"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/work/1');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await flushPromises();
    await wrapper.get('[data-testid="siteprobe-run"]').trigger('click');
    await new Promise((resolve) => setTimeout(resolve, 900));
    await flushPromises();
  }

  it('sends the batch Author typed on the review page with the commit', async () => {
    const api = {
      siteprobeSites: vi.fn(async () => SITES),
      siteprobeResolve: vi.fn(async (): Promise<SiteprobeResolveEvent> => ({
        event: 'resolve', matched: true, input: 'x', site: 'demo.test', display_name: 'Demo',
        export_group: 'demo_test', source: 'installed', kind: 'work', label: 'Work',
        single: true, ref: { id: '1' },
      })),
      startSiteprobeRun: vi.fn(async (): Promise<SiteprobeRun> => ({
        ...runFor('demo.test'), status: 'running', result: null })),
      getSiteprobeRun: vi.fn(async (): Promise<SiteprobeRun> => runFor('demo.test')),
      previewSiteProbeExportPath: vi.fn(async () => ({
        source: 'demo.test', entryCount: 1, tagAssignmentCount: 0, uniqueTagCount: 0,
        entriesMissingCover: 0, warnings: [],
        batch: { source: 'demo.test', warnings: [], entries: [{
          externalKey: 'demo.test:1', title: 'A work', tags: [{ name: 'Tag' }], fields: {},
        }] },
      })),
      commitImportPath: vi.fn(async () => ({
        entries: [{ entryId: 11, externalKey: 'demo.test:1', title: 'A work' }],
        entryCount: 1, skippedExistingEntryCount: 0, existingEntryIds: [],
        createdProducerCount: 1, producerLinkCount: 1, tagAssignmentCount: 0,
        contentCount: 0, authorRatingCount: 0, warnings: [],
      })),
    };
    const { wrapper } = await mounted(api as unknown as Partial<GalleryApi>);
    await arriveAtReview(wrapper);
    const field = wrapper.find('[data-testid="import-author-name"]');
    expect(field.exists()).toBe(true);
    await wrapper.get('[data-testid="import-author-name"]').setValue('冷泉');
    // No template for this Gallery yet, so the commit rides the template door.
    await wrapper.get('[data-testid="import-create-template"]').trigger('click');
    await flushPromises();
    expect(api.commitImportPath).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ authorName: '冷泉' }),
    );
    wrapper.unmount();
  });

  it('shows a server-run crawl’s cover from the export tree, not only a dragged file', async () => {
    // Measured on the first run whose cover actually downloaded (2026-10-04): the review received an
    // **absolute path**, and the cover lookup knew only two shapes — an http(s) URL, shown as-is, and
    // a file among the ones the page holds. A path was neither, so the image was silently absent and
    // the cover read as gone at the exact moment the underlying bug was fixed.
    const { wrapper } = await mounted({
      siteprobeSites: vi.fn(async () => SITES),
      siteprobeResolve: vi.fn(async (): Promise<SiteprobeResolveEvent> => ({
        event: 'resolve', matched: true, input: 'x', site: 'demo.test', display_name: 'Demo',
        export_group: 'demo_test', source: 'installed', kind: 'work', label: 'Work',
        single: true, ref: { id: '1' },
      })),
      startSiteprobeRun: vi.fn(async (): Promise<SiteprobeRun> => ({
        ...runFor('demo.test'), status: 'running', result: null })),
      getSiteprobeRun: vi.fn(async (): Promise<SiteprobeRun> => runFor('demo.test')),
      previewSiteProbeExportPath: vi.fn(async () => ({
        source: 'demo.test', entryCount: 1, tagAssignmentCount: 0, uniqueTagCount: 0,
        entriesMissingCover: 0, warnings: [],
        batch: { source: 'demo.test', warnings: [], entries: [{
          externalKey: 'demo.test:1', title: 'A work',
          cover: 'D:/export/demo_test/single/items/1/cover/cover.jpg',
          tags: [], fields: {},
        }] },
      })),
      siteprobeExportFileUrl: vi.fn((path: string) =>
        `http://127.0.0.1:8765/api/siteprobe/export-file?path=${encodeURIComponent(path)}`),
    });
    await wrapper.get('[data-testid="add-entry-tab-advanced"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/work/1');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await flushPromises();
    await wrapper.get('[data-testid="siteprobe-run"]').trigger('click');
    await new Promise((resolve) => setTimeout(resolve, 900));
    await flushPromises();

    const image = wrapper.get('[data-testid="import-template-preview"] img.preview-cover');
    const src = image.attributes('src') ?? '';
    expect(src).toContain('/api/siteprobe/export-file?path=');
    expect(decodeURIComponent(src)).toContain('items/1/cover/cover.jpg');
  });

  it('lets the review name a Gallery that does not exist yet', async () => {
    // An import may be the first work of a new Gallery, and the field was a `<select>`: a type that
    // is not in the list yet could not be said at all. It is the quick page's own control now —
    // typed freely, with the same visibility-filtered list behind the arrow.
    const { wrapper } = await mounted({
      siteprobeSites: vi.fn(async () => SITES),
      siteprobeResolve: vi.fn(async (): Promise<SiteprobeResolveEvent> => ({
        event: 'resolve', matched: true, input: 'x', site: 'demo.test', display_name: 'Demo',
        export_group: 'demo_test', source: 'installed', kind: 'work', label: 'Work',
        single: true, ref: { id: '1' },
      })),
      startSiteprobeRun: vi.fn(async (): Promise<SiteprobeRun> => ({
        ...runFor('demo.test'), status: 'running', result: null })),
      getSiteprobeRun: vi.fn(async (): Promise<SiteprobeRun> => runFor('demo.test')),
      previewSiteProbeExportPath: vi.fn(async () => ({
        source: 'demo.test', entryCount: 1, tagAssignmentCount: 0, uniqueTagCount: 0,
        entriesMissingCover: 0, warnings: [],
        batch: { source: 'demo.test', warnings: [], entries: [{
          externalKey: 'demo.test:1', title: 'A work', tags: [], fields: {},
        }] },
      })),
      listLayout: vi.fn(async () => []),
      listTaxonomyAliases: vi.fn(async () => []),
    });
    await arriveAtReview(wrapper);

    const field = wrapper.get('[data-testid="import-type-input"]');
    expect(field.element.tagName).toBe('INPUT');
    await field.setValue('brand-new-gallery');
    await flushPromises();
    expect((field.element as HTMLInputElement).value).toBe('brand-new-gallery');
    // And the list is still there, visibility-filtered like the quick page's.
    await wrapper.get('[data-testid="import-type-toggle"]').trigger('click');
    const options = wrapper.findAll('[data-testid="import-type-list"] [data-gallery-option]')
      .map((option) => option.attributes('data-gallery-option'));
    expect(options).toEqual(['game', 'comic']);
  });

  it('lands a learned work’s synopsis as Content, so the review shows it as one', async () => {
    // Measured on the first generated adapter (`www.bilinovel.com`, 2026-10-03): the item carries an
    // `author` and a `description`; the picker promised the field it calls 简介 is imported as the
    // work's body; and the review had no destination for it, so the row arrived at `ignore` and the
    // synopsis never became a Content row. The default is that promise kept — the review can still
    // send the field anywhere else.
    const run: SiteprobeRun = {
      id: 'run-1', command: 'run', input: 'x', site: 'demo.test', kind: 'work',
      review: false, status: 'done', events: [], eventsDropped: 0,
      result: {
        event: 'result', command: 'run', site: 'demo.test', kind: 'work',
        ref: '4525', works: 1, listing: '/export/www.bilinovel.com/single',
        export: '/export/www.bilinovel.com/single/metadata.json', review_html: null, origin: null,
        media: {}, warnings: [],
      },
      error: null, selection: null, startedAt: new Date().toISOString(), finishedAt: null,
    };
    const { wrapper } = await mounted({
      siteprobeSites: vi.fn(async () => SITES),
      siteprobeResolve: vi.fn(async (): Promise<SiteprobeResolveEvent> => ({
        event: 'resolve', matched: true, input: 'x', site: 'demo.test',
        display_name: 'Demo', export_group: 'demo_test', source: 'local',
        kind: 'work', label: 'Work', single: true, ref: { id: '4525' },
      })),
      startSiteprobeRun: vi.fn(async (): Promise<SiteprobeRun> => (
        { ...run, status: 'running', result: null })),
      getSiteprobeRun: vi.fn(async (): Promise<SiteprobeRun> => run),
      // The review loads its Gallery layout and the author dictionary before it can map a field;
      // an api without them throws and the destinations stay empty, which is what the first
      // version of this test measured (every select empty, including `authors`).
      listLayout: vi.fn(async () => []),
      listTaxonomyAliases: vi.fn(async () => []),
      previewSiteProbeExportPath: vi.fn(async () => ({
        source: 'demo.test', entryCount: 1, tagAssignmentCount: 0, uniqueTagCount: 0,
        entriesMissingCover: 0, warnings: [],
        batch: { source: 'demo.test', warnings: [], entries: [{
          externalKey: 'demo.test:4525.html',
          title: '转生了的大圣女，拼死隐瞒自己身为圣女 ZERO',
          tags: [],
          fields: { authors: ['十夜'], description: ['全篇全新创作！'] },
        }] },
      })),
    });
    await wrapper.get('[data-testid="add-entry-tab-advanced"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/work/1');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await flushPromises();
    await wrapper.get('[data-testid="siteprobe-run"]').trigger('click');
    await new Promise((resolve) => setTimeout(resolve, 900));
    await flushPromises();

    const row = wrapper.findAll('.mapping-list label')
      .find((label) => label.text().includes('description'));
    expect(row, 'the review offers no destination for the synopsis').toBeTruthy();
    expect((row!.get('select').element as HTMLSelectElement).value).toBe('content');
    // The template preview already shows the row that destination will create.
    expect(wrapper.get('[data-testid="import-template-preview"]').text()).toContain('全篇全新创作！');
  });

  it('says a Gallery has no template, and offers the two ways out', async () => {
    // Measured on a real import (2026-10-03): a brand-new Gallery has no Sections or Facets, so the
    // works' Tags have nowhere to land, the commit is refused, and the screen said so with no way
    // forward. The notice names the loss and the two doors are the way past it.
    let layout: Array<{ name: string; facets: Array<{ id: number; name: string }> }> = [];
    const applied: string[] = [];
    const slotsApplied: string[] = [];
    const api = {
      siteprobeSites: vi.fn(async () => SITES),
      siteprobeResolve: vi.fn(async (): Promise<SiteprobeResolveEvent> => ({
        event: 'resolve', matched: true, input: 'x', site: 'demo.test', display_name: 'Demo',
        export_group: 'demo_test', source: 'installed', kind: 'work', label: 'Work',
        single: true, ref: { id: '1' },
      })),
      startSiteprobeRun: vi.fn(async (): Promise<SiteprobeRun> => ({
        ...runFor('demo.test'), status: 'running', result: null })),
      getSiteprobeRun: vi.fn(async (): Promise<SiteprobeRun> => runFor('demo.test')),
      previewSiteProbeExportPath: vi.fn(async () => ({
        source: 'demo.test', entryCount: 1, tagAssignmentCount: 0, uniqueTagCount: 0,
        entriesMissingCover: 0, warnings: [],
        batch: { source: 'demo.test', warnings: [], entries: [{
          externalKey: 'demo.test:1', title: 'A work', tags: [{ name: 'Tag' }], fields: {},
        }] },
      })),
      listLayout: vi.fn(async () => layout),
      listTaxonomyAliases: vi.fn(async () => []),
      applyCommonTemplate: vi.fn(async (entryType: string) => {
        applied.push(entryType);
        layout = [{ name: 'Basic', facets: [{ id: 7, name: 'Tags' }] }];
        return { entryType, sectionCount: 1, facetCount: 1, ratingSlotCount: 1, templateFiles: null };
      }),
      // The template is two halves: the Sections/Facets above, and the rating dimensions. A Gallery
      // built before the template carried its General Rating still needs the second call.
      applyCommonTemplateRatingSlots: vi.fn(async (entryType: string) => {
        slotsApplied.push(entryType);
        return { entryType, sectionCount: 0, facetCount: 0, ratingSlotCount: 1, templateFiles: null };
      }),
      siteprobeExportFileUrl: vi.fn((path: string) =>
        `http://127.0.0.1:8765/api/siteprobe/export-file?path=${encodeURIComponent(path)}`),
      commitImportPath: vi.fn(async () => ({
        entries: [{ entryId: 11, externalKey: 'demo.test:1', title: 'A work' }],
        entryCount: 1, skippedExistingEntryCount: 0, existingEntryIds: [],
        createdProducerCount: 0, producerLinkCount: 0, tagAssignmentCount: 0,
        contentCount: 0, authorRatingCount: 0, warnings: [],
      })),
    };
    const { wrapper } = await mounted(api as unknown as Partial<GalleryApi>);
    await arriveAtReview(wrapper);

    expect(wrapper.find('[data-testid="import-no-template-notice"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="import-no-template-notice"]').text())
      .toContain('Tags are lost');

    // Door one: the common template, for this Gallery, and the layout comes back with a Facet.
    await wrapper.get('[data-testid="import-use-common-template"]').trigger('click');
    await flushPromises();
    expect(applied).toEqual(['game']);
    expect(slotsApplied).toEqual(['game']);
    expect(api.listLayout).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="import-no-template-notice"]').exists()).toBe(false);

    // Door two, with no template at all: the work is created without its Tags and handed to the
    // editor — the commit must therefore be allowed to run with no canonical Facet.
    layout = [];
    await wrapper.get('[data-testid="import-type-input"]').setValue('brand-new');
    await wrapper.get('[data-testid="import-type-input"]').trigger('change');
    await flushPromises();
    expect(wrapper.find('[data-testid="import-no-template-notice"]').exists()).toBe(true);
    await wrapper.get('[data-testid="import-create-template"]').trigger('click');
    await flushPromises();
    expect(api.commitImportPath).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ canonicalTagFacetId: null }),
    );
    const emitted = wrapper.emitted('imported')?.at(-1) ?? [];
    expect(emitted.at(-1)).toBe(true);
  });

  it('shows the import review on its own page when a crawl hands it an export', async () => {
    const run: SiteprobeRun = {
      id: 'run-1', command: 'run', input: 'x', site: 'demo.test', kind: 'work',
      review: false, status: 'done', events: [], eventsDropped: 0,
      result: {
        event: 'result', command: 'run', site: 'demo.test', kind: 'work',
        ref: '1', works: 1, listing: '/export/demo_test/single',
        export: '/export/demo_test/single/metadata.json', review_html: null, origin: null,
        media: {}, warnings: [],
      },
      error: null, selection: null, startedAt: new Date().toISOString(), finishedAt: null,
    };
    const { wrapper } = await mounted({
      siteprobeSites: vi.fn(async () => SITES),
      siteprobeResolve: vi.fn(async (): Promise<SiteprobeResolveEvent> => ({
        event: 'resolve', matched: true, input: 'x', site: 'demo.test', display_name: 'Demo',
        export_group: 'demo_test', source: 'installed', kind: 'work', label: 'Work',
        single: true, ref: { id: '1' },
      })),
      startSiteprobeRun: vi.fn(async (): Promise<SiteprobeRun> => (
        { ...run, status: 'running', result: null })),
      getSiteprobeRun: vi.fn(async (): Promise<SiteprobeRun> => run),
      previewSiteProbeExportPath: vi.fn(async () => ({
        source: 'demo.test', entryCount: 1, tagAssignmentCount: 0, uniqueTagCount: 0,
        entriesMissingCover: 0, warnings: [],
        batch: { source: 'demo.test', warnings: [], entries: [{
          externalKey: 'demo.test:1', title: 'A work', tags: [], fields: {},
        }] },
      })),
    });
    await wrapper.get('[data-testid="add-entry-tab-advanced"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="siteprobe-address"]').setValue('https://demo.test/work/1');
    await wrapper.get('[data-testid="siteprobe-address"]').trigger('change');
    await flushPromises();
    await wrapper.get('[data-testid="siteprobe-run"]').trigger('click');
    await new Promise((resolve) => setTimeout(resolve, 900));
    await flushPromises();

    // The review is a page of its own: the crawl takes the person to it, and the files page's own
    // contents are not dragged along. This used to assert the files section *existed* here, which
    // it did — a bare `v-else` rendered it on every tab but the three named ones, so the review
    // screen carried the folder dropzone above it and the test could never see that.
    expect(wrapper.find('[data-testid="add-entry-import"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="import-review"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="add-entry-files"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="desktop-entry-import"]').exists()).toBe(false);
  });
});

describe('the Add Entry page as four pages', () => {
  it('opens on the quick page and offers the other three', async () => {
    const { wrapper } = await mounted();
    for (const key of ['quick', 'advanced', 'rules', 'files']) {
      expect(wrapper.find(`[data-testid="add-entry-tab-${key}"]`).exists()).toBe(true);
    }
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="add-entry-files"]').exists()).toBe(false);

    await wrapper.get('[data-testid="add-entry-tab-files"]').trigger('click');
    expect(wrapper.find('[data-testid="add-entry-files"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(false);
    // The folder door kept its own hook, so nothing had to learn a new selector.
    expect(wrapper.find('[data-testid="desktop-entry-import"]').exists()).toBe(true);

    await wrapper.get('[data-testid="add-entry-tab-quick"]').trigger('click');
    expect(wrapper.find('[data-testid="manual-entry-form"]').exists()).toBe(true);
  });
});

describe('the quick page’s copy', () => {
  it('shows no unfilled placeholder, in either language', async () => {
    // Measured in the browser: the page-count field was labelled with a *count* key and rendered
    // the literal "{count} pages". A label that needs a parameter it was never given is invisible
    // to review and obvious to a reader, so the whole page is checked for it.
    for (const locale of ['en', 'zh-CN'] as const) {
      setLocale(locale);
      const { wrapper } = await mounted();
      const text = wrapper.get('[data-testid="manual-entry-form"]').text();
      expect(text.match(/\{\w+\}/gu) ?? []).toEqual([]);
    }
    setLocale('en');
  });
});

describe('the cover and its previews', () => {
  it('turns the media area into a cover on top and "add more as preview" under it', async () => {
    const { wrapper } = await mounted();
    await dropImages(wrapper, 'cover', [image('first.jpg')]);

    // The cover is what was dropped, shown as it will appear…
    expect(wrapper.get('[data-testid="entry-cover-slot"]').get('img').attributes('src'))
      .toBe('blob:first.jpg');
    // …with the same box under it, now offering a preview.
    const previewBox = wrapper.get('[data-testid="entry-preview-dropzone"]');
    expect(previewBox.text()).toContain('add more as preview');
    expect(previewBox.text()).not.toContain('Cover');
    // One image is not a stack yet.
    expect(wrapper.find('[data-testid="entry-media-stack"]').exists()).toBe(false);
  });

  it('shows the work card\u2019s own stack once a second image arrives, cover first', async () => {
    const { wrapper } = await mounted();
    await dropImages(wrapper, 'cover', [image('cover.jpg')]);
    await dropImages(wrapper, 'preview', [image('preview.jpg')]);

    const stack = wrapper.get('[data-testid="entry-media-stack"]');
    const layers = stack.findAll('img');
    expect(layers.map((layer) => layer.attributes('src')))
      .toEqual(['blob:cover.jpg', 'blob:preview.jpg']);
    // The layers are placed by the shared geometry, not by this page's own arithmetic.
    expect(layers[1]!.attributes('style')).toContain('rotate');
    for (const layer of layers) {
      expect(layer.attributes('style')).toContain('width');
    }
  });

  it('stops at a cover plus three previews and says so', async () => {
    const { wrapper } = await mounted();
    await dropImages(wrapper, 'cover', [image('1.jpg'), image('2.jpg'), image('3.jpg'), image('4.jpg')]);
    expect(wrapper.get('[data-testid="entry-media-stack"]').findAll('img')).toHaveLength(4);
    // The box is replaced by the limit itself, and the fifth image is refused with a notice.
    expect(wrapper.find('[data-testid="entry-media-limit"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="entry-preview-dropzone"]').exists()).toBe(false);

    await wrapper.get('.media-composer').trigger('drop',
      { dataTransfer: { files: [image('5.jpg')] } });
    await flushPromises();
    expect(wrapper.get('[data-testid="entry-media-notice"]').text()).toContain('limit');
    expect(wrapper.get('[data-testid="entry-media-stack"]').findAll('img')).toHaveLength(4);
  });
});

describe('the one-link fetch', () => {
  it('fills the title and the cover, and says what it is doing while it works', async () => {
    let release: (value: SiteprobeLinkMeta) => void = () => undefined;
    const pending = new Promise<SiteprobeLinkMeta>((resolve) => { release = resolve; });
    const fetchMeta = vi.fn(() => pending);
    const { wrapper } = await mounted({ fetchSiteProbeLinkMeta: fetchMeta as never });

    await wrapper.get('[data-testid="entry-source-url"]').setValue('https://demo.test/ok');
    await wrapper.get('[data-testid="entry-try-link"]').trigger('click');
    // The button is not a freeze: the status beside it says what is happening.
    expect(wrapper.get('[data-testid="entry-link-status"]').text()).toContain('Working');
    expect(fetchMeta).toHaveBeenCalledWith('https://demo.test/ok');

    release({
      verdict: 'found', outcome: 'ok', detail: 'read', title: 'A fetched title',
      // A four-byte JPEG, base64 — the shape the server hands over for the real reader's bytes.
      coverDataUrl: 'data:image/jpeg;base64,/9j/2Q==',
      coverMimeType: 'image/jpeg', coverBytes: 4, logPath: null,
    });
    await flushPromises();

    expect(wrapper.get('[data-testid="entry-link-status"]').text()).toBe('Done');
    expect((wrapper.get('input[name="title"]').element as HTMLInputElement).value)
      .toBe('A fetched title');
    // The fetched cover became an ordinary chosen image, previewed by the same stack.
    expect(wrapper.get('[data-testid="entry-cover-slot"]').get('img').attributes('src'))
      .toBe('blob:cover.jpg');
  });

  it('sends a page it cannot read to the advanced path, with a way to get there', async () => {
    const { wrapper } = await mounted({
      fetchSiteProbeLinkMeta: vi.fn(async (): Promise<SiteprobeLinkMeta> => ({
        verdict: 'needs-advanced', outcome: 'no-title', detail: 'no title', title: null,
        coverDataUrl: null, coverMimeType: null, coverBytes: null, logPath: null,
      })),
    });
    await wrapper.get('[data-testid="entry-source-url"]').setValue('https://demo.test/no-title');
    await wrapper.get('[data-testid="entry-try-link"]').trigger('click');
    await flushPromises();

    const message = wrapper.get('[data-testid="entry-link-message"]');
    expect(message.text()).toContain('Link import');
    await message.get('[data-testid="entry-open-advanced"]').trigger('click');
    expect(wrapper.find('[data-testid="add-entry-advanced"]').exists()).toBe(true);
  });

  it('asks for a bug report, and keeps the log path it was given', async () => {
    const copy = vi.fn();
    Object.assign(navigator, { clipboard: { writeText: copy } });
    const { wrapper } = await mounted({
      fetchSiteProbeLinkMeta: vi.fn(async (): Promise<SiteprobeLinkMeta> => ({
        verdict: 'bug', outcome: null, detail: 'the reader crashed', title: null,
        coverDataUrl: null, coverMimeType: null, coverBytes: null,
        logPath: 'C:/data/logs/siteprobe-link-meta-1.log',
      })),
    });
    await wrapper.get('[data-testid="entry-source-url"]').setValue('https://demo.test/boom');
    await wrapper.get('[data-testid="entry-try-link"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="entry-link-message"]').text()).toContain('report');
    await wrapper.get('[data-testid="entry-copy-diagnostics"]').trigger('click');
    await flushPromises();
    expect(copy).toHaveBeenCalledOnce();
    expect(String(copy.mock.calls[0]![0])).toContain('siteprobe-link-meta-1.log');
  });

  it('is not offered offline, and says why', async () => {
    const { wrapper } = await mounted({}, true);
    expect(wrapper.get('[data-testid="entry-try-link"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="entry-link-status"]').text()).toContain('offline');
  });
});

describe('what creating the Entry sends', () => {
  it('includes an initial typed Content row from the offline manual control', async () => {
    const { wrapper } = await mounted({}, true);
    await wrapper.get('input[name="title"]').setValue('Offline work');
    await wrapper.get('[data-testid="manual-initial-content-type"]').setValue('Notes');
    await wrapper.get('[data-testid="manual-initial-content-text"]').setValue('Read this later');
    await wrapper.get('[data-testid="manual-entry-form"]').trigger('submit');
    expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({
      contents: [{ contentType: 'Notes', content: 'Read this later' }],
    });
  });

  it('carries the cover, every preview and the address', async () => {
    const { wrapper } = await mounted();
    await dropImages(wrapper, 'cover', [image('cover.jpg'), image('p1.jpg'), image('p2.jpg')]);
    await wrapper.get('[data-testid="entry-source-url"]').setValue('https://demo.test/work/9');
    await wrapper.get('input[name="title"]').setValue('A work');
    await wrapper.get('[data-testid="manual-entry-form"]').trigger('submit');
    await flushPromises();

    const draft = wrapper.emitted('submit')![0]![0] as {
      coverFile: File | null; previewFiles: File[]; sourceUrl: string | null; title: string;
    };
    expect(draft.title).toBe('A work');
    expect(draft.coverFile?.name).toBe('cover.jpg');
    expect(draft.previewFiles.map((file) => file.name)).toEqual(['p1.jpg', 'p2.jpg']);
    expect(draft.sourceUrl).toBe('https://demo.test/work/9');
  });
});


describe('the address button and the Gallery field', () => {
  it('says what the button is for before it is pressed, and what it found afterwards', async () => {
    const { wrapper } = await mounted();
    // The line beside the button is never blank: it explains the button first…
    expect(wrapper.get('[data-testid="entry-link-status"]').text())
      .toContain('cover and title');

    await wrapper.get('[data-testid="entry-source-url"]').setValue('https://demo.test/ok');
    let release: (value: SiteprobeLinkMeta) => void = () => undefined;
    const pending = new Promise<SiteprobeLinkMeta>((resolve) => { release = resolve; });
    const client = wrapper.props('api') as GalleryApi;
    client.fetchSiteProbeLinkMeta = vi.fn(() => pending) as never;
    await wrapper.get('[data-testid="entry-try-link"]').trigger('click');
    expect(wrapper.get('[data-testid="entry-link-status"]').text()).toContain('Working');
    release({
      verdict: 'found', outcome: 'ok', detail: null, title: 'A title',
      coverDataUrl: null, coverMimeType: null, coverBytes: null, logPath: null,
    });
    await flushPromises();
    // …and is replaced by the answer once there is one.
    expect(wrapper.get('[data-testid="entry-link-status"]').text()).toBe('Done');
  });

  it('opens the Gallery list on demand, visible ones only while hideable content is hidden', async () => {
    showNsfw.value = false;
    const { wrapper } = await mounted();
    // A native datalist gives no list until the second click; this one opens when asked.
    expect(wrapper.find('[data-testid="type-gallery-list"]').exists()).toBe(false);
    await wrapper.get('[data-testid="type-gallery-toggle"]').trigger('click');
    const options = wrapper.get('[data-testid="type-gallery-list"]').findAll('[data-gallery-option]');
    expect(options.map((option) => option.attributes('data-gallery-option'))).toEqual(['game', 'comic']);
    expect(wrapper.findAll('[data-testid="gallery-nsfw-mark"]')).toHaveLength(0);

    // Showing hideable content offers everything, and marks the ones that can be hidden — the sidebar's own mark,
    // which is the shield there too rather than a word.
    showNsfw.value = true;
    await flushPromises();
    const all = wrapper.get('[data-testid="type-gallery-list"]').findAll('[data-gallery-option]');
    expect(all.map((option) => option.attributes('data-gallery-option')))
      .toEqual(['game', 'comic', 'hentai']);
    const marks = wrapper.findAll('[data-testid="gallery-nsfw-mark"]');
    expect(marks).toHaveLength(1);
    // The mark is the icon itself, not a word beside it: the testid lands on the drawn <svg>.
    expect(marks[0]!.element.tagName.toLowerCase()).toBe('svg');
    expect(marks[0]!.classes()).toContain('app-icon');
    showNsfw.value = false;
  });

  it('fills the field from the list, and still lets a new type be typed', async () => {
    const { wrapper } = await mounted();
    await wrapper.get('[data-testid="type-gallery-toggle"]').trigger('click');
    await wrapper.get('[data-gallery-option="comic"]').trigger('click');
    await flushPromises();
    const input = wrapper.get('input[name="type"]').element as HTMLInputElement;
    expect(input.value).toBe('comic');
    expect(wrapper.find('[data-testid="type-gallery-list"]').exists()).toBe(false);

    // A type that does not exist yet is created by typing it — the field is not a closed list.
    await wrapper.get('input[name="type"]').setValue('movie');
    await flushPromises();
    expect((wrapper.get('input[name="type"]').element as HTMLInputElement).value).toBe('movie');
  });
});
