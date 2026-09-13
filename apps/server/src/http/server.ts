import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { openDatabase, type T3Database } from '../database/connection.js';
import { applyAllMigrations } from '../database/migrations.js';
import { markRunningRunsPaused } from '../source-maintenance/job-manager.js';
import { defaultCatalogProviders } from '../source-maintenance/catalogs/index.js';
import { createApiApp } from './app.js';

export interface StartApiServerOptions {
  databasePath: string;
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

  const app = createApiApp(database, {
    assetRoot: join(dirname(options.databasePath), 'assets'),
    databasePath: options.databasePath,
    catalogProviders: defaultCatalogProviders(),
    ...(options.staticRoot ? { staticRoot: options.staticRoot } : {}),
  });
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
      await closeServer(server);
      database.close();
    },
  };
}
