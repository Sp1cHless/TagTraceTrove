import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase, createTempFileDatabase } from '../../src/database/testing.js';
import { applyAllMigrations } from '../../src/database/migrations.js';
import type { T3Database } from '../../src/database/connection.js';
import { createApiApp } from '../../src/http/app.js';
import { createEntryContent } from '../../src/repositories/entry-content-repository.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { listEntrySources } from '../../src/repositories/source-library-repository.js';

const databases: T3Database[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function seedApp(database: T3Database) {
  for (const [title, url] of [
    ['Blue Box', 'https://hitomi.la/g/1.html'],
    ['Other Work', 'https://hitomi.la/g/2.html'],
  ] as const) {
    const entry = createEntry(database, { title, type: 'comic' });
    createEntryContent(database, {
      entryId: entry.id,
      contentType: 'Source URL',
      content: url,
      sortOrder: 0,
    });
  }
  return createApiApp(database);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('source maintenance HTTP routes', () => {
  it('exposes the Source library with the status overlay', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = seedApp(database);

    const library = await app.request('/api/source-library');
    expect(library.status).toBe(200);
    const records = await library.json() as Array<{ sourceKey: string; state: string }>;
    expect(records.find((record) => record.sourceKey === 'known:hitomi'))
      .toMatchObject({ state: 'active', statusNote: null });

    const patch = await app.request('/api/source-statuses/known:hitomi', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'invalid', note: 'site moved' }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({ sourceKey: 'known:hitomi', state: 'invalid', note: 'site moved' });

    const badPatch = await app.request('/api/source-statuses/known:hitomi', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'deleted' }),
    });
    expect(badPatch.status).toBe(400);
  });

  it('probes the target homepage and rejects unsupported targets', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const ok = await app.request('/api/source-maintenance/adapter-probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homepage: 'https://fake.test/' }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, adapterKey: 'fake', origin: 'https://fake.test' });

    const unsupported = await app.request('/api/source-maintenance/adapter-probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homepage: 'https://unknown-site.example/' }),
    });
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toMatchObject({ reason: 'unsupported' });

    const privateHost = await app.request('/api/source-maintenance/adapter-probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homepage: 'https://127.0.0.1/' }),
    });
    expect(privateHost.status).toBe(422);
    expect(await privateHost.json()).toMatchObject({ reason: 'private' });
  });

  it('runs the whole lifecycle with the QA adapter on isolated data', async () => {
    const temp = createTempFileDatabase();
    directories.push(join(temp.path, '..'));
    const database = temp.database;
    databases.push(database);
    applyAllMigrations(database);
    const app = createApiApp(database, {
      databasePath: temp.path,
      catalogProviders: [{
        key: 'fixture',
        async lookup({ value }) {
          if (value.includes('blue box')) {
            return [{
              providerId: 'fixture:blue-box',
              titles: [
                { value: 'Blue Box', kind: 'title' },
                { value: 'Ao no Hako', kind: 'romaji' },
              ],
              creators: ['MIURA Kouji'],
              externalIds: { fixture: 'blue-box' },
            }];
          }
          return [];
        },
      }],
    });
    for (const [title, url] of [
      ['Blue Box', 'https://hitomi.la/g/1.html'],
      ['Other Work', 'https://hitomi.la/g/2.html'],
    ] as const) {
      const entry = createEntry(database, { title, type: 'comic' });
      createEntryContent(database, {
        entryId: entry.id,
        contentType: 'Source URL',
        content: url,
        sortOrder: 0,
      });
    }

    const created = await app.request('/api/source-maintenance/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originSourceKey: 'known:hitomi',
        adapterKey: 'fake',
        targetHomepage: 'https://fake.test/',
        markOriginInvalid: true,
      }),
    });
    expect(created.status).toBe(201);
    const run = await created.json() as { id: number; status: string };
    expect(run.status).toBe('draft');

    const started = await app.request(`/api/source-maintenance/runs/${run.id}/start`, { method: 'POST' });
    expect(started.status).toBe(200);

    // The QA adapter completes quickly; poll until the run reaches review.
    let status = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await sleep(20);
      const current = await app.request(`/api/source-maintenance/runs/${run.id}`);
      status = (await current.json() as { status: string }).status;
      if (status === 'review') break;
    }
    expect(status).toBe('review');

    const items = await app.request(`/api/source-maintenance/runs/${run.id}/items?state=all`);
    expect(items.status).toBe(200);
    const page = await items.json() as {
      items: Array<{ entryId: number; entryTitleSnapshot: string; candidates: Array<{ band: string; url: string }>; selectedUrl: string | null }>;
      total: number;
    };
    expect(page.total).toBe(2);
    const blueBox = page.items.find((item) => item.entryTitleSnapshot === 'Blue Box')!;
    expect(blueBox.candidates.some((candidate) => candidate.band === 'exact-safe')).toBe(true);
    expect(blueBox.selectedUrl).toBe('https://fake.test/work/100');

    await app.request(`/api/source-maintenance/runs/${run.id}/items/${blueBox.entryId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'accept', selectedUrl: blueBox.selectedUrl }),
    });
    const other = page.items.find((item) => item.entryTitleSnapshot === 'Other Work')!;
    const patched = await app.request(`/api/source-maintenance/runs/${run.id}/items/${other.entryId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'skip' }),
    });
    expect(patched.status).toBe(200);

    const committed = await app.request(`/api/source-maintenance/runs/${run.id}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(committed.status).toBe(200);
    const commitResult = await committed.json() as { createdCount: number; originMarkedInvalid: boolean };
    expect(commitResult.createdCount).toBe(1);
    expect(commitResult.originMarkedInvalid).toBe(true);

    // Old Content untouched, new target Content live, group marked invalid.
    const entryId = blueBox.entryId;
    expect(listEntrySources(database, entryId).map((source) => source.url))
      .toEqual(['https://hitomi.la/g/1.html', 'https://fake.test/work/100']);
    const library = await app.request('/api/source-library');
    const records = await library.json() as Array<{ sourceKey: string; state: string }>;
    expect(records.find((record) => record.sourceKey === 'known:hitomi')).toMatchObject({ state: 'invalid' });
  });

  it('rejects commits for unfinished runs and unknown runs', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database, { databasePath: join(tmpdir(), 't3-source-http-noop', 'library.db') });
    seedApp(database);

    const created = await app.request('/api/source-maintenance/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originSourceKey: 'known:hitomi',
        adapterKey: 'fake',
        markOriginInvalid: false,
      }),
    });
    const run = await created.json() as { id: number };
    const commit = await app.request(`/api/source-maintenance/runs/${run.id}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(commit.status).toBe(409);

    const missing = await app.request('/api/source-maintenance/runs/999/items');
    expect(missing.status).toBe(404);
  });

  it('fails closed for unknown adapters', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);
    const created = await app.request('/api/source-maintenance/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originSourceKey: 'known:hitomi',
        adapterKey: 'unknown-site',
        markOriginInvalid: false,
      }),
    });
    expect(created.status).toBe(422);
  });
});
