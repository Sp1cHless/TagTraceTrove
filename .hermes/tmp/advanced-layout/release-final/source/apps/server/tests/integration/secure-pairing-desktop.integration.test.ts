import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { startPairedApiServers } from '../../src/http/paired-server.js';

it('exposes real QR only to same-origin loopback desktop and keeps LAN issuance closed', async () => {
 const directory = await mkdtemp(join(tmpdir(), 't3-paired-desktop-'));
 const database = createMigratedMemoryDatabase();
 let runtime: Awaited<ReturnType<typeof startPairedApiServers>> | undefined;
 try {
  runtime = await startPairedApiServers({ database, assetRoot: join(directory, 'assets'), configDirectory: join(directory, 'auth'), advertisedHost: '192.168.1.2', secureHostname: '127.0.0.1' });
  const origin = runtime.origin;
  expect((await fetch(`${origin}/api/pairing/offer`, { method: 'POST', headers: { origin: 'https://evil.test' } })).status).toBe(403);
  const status = await fetch(`${origin}/api/pairing/status`, { headers: { origin } });
  const { csrf } = await status.json() as { csrf: string };
  expect((await fetch(`${origin}/api/pairing/offer`, { method: 'POST', headers: { origin } })).status).toBe(403);
  const issued = await fetch(`${origin}/api/pairing/offer`, { method: 'POST', headers: { origin, 'x-t3-csrf': csrf } });
  expect(issued.status).toBe(200);
  const offer = await issued.json() as { payload: { endpoint: string }; svg: string };
  expect(offer.payload.endpoint).toMatch(/^https:\/\/192\.168\.1\.2:/);
  expect(offer.svg).toContain('<svg');
  expect((await fetch(`${origin}/api/sync/capabilities`)).status).toBe(200);
 } finally { await runtime?.close(); database.close(); await rm(directory, { recursive: true, force: true }); }
});
