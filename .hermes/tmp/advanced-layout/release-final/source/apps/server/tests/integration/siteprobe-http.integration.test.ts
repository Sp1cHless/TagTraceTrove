import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import sharp from 'sharp';

import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createSection } from '../../src/repositories/layout-repository.js';
import { createSiteprobeRuntime } from '../../src/siteprobe/runtime.js';
import { siteprobeFolderPath, type revealFolder } from '../../src/siteprobe/reveal.js';
import { getEntryDetail } from '../../src/repositories/entry-repository.js';
import { listSiteCrawlSources } from '../../src/repositories/site-crawl-repository.js';

/**
 * The SiteProbe half of the HTTP surface, driven through a stub tool.
 *
 * A stub rather than the real Python tool on purpose: these tests are about the server's behaviour —
 * the path guard, the job lifecycle, the import of an export the server can reach — and they must
 * run without a virtualenv, without a network, and without writing into anybody's library.
 */
const STUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'siteprobe-stub.mjs');
/** The builder stub, which speaks the builder's console shape (including the listing's `--kind`). */
const BUILD_STUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures',
                        'siteprobe-build-stub.mjs');

const databases: ReturnType<typeof createMigratedMemoryDatabase>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function testApp(
  reveal?: typeof revealFolder,
): Promise<{
  app: ReturnType<typeof createApiApp>;
  home: string;
  dataDir: string;
  mapping: Record<string, unknown>;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 't3-siteprobe-http-'));
  temporaryDirectories.push(dataDir);
  const home = join(dataDir, 'siteprobe');
  const database = createMigratedMemoryDatabase();
  databases.push(database);
  // A commit needs a reviewed mapping, and the canonical Tags Facet has to exist for it: the same
  // shape the web app sends after the import preview.
  const section = createSection(database, { entryType: 'illustration', name: '分类' });
  const runtime = createSiteprobeRuntime({
    dataDir,
    overrides: { tool: dirname(STUB), python: process.execPath, pythonArgs: [STUB],
                 buildArgs: [BUILD_STUB], listingArgs: [BUILD_STUB], home },
  });
  const app = createApiApp(database, {
    assetRoot: join(dataDir, 'assets'),
    databasePath: join(dataDir, 'library.db'),
    dataDir,
    siteprobeRuntime: runtime,
    ...(reveal ? { revealSiteprobeFolder: reveal } : {}),
  });
  return {
    app, home, dataDir,
    mapping: {
      entryType: 'illustration',
      canonicalTagFacetId: section.defaultFacetId,
      sourceContentType: 'source url',
      externalKeyContentType: 'external key',
      // What the import preview asks a person to review: the fields the export carries are either
      // mapped to something or explicitly ignored — commit refuses a field nobody decided about.
      fieldMappings: {
        authors: { kind: 'producer', createUnmatched: true, existingProducerIds: {} },
      },
      ignoredFields: ['works', 'characters'],
      authorRatings: [],
    },
  };
}

