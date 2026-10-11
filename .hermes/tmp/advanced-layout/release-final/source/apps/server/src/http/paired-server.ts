import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import QRCode from 'qrcode';
import type { T3Database } from '../database/connection.js';
import { getSyncIdentity } from '../sync/sync-service.js';
import { createApiApp } from './app.js';
import { startSecurePairingListener, recoverSecurePairing } from './secure-pairing.js';

export interface PairedApiServersOptions {
  database: T3Database;
  fetch?: (request: Request) => Response | Promise<Response>;
  assetRoot: string;
  configDirectory: string;
  advertisedHost: string;
  secureHostname?: string;
  securePort?: number;
  desktopPort?: number;
  staticRoot?: string;
}

/** Injected database/assets only. Desktop always loopback; LAN has no unprotected HTTP listener. */
export async function startPairedApiServers(options: PairedApiServersOptions) {
  const app = options.fetch ? { fetch: options.fetch } : createApiApp(options.database, { assetRoot: options.assetRoot, dataDir: options.configDirectory, ...(options.staticRoot ? { staticRoot: options.staticRoot } : {}) });
  const secureOptions = { configDirectory: options.configDirectory,
    libraryId: getSyncIdentity(options.database).libraryId, currentLibraryId: () => getSyncIdentity(options.database).libraryId, advertisedHost: options.advertisedHost,
    hostname: options.secureHostname ?? '0.0.0.0', port: options.securePort ?? 0, fetch: app.fetch };
  let secure: Awaited<ReturnType<typeof startSecurePairingListener>> | undefined;
  let recoveryIssue: string | null = null;
  try { secure = await startSecurePairingListener(secureOptions); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    // A lock problem must never take the desktop page down with it: the operator
    // needs the running app to reach the recovery form. `live owner` belongs
    // here too — a PID that has been reused by an unrelated process looks alive
    // and used to kill the whole server on startup.
    if (!/exited unexpectedly|live owner|identity changed|Incomplete TLS identity|Missing TLS identity|Invalid authorization owner lock/.test(message)) throw error;
    recoveryIssue = message;
  }
  const csrf = randomBytes(32).toString('base64url');
  let origin = '';
  const forbidden = () => Response.json({ error: { code: 'FORBIDDEN', message: 'Use the local desktop Settings' } }, { status: 403 });
  try {
    const desktop = serve({ hostname: '127.0.0.1', port: options.desktopPort ?? 0, fetch: async request => {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/pairing/')) return app.fetch(request);
      // Host guards DNS rebinding; Origin + unpredictable header guards CSRF. No CORS on administration.
      const originHeader = request.headers.get('origin');
      const localRead = !originHeader && request.method === 'GET' && request.headers.get('sec-fetch-site') === 'same-origin' && request.headers.get('x-t3-desktop') === '1';
      if (url.origin !== origin || !(originHeader === origin || localRead)) return forbidden();
      if (request.method === 'GET' && url.pathname === '/api/pairing/status') return Response.json({ enabled: true, csrf, devices: secure?.devices() ?? [], recovery: recoveryIssue ? { libraryId: secureOptions.libraryId, message: recoveryIssue } : null }, { headers: { 'cache-control': 'no-store' } });
      if (request.method !== 'POST' || request.headers.get('x-t3-csrf') !== csrf) return forbidden();
      if (url.pathname === '/api/pairing/recover') {
        if (secure) return forbidden(); // Never reset a running owner.
        let body: unknown; try { body = await request.json(); } catch { return forbidden(); }
        if (!body || typeof body !== 'object' || Object.keys(body).sort().join(',') !== 'action,libraryId,ownerPid') return forbidden();
        const confirmation = body as { libraryId: string; ownerPid: number; action: string };
        if (typeof confirmation.libraryId !== 'string' || typeof confirmation.ownerPid !== 'number' || typeof confirmation.action !== 'string') return forbidden();
        try {
          recoverSecurePairing(secureOptions, confirmation);
          secure = await startSecurePairingListener(secureOptions); recoveryIssue = null;
          return Response.json({ recovered: true }, { headers: { 'cache-control': 'no-store' } });
        } catch { return Response.json({ error: { message: 'Recovery refused. Verify owner PID, library identity and stopped owner; no library data was deleted.' } }, { status: 409 }); }
      }
      if (!secure) return Response.json({ error: { message: 'Explicit desktop recovery required' } }, { status: 409 });
      if (url.pathname === '/api/pairing/offer') {
        const payload = secure.issue();
        return Response.json({ payload, svg: await QRCode.toString(JSON.stringify(payload), { type: 'svg', errorCorrectionLevel: 'M' }) }, { headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/api/pairing/revoke') {
        let body: unknown; try { body = await request.json(); } catch { return forbidden(); }
        if (!body || typeof body !== 'object' || !('deviceId' in body) || typeof body.deviceId !== 'string' || Object.keys(body).length !== 1) return forbidden();
        secure.revoke(body.deviceId); return Response.json({ devices: secure.devices() }, { headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/api/pairing/forget') {
        let body: unknown; try { body = await request.json(); } catch { return forbidden(); }
        if (!body || typeof body !== 'object' || !('deviceId' in body) || typeof body.deviceId !== 'string' || Object.keys(body).length !== 1) return forbidden();
        return Response.json({ devices: secure.forget(body.deviceId) }, { headers: { 'cache-control': 'no-store' } });
      }
      return forbidden();
    } });
    if (!desktop.listening) await once(desktop, 'listening');
    origin = `http://127.0.0.1:${(desktop.address() as AddressInfo).port}`;
    return { origin, secureEndpoint: secure?.endpoint ?? null, close: async () => {
      await new Promise<void>((resolve, reject) => { desktop.close(error => error ? reject(error) : resolve()); if ('closeAllConnections' in desktop) desktop.closeAllConnections(); });
      await secure?.close();
    } };
  } catch (error) { await secure?.close(); throw error; }
}
