import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { openDatabase, type T3Database } from '../database/connection.js';
import { applyAllMigrations } from '../database/migrations.js';
import { markRunningRunsPaused } from '../source-maintenance/job-manager.js';
import { defaultCatalogProviders } from '../source-maintenance/catalogs/index.js';
import { createSiteprobeRuntime } from '../siteprobe/runtime.js';
import { cleanupAbandonedSyncMediaStaging } from '../sync/media-replay-service.js';
import { createApiApp } from './app.js';
import { startPairedApiServers } from './paired-server.js';

export interface StartApiServerOptions {
  databasePath: string;
  securePairing?: { configDirectory: string; advertisedHost: string; port?: number };
  hostname?: string;
  port?: number;
  /** Built web app directory (`apps/web/dist`); enables static hosting. */
  staticRoot?: string;
}

export interface ApiServerRuntime {
  database: T3Database;
  origin: string;
  close(): Promise<void>;
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function startApiServer(options: StartApiServerOptions): Promise<ApiServerRuntime> {
  const hostname = options.hostname ?? '127.0.0.1';
  const port = options.port ?? 8765;
  mkdirSync(dirname(options.databasePath), { recursive: true });

  const database = openDatabase(options.databasePath);
  try {
    applyAllMigrations(database);
    // A run that was mid-flight when the process exited becomes 'paused';
    // the user must explicitly Resume it (plan §17).
    markRunningRunsPaused(database);
  } catch (error) {
    database.close();
    throw error;
  }

  const dataDir = dirname(options.databasePath);
  try {
    await cleanupAbandonedSyncMediaStaging(join(dataDir, 'assets'));
  } catch (error) {
    database.close();
    throw error;
  }
  // Built here rather than inside the app so that shutting the server down also stops a crawl: a
  // child process outlives its parent by default, and a cancelled run must not keep writing.
  const siteprobeRuntime = createSiteprobeRuntime({ dataDir });
  const app = createApiApp(database, {
    assetRoot: join(dataDir, 'assets'),
    databasePath: options.databasePath,
    dataDir,
    siteprobeRuntime,
    catalogProviders: defaultCatalogProviders(),
    ...(options.staticRoot ? { staticRoot: options.staticRoot } : {}),
  });
  if (options.securePairing) {
    if (hostname !== '127.0.0.1') { database.close(); siteprobeRuntime.close(); throw new Error('Paired transport requires a loopback-only desktop HTTP listener'); }
    try {
      const paired = await startPairedApiServers({ database, fetch: app.fetch, assetRoot: join(dataDir, 'assets'),
        configDirectory: options.securePairing.configDirectory, advertisedHost: options.securePairing.advertisedHost,
        securePort: options.securePairing.port ?? 8766, desktopPort: port,
        ...(options.staticRoot ? { staticRoot: options.staticRoot } : {}), });
      let closed = false;
      return { database, origin: paired.origin, async close() { if (closed) return; closed = true; siteprobeRuntime.close(); await paired.close(); database.close(); } };
    } catch (error) { siteprobeRuntime.close(); database.close(); throw error; }
  }
  const server = serve({ fetch: app.fetch, hostname, port });
  if (!server.listening) {
    await once(server, 'listening');
  }
  const address = server.address() as AddressInfo;
  const origin = `http://${hostname}:${address.port}`;
  let closed = false;

  return {
    database,
    origin,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      siteprobeRuntime.close();
      await closeServer(server);
      database.close();
    },
  };
}