describe('the SiteProbe tool over HTTP', () => {
  it('answers with the readme a site wrote about itself, and with an empty one when it has none', async () => {
    const { app } = await testApp();

    const found = await app.request('/api/siteprobe/readme?site=demo.test');
    expect(found.status).toBe(200);
    const body = await found.json() as { site: string; source: string; text: string };
    expect(body).toMatchObject({ site: 'demo.test', source: 'installed' });
    expect(body.text).toContain('What it covers');

    const missing = await app.request('/api/siteprobe/readme');
    expect(missing.status).toBe(400);

    // The stub answers an unknown site with the tool's error event; the route turns that into 404
    // rather than pretending an empty readme.
    const unknown = await app.request('/api/siteprobe/readme?site=nope.test');
    expect(unknown.status).toBe(404);
  });

  it('takes a listing build as the listing’s two pages, and refuses any other count', async () => {
    const { app } = await testApp();
    const post = (body: unknown) => app.request('/api/siteprobe/runs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    // The second page is what teaches the adapter to turn the page, so a listing build without it is
    // refused at the door rather than installed as a one-page listing.
    const short = await post({ build: ['https://demo.test/list/1'], kind: 'search' });
    expect(short.status).toBe(400);
    const long = await post({
      build: ['https://demo.test/list/1', 'https://demo.test/list/2', 'https://demo.test/list/3'],
      kind: 'search',
    });
    expect(long.status).toBe(400);

    const listing = await post({
      build: ['https://demo.test/list/1', 'https://demo.test/list/2'], kind: 'search',
    });
    expect(listing.status).toBe(201);
    const job = await listing.json() as { id: string; command: string };
    expect(job.command).toBe('build');
    const settled = await pollRun(app, job.id, (run) => run.status !== 'running');
    // The listing's kind reached the *listing* builder: `build_adapter.py` takes no `--kind`, so the
    // flag appearing in the stub's output is proof of which door the transport opened.
    const lines = settled.events.flatMap((event) => (
      event as { event: string; message?: string }).message ?? []).join(' ');
    expect(lines).toContain('kind: --kind=search');
    expect(lines).toContain('capturing https://demo.test/list/2');
  });

  it('serves a review page and the covers it references relatively, from the path it lives at', async () => {
    const { app, home } = await testApp();
    const started = await app.request('/api/siteprobe/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'https://demo.test/search/x', review: true }),
    });
    const job = await started.json() as { id: string };
    await pollRun(app, job.id, (run) => run.status === 'done');
    const listing = join(home, 'export', 'demo_test', 'listing_x');
    const media = join(listing, 'review_media');
    await mkdir(media, { recursive: true });
    // The shape a real review page has: the cards are built in JavaScript, and each cover is a
    // *relative* reference — measured on an 18comic search page, whose covers all 404'd once the page
    // was served from a single query endpoint.
    await writeFile(join(listing, 'review.html'),
      '<img src="review_media/cover_1.webp">', 'utf8');
    await writeFile(join(media, 'cover_1.webp'), 'not-really-an-image', 'utf8');

    // The path form is canonical, and it is what makes the relative cover resolve: the browser
    // resolves `review_media/cover_1.webp` against the document's own path.
    const page = await app.request('/api/siteprobe/export-file/demo_test/listing_x/review.html');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const cover = await app.request(
      '/api/siteprobe/export-file/demo_test/listing_x/review_media/cover_1.webp');
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toContain('image/webp');

    // The query form a client builds from an absolute path answers with the canonical one, so an
    // already-handed-out link keeps working.
    const redirect = await app.request(
      `/api/siteprobe/export-file?path=${encodeURIComponent(join(listing, 'review.html'))}`,
      { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(
      '/api/siteprobe/export-file/demo_test/listing_x/review.html');

    // C2 keeps the active review run id across the canonical path redirect, so the page can send its
    // selection to this run rather than opening a save dialog.
    const returning = await app.request(
      `/api/siteprobe/export-file?path=${encodeURIComponent(join(listing, 'review.html'))}&selectionRunId=${job.id}`,
      { redirect: 'manual' });
    expect(returning.status).toBe(302);
    expect(returning.headers.get('location')).toBe(
      `/api/siteprobe/export-file/demo_test/listing_x/review.html?selectionRunId=${job.id}`);
    const wrongOwner = await app.request(
      `/api/siteprobe/export-file?path=${encodeURIComponent(join(listing, 'review.html'))}&selectionRunId=00000000-0000-4000-8000-000000000001`,
      { redirect: 'manual' });
    expect(wrongOwner.status).toBe(400);

    // The same guard as the import: nothing outside the export root, and no traversal.
    // is normalized away by the URL before routing (and never reaches a handler), an encoded one is
    // decoded and then refused by the guard — either way it is a refusal, never a file.
    for (const path of ['../../library.db', '..%2F..%2Flibrary.db', 'demo_test/../../../evil.html']) {
      const refused = await app.request(`/api/siteprobe/export-file/${path}`);
      expect([400, 404], path).toContain(refused.status);
      expect(await refused.text(), path).not.toContain('SQLite');
    }
    const missing = await app.request('/api/siteprobe/export-file/demo_test/nothing.html');
    expect(missing.status).toBe(404);
    const missingQuery = await app.request(
      `/api/siteprobe/export-file?path=${encodeURIComponent(join(home, 'export', 'demo_test', 'nothing.html'))}`,
      { redirect: 'manual' },
    );
    expect(missingQuery.status).toBe(404);
  });

  it('refuses export-file symlinks whose real target leaves the export root', async () => {
    const { app, home, dataDir } = await testApp();
    const listing = join(home, 'export', 'demo_test', 'listing_x');
    const outside = join(dataDir, 'outside');
    await mkdir(listing, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'private.html'), 'outside-secret', 'utf8');
    const link = join(listing, 'escaped');
    await symlink(outside, link, 'junction');

    const absoluteTarget = join(link, 'private.html');
    const query = await app.request(
      `/api/siteprobe/export-file?path=${encodeURIComponent(absoluteTarget)}`, { redirect: 'manual' });
    const canonical = await app.request(
      '/api/siteprobe/export-file/demo_test/listing_x/escaped/private.html');
    await writeFile(join(outside, 'metadata.json'), JSON.stringify(exportDocument()), 'utf8');
    const previewThroughLink = await app.request('/api/imports/site-probe/preview-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadataPath: join(link, 'metadata.json') }),
    });

    expect(query.status).toBe(400);
    expect(canonical.status).toBe(400);
    expect(previewThroughLink.status).toBe(400);
    expect(await query.text()).not.toContain('outside-secret');
    expect(await canonical.text()).not.toContain('outside-secret');
  });

  it('writes a log for an unhandled fault and names it in the answer', async () => {
    // Measured on a phone's import that answered 500: the browser showed "Internal server error", the
    // server's console had the stack, and nothing on disk did — so a failure that could not be
    // reproduced on the machine it was reported from had no way to be reported at all. The answer now
    // names the file, the same convention the tool's own faults use.
    const { app, dataDir } = await testApp();
    // A batch naming one work twice is refused by the commit itself — a real throw, not a validation
    // the route turns into a 400.
    const duplicated = {
      source: 'demo.test',
      warnings: [],
      entries: [
        { externalKey: 'demo.test:42', title: 'A work', tags: [], sources: [{ label: 'demo', url: 'https://demo.test/w/42' }] },
        { externalKey: 'demo.test:42', title: 'The same work again', tags: [], sources: [{ label: 'demo', url: 'https://demo.test/w/42' }] },
      ],
    };
    const response = await app.request('/api/imports/commit-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        batch: duplicated,
        mapping: {
          entryType: 'illustration', canonicalTagFacetId: null, sourceContentType: 'source url',
          externalKeyContentType: 'external key', fieldMappings: {}, ignoredFields: [],
          authorRatings: [],
        },
      }),
    });
    expect(response.status).toBe(500);
    const body = await response.json() as { error: { message: string } };
    const named = /log: (.+)$/u.exec(body.error.message)?.[1];
    expect(named).toBeTruthy();
    const written = await readFile(named!, 'utf8');
    expect(written).toContain('Duplicate work id');
    expect(written).toContain('/api/imports/commit-path');
    expect(named!.startsWith(join(dataDir, 'logs'))).toBe(true);
  });

  it('returns 404 when a requested SiteProbe metadata path is missing', async () => {
    const { app, home } = await testApp();
    const response = await app.request('/api/imports/site-probe/preview-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadataPath: join(home, 'export', 'missing', 'metadata.json') }),
    });
    expect(response.status).toBe(404);
  });

  it('does not ingest media reached through a symlink outside the export root', async () => {
    const { app, home, dataDir, mapping } = await testApp();
    const listing = join(home, 'export', 'demo_test', 'listing_media');
    const outside = join(dataDir, 'outside');
    const coverDirectory = join(listing, 'items', '42', 'cover');
    await mkdir(dirname(coverDirectory), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, coverDirectory, 'junction');
    await writeFile(join(outside, 'cover.jpg'), await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 20, g: 60, b: 100 } },
    }).jpeg().toBuffer());
    await writeFile(join(listing, 'metadata.json'), JSON.stringify(exportDocument()), 'utf8');

    const previewResponse = await app.request('/api/imports/site-probe/preview-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadataPath: join(listing, 'metadata.json') }),
    });
    const preview = await previewResponse.json() as { batch: unknown };
    const commitResponse = await app.request('/api/imports/commit-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch: preview.batch, mapping }),
    });
    expect(commitResponse.status).toBe(201);
    const result = await commitResponse.json() as { mediaStoredCount: number; mediaWarnings: string[] };
    expect(result.mediaStoredCount).toBe(0);
    expect(result.mediaWarnings.join(' ')).toContain('outside the export root');
  });

  it('guards manifest-named metadata sidecars against traversal through junctions', async () => {
    const { app, home, dataDir } = await testApp();
    const outside = join(dataDir, 'outside-items');
    const genericListing = join(home, 'export', 'demo_test', 'listing_ids');
    const hitomiListing = join(home, 'export', 'hitomi_la', 'listing_ids');
    await mkdir(outside, { recursive: true });
    await mkdir(join(genericListing, 'items'), { recursive: true });
    await mkdir(join(hitomiListing, 'items'), { recursive: true });
    await symlink(outside, join(genericListing, 'items', '42'), 'junction');
    await symlink(outside, join(hitomiListing, 'items', '123'), 'junction');

    await writeFile(join(outside, 'metadata.json'), JSON.stringify({
      source_site: 'demo.test', source_id: '42', title: 'Outside work',
      detail_url: 'https://demo.test/work/42',
    }), 'utf8');
    await writeFile(join(genericListing, 'metadata.json'), JSON.stringify({
      source_site: 'demo.test', items: ['42', '../../../../outside-items'],
    }), 'utf8');
    const generic = await app.request('/api/imports/site-probe/preview-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadataPath: join(genericListing, 'metadata.json') }),
    });
    expect(generic.status).toBe(200);
    const genericBody = await generic.json() as { batch: { entries: unknown[]; warnings: string[] } };
    expect(genericBody.batch.entries).toHaveLength(0);
    expect(genericBody.batch.warnings.join(' ')).toContain('not readable');

    await writeFile(join(outside, 'metadata.json'), JSON.stringify({
      source_site: 'hitomi.la', source_id: '123', title: 'Outside Hitomi work',
      detail_url: 'https://hitomi.la/galleries/123.html',
      分类信息: { 作品: [], 登场人物: [], 分类标签: [], 作者: [] },
    }), 'utf8');
    await writeFile(join(hitomiListing, 'metadata.json'), JSON.stringify({
      source_site: 'hitomi.la', items: ['123'],
    }), 'utf8');
    const hitomi = await app.request('/api/imports/site-probe/preview-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadataPath: join(hitomiListing, 'metadata.json') }),
    });
    expect(hitomi.status).toBe(400);
  });

  it('serves the review page and a selection from the export tree, and nothing else', async () => {
    const { app, home } = await testApp();
    const listing = join(home, 'export', 'demo_test', 'listing_x');
    await mkdir(listing, { recursive: true });
    await writeFile(join(listing, 'review.html'), '<html><body>pick</body></html>', 'utf8');
    await writeFile(join(listing, 'selection_x.json'), '{"item_count":2}', 'utf8');
    await writeFile(join(listing, 'cover.png'), 'not-an-image', 'utf8');

    // The query form answers with the canonical path — a redirect the browser follows — so that the
    // page's own relative references resolve against the document's real URL.
    const page = await app.request(
      `/api/siteprobe/export-file?path=${encodeURIComponent(join(listing, 'review.html'))}`);
    expect(page.status).toBe(302);
    const served = await app.request(String(page.headers.get('location')));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/html');
    await expect(served.text()).resolves.toContain('pick');

    // The guard is the same one the import uses: inside `<home>/export`, and `..` resolved before
    // the check, so an absolute path outside it is refused however it is spelled.
    for (const path of [join(home, 'library.db'), join(listing, '..', '..', '..', 'outside.html')]) {
      const refused = await app.request(
        `/api/siteprobe/export-file?path=${encodeURIComponent(path)}`);
      expect(refused.status, path).toBe(400);
    }
    expect((await app.request('/api/siteprobe/export-file')).status).toBe(400);
  });


  it('reports where the tool and the home are', async () => {
    const { app, home } = await testApp();
    const response = await app.request('/api/siteprobe/status');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, home, detail: null });
  });

  it('opens the folder adapters go into, from a layer name and never a path', async () => {
    const opened: { folder: string; path: string }[] = [];
    const { app, home } = await testApp(async (tooling, folder) => {
      opened.push({ folder, path: siteprobeFolderPath(tooling, folder) });
      return { result: { folder, path: siteprobeFolderPath(tooling, folder) }, detail: null };
    });
    const post = (body: unknown) => app.request('/api/siteprobe/reveal-folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    const openedResponse = await post({ folder: 'installed' });
    expect(openedResponse.status).toBe(200);
    await expect(openedResponse.json()).resolves.toEqual({
      folder: 'installed', path: join(home, 'installed'),
    });
    expect(opened[0]?.folder).toBe('installed');

    // A path is not a layer, and the folder it names is never taken from the request: the body is an
    // enum, so this endpoint cannot be asked to open anything else on the machine.
    for (const folder of ['/etc', 'C:\\Windows', '../../', 'export', '']) {
      expect((await post({ folder })).status, folder).toBe(400);
    }
    expect((await post({ folder: 'installed', path: '/etc' })).status).toBe(400);

    // A file manager that will not start is reported with the path, so it can be opened by hand.
    const failing = await testApp(async (_tooling, folder) => ({
      result: { folder, path: join(home, 'installed') }, detail: 'spawn explorer.exe ENOENT',
    }));
    const refused = await failing.app.request('/api/siteprobe/reveal-folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: 'installed' }),
    });
    expect(refused.status).toBe(502);
    const problem = await refused.json() as { error: { message: string } };
    expect(problem.error.message).toContain(join(home, 'installed'));
  });

  it('serves the site menu straight from the tool, with the target kinds intact', async () => {
    const { app } = await testApp();
    const response = await app.request('/api/siteprobe/sites');
    expect(response.status).toBe(200);
    const body = await response.json() as { sites: Array<{ key: string; targets: unknown[] }> };
    expect(body.sites[0]?.key).toBe('demo.test');
    expect(body.sites[0]?.targets).toHaveLength(2);
  });

  it('answers a resolve miss with 200 and matched:false, because a miss is an answer', async () => {
    const { app } = await testApp();
    const response = await app.request('/api/siteprobe/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'https://elsewhere.test/x' }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ matched: false, reason: 'NO_MATCH' });
  });

  it('runs the tool, exposes progress and the export, and refuses a second run at once', async () => {
    const { app } = await testApp();
    const started = await app.request('/api/siteprobe/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'https://demo.test/search/x' }),
    });
    expect(started.status).toBe(201);
    const job = await started.json() as { id: string };

    const settled = await pollRun(app, job.id, (run) => run.status === 'done');
    expect(settled.result?.export).toContain('listing_x');
    expect(settled.events.some((event) => event.event === 'progress')).toBe(true);

    // A second crawl while one is going is refused rather than racing over the same listing.
    const slow = await app.request('/api/siteprobe/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'slow' }),
    });
    expect(slow.status).toBe(201);
    const conflict = await app.request('/api/siteprobe/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'https://demo.test/search/y' }),
    });
    expect(conflict.status).toBe(409);
    await app.request(`/api/siteprobe/runs/${(await slow.json() as { id: string }).id}/cancel`, { method: 'POST' });
  });

  it('answers 404 for a run that does not exist', async () => {
    const { app } = await testApp();
    const response = await app.request('/api/siteprobe/runs/no-such-run');
    expect(response.status).toBe(404);
  });
});

