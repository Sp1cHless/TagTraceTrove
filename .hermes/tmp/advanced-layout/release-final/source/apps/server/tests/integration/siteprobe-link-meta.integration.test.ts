import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { createSiteprobeRuntime } from '../../src/siteprobe/runtime.js';

/**
 * The quick-create "try" button: one pasted link, read with no site rule.
 *
 * Driven through a stub reader, so these tests are about this server's behaviour — the verdict it
 * maps, the cover it hands back, the guard on serving that cover, and the log it writes when the
 * reader itself breaks — and never about the network or a page's markup.
 */
const STUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'siteprobe-stub.mjs');

const temporaryDirectories: string[] = [];
const databases: ReturnType<typeof createMigratedMemoryDatabase>[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function testApp() {
  const dataDir = await mkdtemp(join(tmpdir(), 't3-link-meta-'));
  temporaryDirectories.push(dataDir);
  const home = join(dataDir, 'siteprobe');
  const database = createMigratedMemoryDatabase();
  databases.push(database);
  const runtime = createSiteprobeRuntime({
    dataDir,
    overrides: {
      tool: dirname(STUB), python: process.execPath,
      pythonArgs: [STUB], linkArgs: [STUB], home,
    },
  });
  const app = createApiApp(database, {
    assetRoot: join(dataDir, 'assets'), databasePath: join(dataDir, 'library.db'),
    dataDir, siteprobeRuntime: runtime,
  });
  return { app, home, dataDir };
}

async function post(app: ReturnType<typeof createApiApp>, url: string) {
  const response = await app.request('/api/siteprobe/link-meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('reading one pasted link', () => {
  it('hands the cover over in the answer and writes nothing', async () => {
    const { app, home } = await testApp();

    const { status, body } = await post(app, 'https://demo.test/ok');
    expect(status).toBe(200);
    expect(body.verdict).toBe('found');
    expect(body.title).toBe('A fetched title');
    expect(body.coverMimeType).toBe('image/jpeg');
    expect(body.coverBytes).toBe(4);
    expect(body.coverDataUrl).toBe('data:image/jpeg;base64,/9j/2Q==');
    expect(body.logPath).toBeNull();

    // Level 0 reads and keeps nothing: no export tree, no file of any kind under the home.
    const left = await readdir(join(home, 'export')).catch(() => [] as string[]);
    expect(left).toEqual([]);
  });

  it('sends a page that needs a rule to the advanced path, not to a bug report', async () => {
    const { app } = await testApp();
    const { status, body } = await post(app, 'https://demo.test/needs-work');
    expect(status).toBe(200);
    expect(body.verdict).toBe('needs-advanced');
    expect(body.coverDataUrl).toBeNull();
    expect(body.logPath).toBeNull();
  });

  it('calls something that is not a URL what it is', async () => {
    const { app } = await testApp();
    const { body } = await post(app, 'https://demo.test/not-a-url');
    expect(body.verdict).toBe('invalid');
  });

  it('writes an error log when the reader itself breaks', async () => {
    const { app, dataDir } = await testApp();
    const { body } = await post(app, 'https://demo.test/garbage');
    expect(body.verdict).toBe('bug');
    const logPath = String(body.logPath);
    expect(logPath.startsWith(join(dataDir, 'logs'))).toBe(true);

    const log = await readFile(logPath, 'utf8');
    expect(log).toContain('kind        link-meta');
    expect(log).toContain('https://demo.test/garbage');
    expect(log).toContain('ValueError: something in the reader broke');
  });
});
