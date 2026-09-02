import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApiServer } from './server.js';

function parsePort(value: string | undefined): number {
  const port = Number(value ?? '8765');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('T3_PORT must be an integer between 0 and 65535');
  }
  return port;
}

const hostname = process.env.T3_HOST ?? '127.0.0.1';
const enableLan = process.env.T3_ENABLE_LAN === 'true';
if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1' && !enableLan) {
  throw new Error('Set T3_ENABLE_LAN=true before binding the API outside localhost');
}

const databasePath = resolve(
  process.env.T3_DATA_DIR ?? '.data',
  process.env.T3_DB_NAME ?? 'library.db',
);
// Built web app, one directory up from this package (`apps/web/dist`). Served
// from the API origin so a production run is a single process on one port.
// Override with T3_STATIC_ROOT; pass an empty value to disable hosting.
const defaultStaticRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
const staticRoot = process.env.T3_STATIC_ROOT === undefined && existsSync(defaultStaticRoot)
  ? defaultStaticRoot
  : (process.env.T3_STATIC_ROOT || undefined);
const runtime = await startApiServer({
  databasePath,
  hostname,
  port: parsePort(process.env.T3_PORT),
  ...(staticRoot ? { staticRoot } : {}),
});

console.log(`T3 API listening at ${runtime.origin}`);
if (process.env.T3_OPEN_BROWSER === '1' && process.platform === 'win32') {
  // One-shot: open the default browser at the running app (used by T3.bat).
  spawn('cmd', ['/c', 'start', '', runtime.origin], { detached: true, stdio: 'ignore' }).unref();
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await runtime.close();
}

process.once('SIGINT', () => {
  void shutdown().then(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void shutdown().then(() => process.exit(0));
});