describe('a review run and the selection it produces', () => {
  it('stays open after the process ends and reports the file the page saved', async () => {
    const { app, home } = await testApp();
    const started = await app.request('/api/siteprobe/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'https://demo.test/search/x', review: true }),
    });
    const job = await started.json() as { id: string };
    const reviewed = await pollRun(app, job.id, (run) => run.status === 'done');
    expect(reviewed.result?.export).toBeNull();
    expect(reviewed.result?.review_html).toContain('review.html');

    // What the page's "save" does: the browser writes the selection into the listing directory.
    const listing = join(home, 'export', 'demo_test', 'listing_x');
    await mkdir(listing, { recursive: true });
    await writeFile(join(listing, 'selection_x.json'),
      JSON.stringify({ source_site: 'demo.test', selected_source_ids: ['42'] }), 'utf8');
    const watched = await pollRun(app, job.id, (run) => run.selection !== null);
    expect(watched.selection).toContain('selection_x.json');
  });
});

describe('importing an export the server can reach', () => {
  it('takes the selection a browser downloaded and puts it where the watch looks', async () => {
    const { app, home } = await testApp();
    const listing = join(home, 'export', 'demo_test', 'listing_x');
    await mkdir(listing, { recursive: true });
    // A review run, watching that listing for the file its page saves.
    const started = await app.request('/api/siteprobe/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'https://demo.test/search/x', review: true }),
    });
    const job = await started.json() as { id: string };
    // The listing exists only once the review event has arrived, which is also when the tool has
    // stopped and the person is looking at the page.
    await pollRun(app, job.id, (run) => run.status === 'done');

    // hitomi's own page downloads the file, so it never appears in the listing; the browser hands its
    // bytes over instead, and this is the door that writes it where the watch is looking.
    const accepted = await app.request(`/api/siteprobe/runs/${job.id}/selection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'selection_kakao.json',
        content: JSON.stringify({ source_site: 'demo.test', selected_source_ids: ['42', '43'] }),
      }),
    });
    expect(accepted.status).toBe(200);
    const snapshot = await accepted.json() as { selection: string | null };
    expect(snapshot.selection).toBe(join(listing, 'selection_kakao.json'));
    expect(readFileSync(String(snapshot.selection), 'utf8')).toContain('43');

    // A name is data, not a path: only its base survives, and the prefix the watch looks for is added.
    const named = await app.request(`/api/siteprobe/runs/${job.id}/selection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ['..', '..', 'evil.json'].join(String.fromCharCode(92)),
        content: '{"selected_source_ids":[]}',
      }),
    });
    expect(named.status).toBe(200);
    expect((await named.json() as { selection: string }).selection.startsWith(listing)).toBe(true);

    // A file that is not a selection is refused, with the reason, rather than waiting an hour.
    const notJson = await app.request(`/api/siteprobe/runs/${job.id}/selection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x.json', content: 'not json at all' }),
    });
    expect(notJson.status).toBe(400);
    await expect(notJson.json()).resolves.toMatchObject({
      error: { message: 'That file is not JSON' },
    });

    // And a run that has no review page has nowhere to put one.
    const plain = await app.request('/api/siteprobe/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'https://demo.test/work/42' }),
    });
    const plainJob = await plain.json() as { id: string };
    const refused = await app.request(`/api/siteprobe/runs/${plainJob.id}/selection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x.json', content: '{}' }),
    });
    expect(refused.status).toBe(400);

    const unknown = await app.request('/api/siteprobe/runs/no-such-run/selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x.json', content: '{}' }),
    });
    expect(unknown.status).toBe(404);
  });

  it('reads a listing that carries only ids, with each work beside it', async () => {
    const { app, home } = await testApp();
    const listing = join(home, 'export', 'demo_test', 'listing_ids');
    await mkdir(join(listing, 'items', '7'), { recursive: true });
    await writeFile(join(listing, 'items', '7', 'cover', 'cover.png'), 'x', 'utf8').catch(() => undefined);
    await mkdir(join(listing, 'items', '7', 'cover'), { recursive: true });
    await writeFile(join(listing, 'items', '7', 'cover', 'cover.png'), 'not-an-image', 'utf8');
    // The shape the tool writes for a site whose adapter declares no manifest of its own — a learned
    // rule set. T³ answered it with `Unsupported site_probe export format` while a finished crawl sat
    // on disk (measured on a real manwa.me work, 2026-09-22).
    await writeFile(join(listing, 'metadata.json'), JSON.stringify({
      source_site: 'demo.test',
      items: ['7', '8'],
      item_count: 2,
      origin: { kind: 'work', ref: '7' },
    }), 'utf8');
    await writeFile(join(listing, 'items', '7', 'metadata.json'), JSON.stringify({
      source_site: 'demo.test',
      source_id: '7',
      title: 'A work named in the listing',
      detail_url: 'https://demo.test/work/7',
      分类信息: { 作品: [], 登场人物: [], 分类标签: ['demo'], 作者: [] },
      cover: { local_path: 'items/7/cover/cover.png' },
    }), 'utf8');

    const response = await app.request('/api/imports/site-probe/preview-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadataPath: join(listing, 'metadata.json') }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      batch: { source: string; entries: Array<Record<string, unknown>>; warnings: string[] };
    };
    expect(body.batch.source).toBe('demo.test');
    expect(body.batch.entries).toHaveLength(1);
    expect(body.batch.entries[0]).toMatchObject({
      externalKey: 'demo.test:7',
      title: 'A work named in the listing',
      // Absolute, because the commit reads the media from where the crawl wrote it.
      cover: join(listing, 'items', '7', 'cover', 'cover.png'),
    });
    // A listing that names a work it does not carry is a finding about the export, not a silent drop.
    expect(body.batch.warnings.join(' ')).toContain('8');
  });

  it('previews it from a path, and refuses every path outside the export root', async () => {
    const { app, home, dataDir } = await testApp();
    const exportDir = join(home, 'export', 'demo_test', 'listing_x');
    await mkdir(exportDir, { recursive: true });
    await writeFile(join(exportDir, 'metadata.json'), JSON.stringify(exportDocument()), 'utf8');

    const ok = await app.request('/api/imports/site-probe/preview-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadataPath: join(exportDir, 'metadata.json') }),
    });
    expect(ok.status).toBe(200);
    const preview = await ok.json() as { batch: { entries: unknown[] }; source: string };
    expect(preview.source).toBe('demo.test');
    expect(preview.batch.entries).toHaveLength(1);

    for (const outside of [join(dataDir, 'library.db'), 'relative/metadata.json',
                           join(exportDir, '..', '..', '..', 'outside.json')]) {
      const rejected = await app.request('/api/imports/site-probe/preview-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadataPath: outside }),
      });
      expect(rejected.status, outside).toBe(400);
    }
  });

  it('commits it, and the batch origin reaches the crawl cursor', async () => {
    const { app, home, mapping } = await testApp();
    const exportDir = join(home, 'export', 'demo_test', 'listing_x');
    await mkdir(exportDir, { recursive: true });
    await writeFile(join(exportDir, 'metadata.json'), JSON.stringify(exportDocument()), 'utf8');

    const previewResponse = await app.request('/api/imports/site-probe/preview-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadataPath: join(exportDir, 'metadata.json') }),
    });
    const preview = await previewResponse.json() as { batch: unknown };
    const commit = await app.request('/api/imports/commit-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch: preview.batch, mapping }),
    });
    expect(commit.status).toBe(201);
    const result = await commit.json() as { entryCount: number; mediaStoredCount?: number };
    expect(result.entryCount).toBe(1);

    // The cursor is the whole point of the round trip: it only advances when the batch carries its
    // origin (migration 021), and nothing else in this flow would have recorded it.
    const database = databases[databases.length - 1]!;
    const sources = listSiteCrawlSources(database);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ sourceKind: 'search', sourceRef: 'x', sourceSite: 'demo.test' });
  });

  it('names a cover that is missing instead of claiming it was stored', async () => {
    const { app, home, mapping } = await testApp();
    const exportDir = join(home, 'export', 'demo_test', 'listing_x');
    await mkdir(exportDir, { recursive: true });
    const document = exportDocument();
    // The record claims a cover; the file is not there. This is the failure that once produced 53
    // records with 20 covers missing while the export looked complete.
    await writeFile(join(exportDir, 'metadata.json'), JSON.stringify(document), 'utf8');

    const previewResponse = await app.request('/api/imports/site-probe/preview-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadataPath: join(exportDir, 'metadata.json') }),
    });
    const preview = await previewResponse.json() as { batch: unknown };
    const commit = await app.request('/api/imports/commit-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch: preview.batch, mapping }),
    });
    const result = await commit.json() as { mediaStoredCount?: number; mediaWarnings?: string[] };
    expect(result.mediaStoredCount).toBe(0);
    expect(result.mediaWarnings?.[0]).toContain('cover');
  });

  it('stores every preview in the export order, and a cover listed again as a preview once', async () => {
    const { app, home, mapping } = await testApp();
    const exportDir = join(home, 'export', 'demo_test', 'listing_media');
    const coverFile = join(exportDir, 'items', '7', 'cover', 'cover.png');
    await mkdir(join(exportDir, 'items', '7', 'previews'), { recursive: true });
    await mkdir(join(exportDir, 'items', '7', 'cover'), { recursive: true });
    // Real, decodable pictures: the store renders a thumbnail of each one.
    const cover = await sharp({ create: { width: 4, height: 4, channels: 3,
                                          background: { r: 200, g: 30, b: 30 } } }).png().toBuffer();
    const other = await sharp({ create: { width: 4, height: 4, channels: 3,
                                          background: { r: 30, g: 120, b: 200 } } }).png().toBuffer();
    await writeFile(coverFile, cover);
    // The first preview is the cover arriving a second time under another address — the shape a
    // site whose previews container holds the cover produces.
    await writeFile(join(exportDir, 'items', '7', 'previews', '00001.png'), cover);
    await writeFile(join(exportDir, 'items', '7', 'previews', '00002.png'), other);
    await writeFile(join(exportDir, 'items', '7', 'previews', '00003.png'), other);
    await writeFile(join(exportDir, 'metadata.json'), JSON.stringify({
      source_site: 'demo.test',
      items: [{
        source_site: 'demo.test',
        source_id: '7',
        title: 'A work with three pictures',
        detail_url: 'https://demo.test/work/7',
        分类信息: { 作品: [], 登场人物: [], 分类标签: [], 作者: [] },
        cover: { local_path: 'items/7/cover/cover.png' },
        preview_images: [
          { local_path: 'items/7/previews/00001.png' },
          { local_path: 'items/7/previews/00002.png' },
          { local_path: 'items/7/previews/00003.png' },
        ],
      }],
    }), 'utf8');

    const previewResponse = await app.request('/api/imports/site-probe/preview-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadataPath: join(exportDir, 'metadata.json') }),
    });
    const preview = await previewResponse.json() as { batch: unknown };
    const commit = await app.request('/api/imports/commit-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch: preview.batch, mapping }),
    });
    expect(commit.status).toBe(201);
    const result = await commit.json() as {
      entries: Array<{ entryId: number }>;
      mediaStoredCount?: number;
      mediaDuplicateCount?: number;
      mediaWarnings?: string[];
    };
    // The cover and the two distinct pictures — not only the first preview, which is what the
    // Entry's stack used to be limited to however many the crawl had read.
    expect(result.mediaWarnings).toEqual([]);
    expect(result.mediaStoredCount).toBe(3);
    expect(result.mediaDuplicateCount).toBe(1);

    const entryId = result.entries[0]?.entryId;
    expect(entryId).toBeDefined();
    const entry = getEntryDetail(databases[databases.length - 1]!, entryId!);
    expect(entry?.coverRef).toBe(`/api/assets/entries/${entryId}/cover.png`);
    expect(entry?.previewRefs).toEqual([
      `/api/assets/entries/${entryId}/preview.png`,
      `/api/assets/entries/${entryId}/preview-2.png`,
    ]);
  });
});

/** One work of the stub site, with the export-shaped keys `loadSiteProbeExport` reads. */
function exportDocument(): unknown {
  return {
    source_site: 'demo.test',
    origin: { kind: 'search', ref: 'x' },
    items: [
      {
        source_site: 'demo.test',
        source_id: '42',
        title: 'A demo work',
        detail_url: 'https://demo.test/work/42',
        分类信息: { 作品: [], 登场人物: [], 分类标签: ['demo'], 作者: [] },
        cover: { local_path: 'items/42/cover/cover.jpg' },
      },
    ],
  };
}

async function pollRun(
  app: ReturnType<typeof createApiApp>,
  id: string,
  predicate: (run: {
    status: string; selection: string | null;
    result: { export: string | null; review_html: string | null } | null;
    events: Array<{ event: string }>;
  }) => boolean,
  timeoutMs = 8000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await app.request(`/api/siteprobe/runs/${id}`);
    const run = await response.json() as Parameters<typeof predicate>[0];
    if (predicate(run)) return run;
    if (Date.now() > deadline) throw new Error(`run did not settle: ${JSON.stringify(run)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
