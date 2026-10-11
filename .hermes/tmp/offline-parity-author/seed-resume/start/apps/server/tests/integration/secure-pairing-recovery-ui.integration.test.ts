import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { startPairedApiServers } from '../../src/http/paired-server.js';
// A PID can be reused by an unrelated process, which makes a dead owner look
// alive. That used to abort startup entirely, so neither the desktop page nor
// the recovery form was reachable; the launcher's whole job is to bring the
// service up, so a lock problem has to degrade instead of kill it.
it('serves the desktop API and the recovery form when the recorded owner only looks alive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 't3-desktop-live-lock-'));
  const database = createMigratedMemoryDatabase();
  const options = { database, assetRoot: join(directory, 'assets'), configDirectory: join(directory, 'auth'), advertisedHost: '192.168.1.2', secureHostname: '127.0.0.1' };
  let runtime: Awaited<ReturnType<typeof startPairedApiServers>> | undefined;
  try {
    runtime = await startPairedApiServers(options);
    await runtime.close();
    runtime = undefined;
    await writeFile(join(options.configDirectory, 'listener.lock'), String(process.pid));
    runtime = await startPairedApiServers(options);
    const origin = runtime.origin;
    const status = await fetch(origin + '/api/pairing/status', { headers: { origin } });
    expect(status.status).toBe(200);
    const state = await status.json() as { csrf: string; devices: unknown[]; recovery: { libraryId: string; message: string } };
    expect(state.devices).toEqual([]);
    expect(state.recovery.message).toContain('live owner');
    // The desktop page itself keeps working, which is what lets an operator
    // reach Settings and act.
    expect((await fetch(origin + '/api/galleries', { headers: { origin } })).status).toBe(200);
    expect((await fetch(origin + '/api/pairing/recover', { method: 'POST', headers: { origin, 'x-t3-csrf': state.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ libraryId: state.recovery.libraryId, ownerPid: process.pid, action: 'recover-lock' }) })).status).toBe(409);
  } finally { await runtime?.close(); database.close(); await rm(directory, { recursive: true, force: true }); }
});

/** A lock written by this version records the owner's loopback port next to its
 * PID; that port is what proves the owner is gone. */
async function bindLoopback(): Promise<{ port: number; close: () => void }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => server.close() };
}

it('takes the listener over when the recorded owner is gone, without an operator step', async () => {
  const directory = await mkdtemp(join(tmpdir(), 't3-desktop-stale-owner-'));
  const database = createMigratedMemoryDatabase();
  const options = { database, assetRoot: join(directory, 'assets'), configDirectory: join(directory, 'auth'), advertisedHost: '192.168.1.2', secureHostname: '127.0.0.1' };
  let runtime: Awaited<ReturnType<typeof startPairedApiServers>> | undefined;
  const released = await bindLoopback();
  released.close();
  try {
    await mkdir(options.configDirectory, { recursive: true });
    await writeFile(join(options.configDirectory, 'listener.lock'), `999999 ${released.port}`);
    runtime = await startPairedApiServers(options);
    const origin = runtime.origin;
    const state = await (await fetch(origin + '/api/pairing/status', { headers: { origin } })).json() as { recovery: unknown; devices: unknown[] };
    expect(state.recovery).toBeNull();
    // The listener is serving, and the lock now belongs to this process.
    expect(runtime.secureEndpoint).toBeTruthy();
    const lock = readFileSync(join(options.configDirectory, 'listener.lock'), 'utf8').trim();
    expect(lock).toMatch(/^[1-9][0-9]* [1-9][0-9]*$/u);
    expect(Number(lock.split(' ')[0])).toBe(process.pid);
  } finally { await runtime?.close(); database.close(); await rm(directory, { recursive: true, force: true }); }
});

it('refuses the listener while another process still holds the recorded ownership port', async () => {
  const directory = await mkdtemp(join(tmpdir(), 't3-desktop-live-port-'));
  const database = createMigratedMemoryDatabase();
  const options = { database, assetRoot: join(directory, 'assets'), configDirectory: join(directory, 'auth'), advertisedHost: '192.168.1.2', secureHostname: '127.0.0.1' };
  let runtime: Awaited<ReturnType<typeof startPairedApiServers>> | undefined;
  const held = await bindLoopback();
  try {
    await mkdir(options.configDirectory, { recursive: true });
    await writeFile(join(options.configDirectory, 'listener.lock'), `999999 ${held.port}`);
    runtime = await startPairedApiServers(options);
    const origin = runtime.origin;
    const state = await (await fetch(origin + '/api/pairing/status', { headers: { origin } })).json() as { recovery: { message: string } | null };
    expect(state.recovery?.message).toContain('live owner');
    expect(runtime.secureEndpoint).toBeNull();
  } finally { held.close(); await runtime?.close(); database.close(); await rm(directory, { recursive: true, force: true }); }
});

it('keeps only loopback recovery UI after crash with exact confirmation and CSRF', async () => {
 const directory = await mkdtemp(join(tmpdir(), 't3-desktop-recovery-'));
 const database = createMigratedMemoryDatabase();
 const options = { database, assetRoot: join(directory, 'assets'), configDirectory: join(directory, 'auth'), advertisedHost: '192.168.1.2', secureHostname: '127.0.0.1' };
 let runtime: Awaited<ReturnType<typeof startPairedApiServers>> | undefined;
 try {
  runtime = await startPairedApiServers(options); await runtime.close(); runtime = undefined;
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']); const pid = child.pid!;
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
  await writeFile(join(options.configDirectory, 'listener.lock'), String(pid));
  runtime = await startPairedApiServers(options);
  const origin = runtime.origin;
  const state = await (await fetch(origin + '/api/pairing/status', { headers: { origin } })).json() as { csrf: string; recovery: { libraryId: string } };
  expect(state.recovery.libraryId).toBeTruthy();
  const body = JSON.stringify({ libraryId: state.recovery.libraryId, ownerPid: pid, action: 'recover-lock' });
  expect((await fetch(origin + '/api/pairing/recover', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body })).status).toBe(403);
  expect((await fetch(origin + '/api/pairing/recover', { method: 'POST', headers: { origin: 'https://evil.test', 'x-t3-csrf': state.csrf, 'content-type': 'application/json' }, body })).status).toBe(403);
  expect((await fetch(origin + '/api/pairing/recover', { method: 'POST', headers: { origin, 'x-t3-csrf': state.csrf, 'content-type': 'application/json' }, body })).status).toBe(200);
 } finally { await runtime?.close(); database.close(); await rm(directory, { recursive: true, force: true }); }
});
