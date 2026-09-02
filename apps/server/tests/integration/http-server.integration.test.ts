import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startApiServer, type ApiServerRuntime } from '../../src/http/server.js';

const runtimes: ApiServerRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('HTTP server runtime', () => {
  it('migrates a temporary database and serves the API on a real socket', async () => {
    const directory = mkdtempSync(join(tmpdir(), 't3-http-test-'));
    directories.push(directory);
    const runtime = await startApiServer({
      databasePath: join(directory, 'library.db'),
      hostname: '127.0.0.1',
      port: 0,
    });
    runtimes.push(runtime);

    const response = await fetch(`${runtime.origin}/api/entries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Endfield', type: 'game' }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ title: 'Endfield', type: 'game' });
  });
});
