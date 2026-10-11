import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { startPairedApiServers } from '../../src/http/paired-server.js';
it('protects identity reset behind stopped-owner local CSRF confirmation and leaves unrelated library bytes intact', async () => {
 const directory = await mkdtemp(join(tmpdir(), 't3-identity-recovery-'));
 const database = createMigratedMemoryDatabase();
 const options = { database, assetRoot: join(directory, 'assets'), configDirectory: join(directory, 'auth'), advertisedHost: '192.168.1.2', secureHostname: '127.0.0.1' };
 let runtime: Awaited<ReturnType<typeof startPairedApiServers>> | undefined;
 try {
  await writeFile(join(directory, 'library-sentinel'), 'user-library-bytes');
  runtime = await startPairedApiServers(options);
  const originalCert = await readFile(join(options.configDirectory, 'tls-certificate.pem'), 'utf8');
  const origin = runtime.origin;
  const status = await (await fetch(origin + '/api/pairing/status', { headers: { origin } })).json() as { csrf: string };
  expect((await fetch(origin + '/api/pairing/recover', { method: 'POST', headers: { origin, 'x-t3-csrf': status.csrf }, body: '{}' })).status).toBe(403);
  await runtime.close(); runtime = undefined;
  const authPath = join(options.configDirectory, 'authorization.json');
  const state = JSON.parse(await readFile(authPath, 'utf8')) as { libraryId: string };
  state.libraryId = 'different-library'; await writeFile(authPath, JSON.stringify(state));
  runtime = await startPairedApiServers(options);
  const recoveryOrigin = runtime.origin;
  const recovery = await (await fetch(recoveryOrigin + '/api/pairing/status', { headers: { origin: recoveryOrigin } })).json() as { csrf: string; recovery: { libraryId: string } };
  const body = JSON.stringify({ libraryId: recovery.recovery.libraryId, ownerPid: 0, action: 'reset-identity' });
  expect((await fetch(recoveryOrigin + '/api/pairing/recover', { method: 'POST', headers: { origin: 'https://evil.test', 'x-t3-csrf': recovery.csrf }, body })).status).toBe(403);
  expect((await fetch(recoveryOrigin + '/api/pairing/recover', { method: 'POST', headers: { origin: recoveryOrigin, 'x-t3-csrf': recovery.csrf, 'content-type': 'application/json' }, body })).status).toBe(200);
  expect(await readFile(join(options.configDirectory, 'tls-certificate.pem'), 'utf8')).not.toBe(originalCert);
  expect(await readFile(join(directory, 'library-sentinel'), 'utf8')).toBe('user-library-bytes');
 } finally { await runtime?.close(); database.close(); await rm(directory, { recursive: true, force: true }); }
});
