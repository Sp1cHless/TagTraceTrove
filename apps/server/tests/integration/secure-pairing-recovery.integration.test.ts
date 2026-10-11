import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import * as pairing from '../../src/http/secure-pairing.js';

it('requires explicit dead-owner recovery bound to the exact library and lock, preserving authorization', async () => {
 const directory = await mkdtemp(join(tmpdir(), 't3-recovery-'));
 const options = { configDirectory: directory, libraryId: 'recovery-library', hostname: '127.0.0.1', advertisedHost: '192.168.1.2', fetch: () => Response.json({ ok: true }) };
 try {
  const runtime = await pairing.startSecurePairingListener(options);
  runtime.issue();
  const before = await readFile(join(directory, 'authorization.json'), 'utf8');
  const recover = pairing.recoverSecurePairing;
  expect(typeof recover).toBe('function');
  expect(() => recover(options, { libraryId: options.libraryId, ownerPid: process.pid, action: 'recover-lock' })).toThrow('live owner');
  await runtime.close();
  // A real child PID, reaped before the lock is installed; no assumed magic dead PID.
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid!;
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
  await writeFile(join(directory, 'listener.lock'), String(pid));
  expect(() => recover(options, { libraryId: 'wrong', ownerPid: pid, action: 'recover-lock' })).toThrow();
  expect(() => recover(options, { libraryId: options.libraryId, ownerPid: pid + 1, action: 'recover-lock' })).toThrow();
  recover(options, { libraryId: options.libraryId, ownerPid: pid, action: 'recover-lock' });
  expect(await readFile(join(directory, 'authorization.json'), 'utf8')).toBe(before);
  const reopened = await pairing.startSecurePairingListener(options); await reopened.close();
  await writeFile(join(directory, 'listener.lock'), '');
  expect(() => recover(options, { libraryId: options.libraryId, ownerPid: 0, action: 'reset-identity' })).toThrow('Owner PID');
  expect(() => recover(options, { libraryId: options.libraryId, ownerPid: process.pid, action: 'recover-lock' })).toThrow('live owner');
  recover(options, { libraryId: options.libraryId, ownerPid: pid, action: 'recover-lock' });
  expect(await readFile(join(directory, 'authorization.json'), 'utf8')).toBe(before);
 } finally { await rm(directory, { recursive: true, force: true }); }
});
