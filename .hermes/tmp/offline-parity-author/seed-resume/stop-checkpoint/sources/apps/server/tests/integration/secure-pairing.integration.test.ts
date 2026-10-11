import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createApiApp } from '../../src/http/app.js';
import { startSecurePairingListener } from '../../src/http/secure-pairing.js';

it('claims over pinned TLS, reads the actual API, revokes and forgets authorization without touching library data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 't3-secure-pair-'));
  const database = createMigratedMemoryDatabase();
  let runtime: Awaited<ReturnType<typeof startSecurePairingListener>> | undefined;
  try {
    runtime = await startSecurePairingListener({ configDirectory: directory, libraryId: 'test-library',
      hostname: '127.0.0.1', port: 0, advertisedHost: '192.168.1.2',
      fetch: createApiApp(database, { assetRoot: join(directory, 'assets') }).fetch });
    const offer = runtime.issue();
    const call = (path: string, body?: unknown, token?: string) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = request(`${runtime!.testOrigin}${path}`, {
        method: body === undefined ? 'GET' : 'POST', ca: runtime!.certificate,
        checkServerIdentity: (_host, cert) => createHash('sha256').update(cert.raw).digest('hex') === offer.certificateSha256 ? undefined : new Error('Pin changed'),
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      }, (res) => {
        let bytes = ''; res.on('data', chunk => { bytes += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(bytes) as Record<string, unknown> }));
      }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    expect((await call('/api/sync/capabilities')).status).toBe(401);
    const claim = await call('/api/pairing/claim', { code: offer.code, libraryId: offer.libraryId, deviceName: 'Test phone', protocolVersion: 1 });
    expect(claim.status).toBe(201);
    const token = claim.body.token as string;
    expect((await call('/api/sync/capabilities', undefined, token)).status).toBe(200);
    runtime.revoke(claim.body.deviceId as string);
    expect((await call('/api/sync/capabilities', undefined, token)).status).toBe(401);
    expect((await call('/api/pairing/claim', { code: offer.code, libraryId: offer.libraryId, deviceName: 'Other', protocolVersion: 1 })).status).toBe(401);
    // A revoked record can be dropped for good; the dropped token stays
    // unauthorized. Forgetting a live device is refused, so the cleanup can
    // never be a way around revoking one.
    const secondOffer = runtime.issue();
    const second = await call('/api/pairing/claim', { code: secondOffer.code, libraryId: secondOffer.libraryId, deviceName: 'Second phone', protocolVersion: 1 });
    expect(second.status).toBe(201);
    const secondDeviceId = second.body.deviceId as string;
    expect(runtime.devices().some(device => device.deviceId === secondDeviceId && !device.revoked)).toBe(true);
    runtime.forget(secondDeviceId);
    expect(runtime.devices().some(device => device.deviceId === secondDeviceId)).toBe(true);
    const revokedId = claim.body.deviceId as string;
    expect(runtime.devices().some(device => device.deviceId === revokedId && device.revoked)).toBe(true);
    runtime.forget(revokedId);
    expect(runtime.devices().some(device => device.deviceId === revokedId)).toBe(false);
    expect((await call('/api/sync/capabilities', undefined, token)).status).toBe(401);
  } finally { await runtime?.close(); database.close(); await rm(directory, { recursive: true, force: true }); }
});
