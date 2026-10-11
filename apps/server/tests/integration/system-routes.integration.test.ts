import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiApp } from '../../src/http/app.js';
import { openDatabase } from '../../src/database/connection.js';
import { applyAllMigrations } from '../../src/database/migrations.js';
import {
  applyStagedRestore,
  createBackup,
  listBackups,
  readStagedRestore,
  readSystemSettings,
  registerSystemRoutes,
  writeSystemSettings,
} from '../../src/http/system-routes.js';
import type { T3Database } from '../../src/database/connection.js';

/**
 * The System page's own surface. Everything here runs against a temporary library: the real
 * `.data/library.db` is never opened, copied or replaced by a test.
 */
interface Fixture {
  database: T3Database;
  databasePath: string;
  dataDir: string;
  logPath: string;
  cleanup: () => void;
}

const fixtures: Fixture[] = [];

function makeFixture(): Fixture {
  const root = join(tmpdir(), `t3-system-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const databasePath = join(dataDir, 'library.db');
  const database = openDatabase(databasePath);
  applyAllMigrations(database);
  database.prepare("INSERT INTO entries (title, type) VALUES ('A work', 'comic')").run();
  const logPath = join(root, 't3-server.log');
  writeFileSync(logPath, `[start] first\nError: SQLITE_BUSY at somewhere\n`);
  const fixture: Fixture = {
    database,
    databasePath,
    dataDir,
    logPath,
    cleanup: () => {
      database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

function systemApp(fixture: Fixture) {
  const app = createApiApp(fixture.database, {
    dataDir: fixture.dataDir,
    databasePath: fixture.databasePath,
    systemLogPath: fixture.logPath,
  });
  return app;
}

describe('the system surface', () => {
  it('reports the desktop log tail, its paths and its settings', async () => {
    const fixture = makeFixture();
    const response = await systemApp(fixture).request('/api/system/diagnostics');
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.logPath).toBe(fixture.logPath);
    expect(String(body.logTail)).toContain('SQLITE_BUSY');
    expect(body.databasePath).toBe(fixture.databasePath);
    expect(body.settings).toEqual({ autoAllowMobileConnection: true });
    expect(body.stagedRestore).toBeNull();
  });

  it('keeps phone access on when the settings file is absent, and follows what it says', async () => {
    const fixture = makeFixture();
    expect(readSystemSettings(fixture.dataDir).settings.autoAllowMobileConnection).toBe(true);

    const app = systemApp(fixture);
    const saved = await app.request('/api/system/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoAllowMobileConnection: false }),
    });
    expect(saved.status).toBe(200);
    expect(readSystemSettings(fixture.dataDir).settings.autoAllowMobileConnection).toBe(false);

    const reread = await (await app.request('/api/system/settings')).json() as { settings: { autoAllowMobileConnection: boolean } };
    expect(reread.settings.autoAllowMobileConnection).toBe(false);

    // A stored file that cannot be parsed must not silently turn phone access on or off by halves.
    writeFileSync(join(fixture.dataDir, 't3-settings.json'), '{ not json');
    const broken = readSystemSettings(fixture.dataDir);
    expect(broken.problem).not.toBeNull();
    expect(broken.settings.autoAllowMobileConnection).toBe(true);

    const rejected = await app.request('/api/system/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoAllowMobileConnection: false, somethingElse: 1 }),
    });
    expect(rejected.status).toBe(400);
  });

  it('backs the library up, lists it, serves it for export and removes it', async () => {
    const fixture = makeFixture();
    const app = systemApp(fixture);

    const created = await app.request('/api/system/backups', { method: 'POST' });
    expect(created.status).toBe(200);
    const { backup } = await created.json() as { backup: { name: string; entryCount: number; bytes: number } };
    expect(backup.entryCount).toBe(1);
    expect(backup.bytes).toBeGreaterThan(0);
    expect(existsSync(join(fixture.dataDir, 'backups', backup.name))).toBe(true);

    const listed = await (await app.request('/api/system/backups')).json() as { backups: Array<{ name: string }> };
    expect(listed.backups.map((row) => row.name)).toEqual([backup.name]);

    const exported = await app.request(`/api/system/backups/${backup.name}`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-disposition')).toContain(backup.name);
    const bytes = new Uint8Array(await exported.arrayBuffer());
    // A SQLite file, not an empty or JSON body.
    expect(new TextDecoder().decode(bytes.subarray(0, 15))).toBe('SQLite format 3');

    // Only names the server produced are reachable: a traversal is resolved away by the router
    // before the handler sees it, and anything that is not a backup name is refused by it.
    expect((await app.request('/api/system/backups/..%2F..%2Flibrary.db')).status).not.toBe(200);
    expect((await app.request('/api/system/backups/library.db')).status).toBe(400);

    const removed = await app.request(`/api/system/backups/${backup.name}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(listBackups(fixture.dataDir)).toEqual([]);
  });

  it('stages an uploaded library and applies it at the next start, keeping what it replaced', async () => {
    const fixture = makeFixture();
    // A second library, standing in for the file someone uploads.
    const otherRoot = join(tmpdir(), `t3-system-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(otherRoot, { recursive: true });
    const otherPath = join(otherRoot, 'library.db');
    const other = openDatabase(otherPath);
    applyAllMigrations(other);
    other.prepare("INSERT INTO entries (title, type) VALUES ('From the backup', 'comic')").run();
    other.prepare("INSERT INTO entries (title, type) VALUES ('Second work', 'comic')").run();
    other.close();

    const app = systemApp(fixture);
    const form = new FormData();
    form.set('file', new File([readFileSync(otherPath)], 'library.db', { type: 'application/vnd.sqlite3' }));
    const response = await app.request('/api/system/restore', { method: 'POST', body: form });
    expect(response.status).toBe(200);
    const body = await response.json() as { staged: { entryCount: number }; restartRequired: boolean };
    expect(body.restartRequired).toBe(true);
    expect(body.staged.entryCount).toBe(2);
    // Staged, not applied: the live library is untouched until the restart.
    expect(readStagedRestore(fixture.dataDir)?.entryCount).toBe(2);
    fixture.database.close();

    const applied = applyStagedRestore(fixture.dataDir, fixture.databasePath);
    expect(applied?.entryCount).toBe(2);
    expect(applied?.preRestoreBackup).not.toBeNull();
    expect(existsSync(applied!.preRestoreBackup!)).toBe(true);
    expect(readStagedRestore(fixture.dataDir)).toBeNull();

    const reopened = openDatabase(fixture.databasePath);
    try {
      const count = reopened.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number };
      expect(count.n).toBe(2);
      // The library that was replaced is itself recoverable.
      const replaced = openDatabase(applied!.preRestoreBackup!);
      try {
        const replacedCount = replaced.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number };
        expect(replacedCount.n).toBe(1);
      } finally {
        replaced.close();
      }
    } finally {
      reopened.close();
    }
    rmSync(otherRoot, { recursive: true, force: true });
  });

  it('refuses an upload that is not a library database', async () => {
    const fixture = makeFixture();
    const app = systemApp(fixture);
    const form = new FormData();
    form.set('file', new File([new TextEncoder().encode('not a database')], 'notes.txt', { type: 'text/plain' }));
    const response = await app.request('/api/system/restore', { method: 'POST', body: form });
    expect(response.status).toBe(400);
    expect(readStagedRestore(fixture.dataDir)).toBeNull();
  });

  it('keeps the two file-level helpers honest about what they read and write', async () => {
    const fixture = makeFixture();
    writeSystemSettings(fixture.dataDir, { autoAllowMobileConnection: false });
    expect(JSON.parse(readFileSync(join(fixture.dataDir, 't3-settings.json'), 'utf8')))
      .toEqual({ autoAllowMobileConnection: false });

    const created = await createBackup(fixture.database, fixture.dataDir);
    expect(created.name).toMatch(/^library-\d{8}T\d{6}\.db$/u);
    expect(listBackups(fixture.dataDir).map((row) => row.name)).toEqual([created.name]);

    // A stray file in the backups directory is not offered as a backup.
    writeFileSync(join(fixture.dataDir, 'backups', 'notes.txt'), 'x');
    expect(listBackups(fixture.dataDir).map((row) => row.name)).toEqual([created.name]);

    // A restore staged for a different directory is not picked up by this one.
    const elsewhere = join(fixture.dataDir, 'somewhere-else');
    mkdirSync(elsewhere, { recursive: true });
    expect(applyStagedRestore(elsewhere, fixture.databasePath)).toBeNull();

    const routes = new Set<string>();
    const app = { get: (path: string) => routes.add(`GET ${path}`), post: (path: string) => routes.add(`POST ${path}`), put: (path: string) => routes.add(`PUT ${path}`), delete: (path: string) => routes.add(`DELETE ${path}`) } as never;
    registerSystemRoutes(app, { database: fixture.database, dataDir: fixture.dataDir });
    expect([...routes].sort()).toEqual([
      'DELETE /api/system/backups/:name',
      'GET /api/system/backups',
      'GET /api/system/backups/:name',
      'GET /api/system/diagnostics',
      'GET /api/system/settings',
      'POST /api/system/backups',
      'POST /api/system/restore',
      'PUT /api/system/settings',
    ]);
  });
});
