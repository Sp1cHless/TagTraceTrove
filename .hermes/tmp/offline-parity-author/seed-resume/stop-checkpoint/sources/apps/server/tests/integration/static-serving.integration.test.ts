import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';

const databases: ReturnType<typeof createMigratedMemoryDatabase>[] = [];
const tempDirs: string[] = [];

function createStaticDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 't3-static-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t3 test</title><div id="app"></div>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("static works");');
  return dir;
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('static web hosting', () => {
  it('serves index.html at the root and SPA-routes fall back to it', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database, { staticRoot: createStaticDir() });

    const root = await app.request('/');
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(await root.text()).toContain('<div id="app">');

    const spaRoute = await app.request('/entries/42');
    expect(spaRoute.status).toBe(200);
    expect(await spaRoute.text()).toContain('<title>t3 test</title>');
  });

  it('serves real files before the fallback', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database, { staticRoot: createStaticDir() });

    const asset = await app.request('/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(await asset.text()).toBe('console.log("static works");');
  });

  it('never swallows /api routes: JSON stays JSON, unknown API routes stay 404', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database, { staticRoot: createStaticDir() });

    const galleries = await app.request('/api/galleries');
    expect(galleries.status).toBe(200);
    expect(galleries.headers.get('content-type')).toContain('application/json');

    const missing = await app.request('/api/definitely-not-a-route');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');
    const body = await missing.json() as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('stays API-only (JSON 404 at /) when no staticRoot is configured', async () => {
    const database = createMigratedMemoryDatabase();
    databases.push(database);
    const app = createApiApp(database);

    const response = await app.request('/');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});
