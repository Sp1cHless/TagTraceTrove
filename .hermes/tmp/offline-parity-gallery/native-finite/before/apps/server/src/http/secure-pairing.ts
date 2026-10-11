import { createHash, randomBytes, randomUUID, X509Certificate, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, fsyncSync, unlinkSync, chmodSync } from 'node:fs';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';

/** Operator-only recovery: never guesses owner death or removes arbitrary paths. */
export function recoverSecurePairing(options: SecurePairingOptions, confirmation: { libraryId: string; ownerPid: number; action: string }) {
  if (confirmation.libraryId !== options.libraryId || !['recover-lock', 'reset-identity'].includes(confirmation.action)) throw new Error('Confirm the exact current library and recovery action');
  const directory = resolve(options.configDirectory);
  if (lstatSync(directory).isSymbolicLink() || realpathSync(directory).toLowerCase() !== directory.toLowerCase()) throw new Error('Recovery refuses redirected configuration paths');
  for (const name of ['listener.lock', 'authorization.json', 'tls-key.pem', 'tls-certificate.pem']) {
    const path = join(directory, name);
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error('Recovery refuses non-regular authorization files');
  }
  const lock = join(directory, 'listener.lock');
  const lockExists = existsSync(lock);
  const lockBytes = lockExists ? readFileSync(lock, 'utf8') : '';
  // Both markers are readable here: `<pid> <ownership-port>` from this version,
  // or a bare `<pid>` from the one before it.
  const recorded = lockExists && lockBytes.trim() !== '' ? readOwnerLock(lock) : null;
  // A crash before PID write requires the operator's actual recorded owner PID, never a default PID.
  if (lockExists && (lockBytes.trim() !== '' && recorded === null
    || lockBytes.trim() === '' && (!Number.isSafeInteger(confirmation.ownerPid) || confirmation.ownerPid < 1))) throw new Error('Owner PID marker invalid; inject the verified actual owner PID');
  const pid = lockExists ? recorded?.pid ?? confirmation.ownerPid : 0;
  if (!Number.isSafeInteger(pid) || pid < 0 || confirmation.ownerPid !== pid) throw new Error('Owner PID changed or invalid; recovery refused');
  if (pid) {
    try { process.kill(pid, 0); throw new Error('Authorization state already has a live owner'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  const statePath = join(directory, 'authorization.json');
  const state = stateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')) as unknown);
  if (confirmation.action === 'recover-lock') {
    if (!pid || state.libraryId !== options.libraryId) throw new Error('Lock/library identity mismatch');
    unlinkSync(lock); return;
  }
  // Keep every historical token hash revoked; invalidate all outstanding QR offers.
  const host = privateHttpsHost(options.advertisedHost);
  if (!lockExists) {
    const owner = openSync(lock, 'wx', 0o600);
    try { writeFileSync(owner, String(process.pid)); fsyncSync(owner); } finally { closeSync(owner); }
  }
  const key = join(directory, `recovery-${randomUUID()}-key.pem`);
  const cert = join(directory, `recovery-${randomUUID()}-certificate.pem`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '365', '-subj', '/CN=T3 private library', '-addext', `subjectAltName=IP:${host},IP:127.0.0.1`, '-keyout', key, '-out', cert], { stdio: 'ignore', windowsHide: true });
  const certificateSha256 = createHash('sha256').update(new X509Certificate(readFileSync(cert)).raw).digest('hex');
  const candidate = { ...state, libraryId: options.libraryId, certificateSha256, offers: [], sessions: state.sessions.map(session => ({ ...session, revoked: true })) };
  const temporary = join(directory, `authorization-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(candidate)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(key, join(directory, 'tls-key.pem')); renameSync(cert, join(directory, 'tls-certificate.pem')); renameSync(temporary, statePath);
  unlinkSync(lock);
}
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createServer as createTcpServer } from 'node:net';
import { createServer } from 'node:https';
import { serve } from '@hono/node-server';
import { z } from 'zod';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const sessionSchema = z.object({ deviceId: z.string().uuid(), deviceName: z.string().min(1).max(100), tokenHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.number().int(), revoked: z.boolean() }).strict();
const stateSchema = z.object({ version: z.literal(1), libraryId: z.string().min(1), certificateSha256: z.string().regex(/^[a-f0-9]{64}$/), sessions: z.array(sessionSchema), offers: z.array(z.object({ codeHash: z.string(), expiresAt: z.number().int() }).strict()) }).strict();
const claimSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/), libraryId: z.string(), protocolVersion: z.literal(1), deviceName: z.string().trim().min(1).max(100) }).strict();

export function privateHttpsHost(host: string): string {
  if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host)) throw new Error('Use an unambiguous private IPv4 address');
  const parts = host.split('.'); const octets = parts.map(Number);
  if (parts.some((part, index) => String(octets[index]) !== part || octets[index]! > 255)) throw new Error('Invalid IPv4 address');
  if (!(octets[0] === 10 || octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31 || octets[0] === 192 && octets[1] === 168)) throw new Error('Use a private IPv4 address');
  return host;
}

export interface SecurePairingOptions {
  configDirectory: string;
  libraryId: string;
  currentLibraryId?: () => string;
  hostname: string;
  advertisedHost: string;
  port?: number;
  now?: () => number;
  fetch: (request: Request) => Response | Promise<Response>;
}

/** Separate app-private authorization state: deliberately not library data or included in library backups.
 * One synchronous owner per listener; atomic replace completes before credentials are returned.
 * No raw session tokens or pairing codes are written to disk.
 */
const OWNER_HOST = '127.0.0.1';

interface OwnerLock { pid: number; port: number | null }

/** `<pid> <ownership-port>`, or a bare `<pid>` from a version that recorded only
 * the process. An older marker keeps the older, more cautious behaviour. */
function readOwnerLock(lockPath: string): OwnerLock | null {
  const raw = readFileSync(lockPath, 'utf8').trim();
  const match = /^(?<pid>[1-9][0-9]*)(?:\s+(?<port>[1-9][0-9]*))?$/u.exec(raw);
  if (match?.groups === undefined) return null;
  const pid = Number(match.groups.pid);
  const port = match.groups.port === undefined ? null : Number(match.groups.port);
  if (!Number.isSafeInteger(pid) || (port !== null && !Number.isSafeInteger(port))) return null;
  return { pid, port };
}

async function isLoopbackPortFree(port: number): Promise<boolean> {
  const probe = createTcpServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, OWNER_HOST, () => resolve());
    });
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

export async function startSecurePairingListener(options: SecurePairingOptions) {
  mkdirSync(options.configDirectory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') execFileSync('icacls', [options.configDirectory, '/inheritance:r', '/grant:r', `${userInfo().username}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
  else chmodSync(options.configDirectory, 0o700);
  const lockPath = join(options.configDirectory, 'listener.lock');
  if (existsSync(lockPath)) {
    const owner = readOwnerLock(lockPath);
    if (owner === null) throw new Error('Invalid authorization owner lock');
    if (owner.port !== null) {
      // An owner holds a loopback port for as long as it lives, so that port —
      // not its PID — is the liveness token: PIDs are reused (a dead owner then
      // looked alive and refused recovery forever), while a released socket
      // cannot lie. A crashed owner's port is free, so the next launch takes
      // over on its own; a running one still blocks this one.
      if (!await isLoopbackPortFree(owner.port)) throw new Error('Authorization state already has a live owner');
      unlinkSync(lockPath);
    } else {
      try { process.kill(owner.pid, 0); throw new Error('Authorization state already has a live owner'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      throw new Error('Previous authorization owner exited unexpectedly. Use local desktop Settings for explicit PID-verified recovery; authorization remains intact.');
    }
  }
  const ownership = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    ownership.once('error', reject);
    ownership.listen(0, OWNER_HOST, () => resolve());
  });
  const ownershipPort = (ownership.address() as AddressInfo).port;
  const lock = openSync(lockPath, 'wx', 0o600); writeFileSync(lock, `${process.pid} ${ownershipPort}`); fsyncSync(lock); closeSync(lock);
  try {
    const runtime = await startOwnedSecurePairingListener(options);
    let closed = false;
    return { ...runtime, async close() { if (closed) return; closed = true; try { await runtime.close(); } finally { unlinkSync(lockPath); ownership.close(); } } };
  } catch (error) { unlinkSync(lockPath); ownership.close(); throw error; }
}

async function startOwnedSecurePairingListener(options: SecurePairingOptions) {
  const advertisedHost = privateHttpsHost(options.advertisedHost);
  if (options.hostname !== '0.0.0.0' && options.hostname !== '127.0.0.1' && options.hostname !== advertisedHost) throw new Error('Invalid secure listener binding');
  const now = options.now ?? Date.now;
  mkdirSync(options.configDirectory, { recursive: true, mode: 0o700 });
  const keyPath = join(options.configDirectory, 'tls-key.pem');
  const certificatePath = join(options.configDirectory, 'tls-certificate.pem');
  const statePath = join(options.configDirectory, 'authorization.json');
  if (existsSync(keyPath) !== existsSync(certificatePath)) throw new Error('Incomplete TLS identity; restore it explicitly');
  if (!existsSync(keyPath)) {
    if (existsSync(statePath)) throw new Error('Missing TLS identity; existing authorization cannot be reused');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '365',
      '-subj', '/CN=T3 private library', '-addext', `subjectAltName=IP:${advertisedHost},IP:127.0.0.1`,
      '-keyout', keyPath, '-out', certificatePath], { stdio: 'ignore', windowsHide: true });
  }
  const certificate = readFileSync(certificatePath, 'utf8');
  const certificateSha256 = createHash('sha256').update(new X509Certificate(certificate).raw).digest('hex');
  let state = existsSync(statePath) ? stateSchema.parse(JSON.parse(readFileSync(statePath, 'utf8')) as unknown)
    : { version: 1 as const, libraryId: options.libraryId, certificateSha256, sessions: [], offers: [] };
  if (state.libraryId !== options.libraryId || state.certificateSha256 !== certificateSha256) throw new Error('Library or TLS identity changed; authorization requires explicit reset');
  const save = (candidate: typeof state) => {
    const temporaryPath = join(options.configDirectory, `authorization-${randomUUID()}.tmp`);
    const file = openSync(temporaryPath, 'wx', 0o600);
    try { writeFileSync(file, JSON.stringify(candidate)); fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporaryPath, statePath); state = candidate;
  };
  save(state);
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
  const unauthorized = () => json({ error: { code: 'UNAUTHORIZED', message: 'Pair this device again from the desktop' } }, 401);
  const server = serve({ createServer, serverOptions: { key: readFileSync(keyPath), cert: certificate, minVersion: 'TLSv1.2' }, hostname: options.hostname, port: options.port ?? 0,
    fetch: async (request) => {
      if (options.currentLibraryId && options.currentLibraryId() !== state.libraryId) return unauthorized();
      // Native bearer-only transport. Browser Origin, cookies and preflight cannot gain authority.
      if (request.headers.has('origin') || request.headers.has('cookie') || request.method === 'OPTIONS') return json({ error: { code: 'FORBIDDEN', message: 'Native transport only' } }, 403);
      const path = new URL(request.url).pathname;
      if (path === '/api/pairing/claim' && request.method === 'POST') {
        if (request.headers.get('content-type') !== 'application/json' || Number(request.headers.get('content-length') ?? 0) > 4096) return unauthorized();
        let body: unknown;
        try { const text = await request.text(); if (text.length > 4096) return unauthorized(); body = JSON.parse(text) as unknown; } catch { return unauthorized(); }
        const parsed = claimSchema.safeParse(body);
        if (!parsed.success || parsed.data.libraryId !== state.libraryId) return unauthorized();
        // No await between claim check and durable consumption: exactly one concurrent winner.
        const codeHash = hash(parsed.data.code);
        const offer = state.offers.find(item => item.codeHash === codeHash && item.expiresAt > now());
        if (!offer) return unauthorized();
        const token = secret(); const deviceId = randomUUID();
        save({ ...state, offers: state.offers.filter(item => item !== offer && item.expiresAt > now()),
          sessions: [...state.sessions, { deviceId, deviceName: parsed.data.deviceName, tokenHash: hash(token), createdAt: now(), revoked: false }] });
        return json({ version: 1, libraryId: state.libraryId, deviceId, token }, 201);
      }
      const authorization = request.headers.get('authorization') ?? '';
      if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) return unauthorized();
      const tokenHash = Buffer.from(hash(authorization.slice(7)), 'hex');
      if (!state.sessions.some(item => !item.revoked && timingSafeEqual(Buffer.from(item.tokenHash, 'hex'), tokenHash))) return unauthorized();
      // Desktop administrative routes are never forwarded by the LAN listener.
      if (path.startsWith('/api/pairing/') || !path.startsWith('/api/')) return json({ error: { code: 'FORBIDDEN', message: 'Unavailable on native transport' } }, 403);
      const response = await options.fetch(request);
      // No credential-bearing redirect, including same-origin resolver redirects: native resolves explicitly.
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || new URL(location, request.url).origin !== new URL(request.url).origin) return json({ error: { code: 'FORBIDDEN', message: 'Off-origin redirect rejected' } }, 403);
      }
      return response;
    },
  });
  if (!server.listening) await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    certificate,
    testOrigin: `https://127.0.0.1:${port}`,
    endpoint: `https://${advertisedHost}:${port}`,
    issue() {
      if (options.currentLibraryId && options.currentLibraryId() !== state.libraryId) throw new Error('Library identity changed; restart and explicitly re-pair');
      const code = secret(); const expiresAt = now() + 120_000;
      save({ ...state, offers: [...state.offers.filter(item => item.expiresAt > now()).slice(-9), { codeHash: hash(code), expiresAt }] });
      return { version: 1, endpoint: `https://${advertisedHost}:${port}`, libraryId: state.libraryId, protocolMin: 1, protocolMax: 1, code, expiresAt, certificateSha256 };
    },
    devices() { return state.sessions.map(({ deviceId, deviceName, createdAt, revoked }) => ({ deviceId, deviceName, createdAt, revoked })); },
    revoke(deviceId: string) { save({ ...state, sessions: state.sessions.map(item => item.deviceId === deviceId ? { ...item, revoked: true } : item) }); },
    /** Drop an already-revoked record. A live device is never removed here: only
     * `revoke` can end its authority, so forgetting can never widen access. */
    forget(deviceId: string) {
      const target = state.sessions.find(item => item.deviceId === deviceId);
      if (target === undefined || !target.revoked) return state.sessions.map(({ deviceId: id, deviceName, createdAt, revoked }) => ({ deviceId: id, deviceName, createdAt, revoked }));
      save({ ...state, sessions: state.sessions.filter(item => item.deviceId !== deviceId) });
      return state.sessions.map(({ deviceId: id, deviceName, createdAt, revoked }) => ({ deviceId: id, deviceName, createdAt, revoked }));
    },
    close() { return new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); if ('closeAllConnections' in server) server.closeAllConnections(); }); },
  };
}
