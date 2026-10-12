import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { SiteprobeRun } from '@t3/shared';
import { createSiteprobeJobStore, type SiteprobeJobStore } from '../../src/siteprobe/jobs.js';
import { loadSiteProbeExport } from '../../src/import/site-probe.js';

// Replay the result shape rejected by the running server for the newly learned manwa rule.
// No existing adapter is executed, no live library is opened, and all files are disposable.
const directories: string[] = [];
const stores: SiteprobeJobStore[] = [];
afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function replay(lines: unknown[]): Promise<SiteprobeRun> {
  const directory = await mkdtemp(join(tmpdir(), 't3-manwa-contract-'));
  directories.push(directory);
  const script = join(directory, 'emit.mjs');
  await writeFile(script, `for (const line of ${JSON.stringify(lines)}) console.log(JSON.stringify(line));`);
  const store = createSiteprobeJobStore({ tooling: {
    tool: directory, python: process.execPath, pythonArgs: [script], linkArgs: [script],
    buildArgs: [script], listingArgs: [script], home: directory, ok: true, detail: null,
  } });
  stores.push(store);
  const started = store.start({ input: 'https://manwa.me/book/525805' });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = store.get(started.id)!;
    if (snapshot.status !== 'running') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The fixture process did not finish');
}

it('accepts the new manwa result, retains its export, and parses one work with its local cover', async () => {
  const listing = await mkdtemp(join(tmpdir(), 't3-manwa-export-'));
  directories.push(listing);
  const itemRoot = join(listing, 'items', '525805');
  await mkdir(join(itemRoot, 'cover'), { recursive: true });
  const coverPath = join(itemRoot, 'cover', 'cover.jpg');
  await writeFile(coverPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await writeFile(join(itemRoot, 'metadata.json'), JSON.stringify({
    source_site: 'manwa.me', source_id: '525805', title: '霸气小厨娘：想吃就挠墙',
    detail_url: 'https://manwa.me/book/525805', author: '最梦', date_added: '2026-10-11',
    description: '现代餐厅老板南叶意外穿越。',
    cover: { url: 'https://mwappimgs.cc/static/upload3/book/id/525805/cover_1.jpg?v=1786890999',
      local_path: 'items/525805/cover/cover.jpg', stored_filename: 'cover.jpg' },
  }));
  const metadataPath = join(listing, 'metadata.json');
  const origin = { kind: 'work', ref: '525805', url: 'https://manwa.me/book/525805' };
  await writeFile(metadataPath, JSON.stringify({ source_site: 'manwa.me', items: ['525805'], origin }));
  const snapshot = await replay([{ event: 'progress', message: 'read 1 work document(s)' }, {
    event: 'result', command: 'run', site: 'manwa.me', kind: 'work', ref: '525805', works: 1,
    listing, export: metadataPath, review_html: null, origin,
    media: { cover: 1, previews: 0, failed: 0 }, warnings: [], findings: [],
  }]);
  expect(snapshot.status).toBe('done');
  expect(snapshot.error).toBeNull();
  expect(snapshot.result?.findings).toEqual([]);
  expect(snapshot.result?.export).toBe(metadataPath);
  const batch = await loadSiteProbeExport(snapshot.result!.export!);
  expect(batch.entries).toHaveLength(1);
  expect(batch.warnings).toEqual([]);
  expect(batch.entries[0]).toMatchObject({ externalKey: 'manwa.me:525805', cover: coverPath,
    fields: { authors: ['最梦'], description: ['现代餐厅老板南叶意外穿越。'] } });
});

it('reports a protocol mismatch as failed even when the child exits zero', async () => {
  const snapshot = await replay([{ event: 'result', findings: [] }]);
  expect(snapshot.status).toBe('failed');
  expect(snapshot.error?.code).toBe('INTERNAL');
  expect(snapshot.error?.message).toContain('Restart T³');
  expect(snapshot.result).toBeNull();
});

it('reports a zero-exit run with no result as failed instead of sending an empty export to import', async () => {
  const snapshot = await replay([{ event: 'progress', message: 'read 1 work document(s)' }]);
  expect(snapshot.status).toBe('failed');
  expect(snapshot.error?.message).toContain('without a usable result');
  expect(snapshot.result).toBeNull();
});
