import { createReadStream, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { T3Database } from '../database/connection.js';

/**
 * The desktop's own low-level settings, kept beside the library so the launcher can read
 * them before the server exists (it needs them to decide what to advertise on the network)
 * and the server can report them. A missing file means the defaults, which is how an
 * installation that never touched them behaves.
 */
export interface SystemSettings {
  /**
   * Advertise this desktop's private address at startup so a phone can pair without the
   * person having to launch with a flag. Default on: the paired transport is authenticated
   * and pinned, and the address is only reachable from the local network.
   */
  autoAllowMobileConnection: boolean;
}

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = { autoAllowMobileConnection: true };
export const SYSTEM_SETTINGS_FILE = 't3-settings.json';

export interface SystemSettingsRead {
  settings: SystemSettings;
  /** Set when the stored file exists but could not be used; the defaults apply instead. */
  problem: string | null;
  path: string;
}

export function systemSettingsPath(dataDir: string): string {
  return join(dataDir, SYSTEM_SETTINGS_FILE);
}

export function readSystemSettings(dataDir: string): SystemSettingsRead {
  const path = systemSettingsPath(dataDir);
  if (!existsSync(path)) {
    return { settings: { ...DEFAULT_SYSTEM_SETTINGS }, problem: null, path };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SystemSettings>;
    return {
      settings: {
        autoAllowMobileConnection: parsed.autoAllowMobileConnection !== false,
      },
      problem: null,
      path,
    };
  } catch (cause) {
    return {
      settings: { ...DEFAULT_SYSTEM_SETTINGS },
      problem: cause instanceof Error ? cause.message : String(cause),
      path,
    };
  }
}

export function writeSystemSettings(dataDir: string, settings: SystemSettings): void {
  mkdirSync(dataDir, { recursive: true });
  const path = systemSettingsPath(dataDir);
  // Write beside the file and rename, so a crash cannot leave a half-written setting that
  // silently flips phone access off.
  const staged = `${path}.writing`;
  writeFileSync(staged, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(staged, path);
}

export function backupsDirectory(dataDir: string): string {
  return join(dataDir, 'backups');
}

const BACKUP_NAME = /^library-\d{8}T\d{6}\.db$/u;

function backupStamp(): string {
  // `20261009T133941`: no separators and no zone suffix, because the name is what the list matches.
  return new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, '');
}

export interface BackupEntry {
  name: string;
  createdAt: string;
  bytes: number;
  entryCount: number | null;
  producerCount: number | null;
  schemaVersion: number | null;
}

function readBackupCounts(path: string): { entryCount: number | null; producerCount: number | null; schemaVersion: number | null } {
  try {
    const database = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const counts = database.prepare(
        'SELECT (SELECT COUNT(*) FROM entries) AS entries, (SELECT COUNT(*) FROM producers) AS producers, '
        + '(SELECT COALESCE(MAX(version), 0) FROM schema_migrations) AS version',
      ).get() as { entries: number; producers: number; version: number };
      return { entryCount: counts.entries, producerCount: counts.producers, schemaVersion: counts.version };
    } finally {
      database.close();
    }
  } catch {
    return { entryCount: null, producerCount: null, schemaVersion: null };
  }
}

export function listBackups(dataDir: string): BackupEntry[] {
  const directory = backupsDirectory(dataDir);
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => BACKUP_NAME.test(name))
    .map((name) => {
      const path = join(directory, name);
      const info = statSync(path);
      const counts = readBackupCounts(path);
      return {
        name,
        createdAt: new Date(info.mtimeMs).toISOString(),
        bytes: info.size,
        ...counts,
      };
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export interface CreatedBackup extends BackupEntry {
  path: string;
}

/** A consistent copy of the live database, taken while the server keeps serving. */
export async function createBackup(database: T3Database, dataDir: string): Promise<CreatedBackup> {
  const directory = backupsDirectory(dataDir);
  mkdirSync(directory, { recursive: true });
  const name = `library-${backupStamp()}.db`;
  const path = join(directory, name);
  await database.backup(path);
  const info = statSync(path);
  return {
    name,
    path,
    createdAt: new Date(info.mtimeMs).toISOString(),
    bytes: info.size,
    ...readBackupCounts(path),
  };
}

/**
 * Restores are staged rather than swapped underneath a running server: the live database is
 * open, and replacing its file (with a stale write-ahead log beside it) is how a library gets
 * corrupted. The upload is validated here, kept, and applied by `applyStagedRestore` the next
 * time the desktop starts — the same "reload the server" step the tray already asks for.
 */
export function stagedRestorePath(dataDir: string): string {
  return join(dataDir, 'restore-staged', 'library.db');
}

export interface StagedRestore {
  stagedAt: string;
  bytes: number;
  entryCount: number | null;
  producerCount: number | null;
  schemaVersion: number | null;
}

const STAGED_META = 'library.json';

export function stageRestore(dataDir: string, bytes: Uint8Array): StagedRestore {
  const directory = dirname(stagedRestorePath(dataDir));
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const path = stagedRestorePath(dataDir);
  writeFileSync(path, bytes);
  const counts = readBackupCounts(path);
  if (counts.schemaVersion === null) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error('That file is not a T³ library database');
  }
  // Reading the file above may have left a write-ahead log beside it; the staged folder holds
  // the upload and nothing else, so what gets applied is exactly what arrived.
  for (const suffix of ['-wal', '-shm']) {
    rmSync(`${path}${suffix}`, { force: true });
  }
  const staged: StagedRestore = { stagedAt: new Date().toISOString(), bytes: bytes.byteLength, ...counts };
  writeFileSync(join(directory, STAGED_META), `${JSON.stringify(staged, null, 2)}\n`, 'utf8');
  return staged;
}

export function readStagedRestore(dataDir: string): StagedRestore | null {
  const meta = join(dirname(stagedRestorePath(dataDir)), STAGED_META);
  if (!existsSync(stagedRestorePath(dataDir)) || !existsSync(meta)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(meta, 'utf8')) as StagedRestore;
  } catch {
    return null;
  }
}

export interface StagedRestoreApplied {
  restoredFrom: string;
  preRestoreBackup: string | null;
  entryCount: number | null;
  producerCount: number | null;
}

/**
 * Puts a staged restore in place before the database is opened. The library that is being
 * replaced is copied aside first, so a restore that turns out to be the wrong file is itself
 * recoverable; the write-ahead log of the old library is removed because it belongs to the
 * file that just went away.
 */
export function applyStagedRestore(dataDir: string, databasePath: string): StagedRestoreApplied | null {
  const staged = stagedRestorePath(dataDir);
  if (!existsSync(staged)) {
    return null;
  }
  const directory = backupsDirectory(dataDir);
  mkdirSync(directory, { recursive: true });
  let preRestoreBackup: string | null = null;
  if (existsSync(databasePath)) {
    preRestoreBackup = join(directory, `library-${backupStamp()}.db`);
    copyFileSync(databasePath, preRestoreBackup);
  }
  const stagedCounts = readBackupCounts(staged);
  copyFileSync(staged, databasePath);
  for (const suffix of ['-wal', '-shm']) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
  rmSync(dirname(staged), { recursive: true, force: true });
  return {
    restoredFrom: staged,
    preRestoreBackup,
    entryCount: stagedCounts.entryCount,
    producerCount: stagedCounts.producerCount,
  };
}

/**
 * The launcher's log, which is where the server's own output (and any startup failure) lands.
 * Reading its tail is what makes "copy the error" possible without asking anyone to find a file.
 */
export function defaultLogPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../t3-server.log');
}

const LOG_TAIL_BYTES = 256 * 1024;
const LOG_TAIL_LINES = 400;

export function readLogTail(path: string, lines = LOG_TAIL_LINES): { text: string; bytes: number; truncated: boolean } {
  if (!existsSync(path)) {
    return { text: '', bytes: 0, truncated: false };
  }
  const info = statSync(path);
  const start = Math.max(0, info.size - LOG_TAIL_BYTES);
  const handle = readFileSync(path);
  const slice = start === 0 ? handle : handle.subarray(start);
  const text = slice.toString('utf8').split('\n');
  const tail = text.slice(Math.max(0, text.length - lines)).join('\n');
  return { text: tail, bytes: info.size, truncated: start > 0 };
}

const settingsPayloadSchema = z.object({
  autoAllowMobileConnection: z.boolean(),
}).strict();

export interface SystemRoutesOptions {
  database: T3Database;
  dataDir: string;
  databasePath?: string;
  logPath?: string;
  /** Restoring is a deliberate, destructive step: the caller may refuse it (tests, embedders). */
  restoreEnabled?: boolean;
}

/**
 * The lowest-level surface: what the desktop can say about itself, and the two operations that
 * are about the library as a whole (back it up, put one back). Deliberately not part of the
 * daily pages — this is where someone goes when something is wrong.
 */
export function registerSystemRoutes(app: Hono, options: SystemRoutesOptions): void {
  const logPath = options.logPath ?? defaultLogPath();

  app.get('/api/system/diagnostics', (context) => {
    const stored = readSystemSettings(options.dataDir);
    const staged = readStagedRestore(options.dataDir);
    const log = readLogTail(logPath);
    return context.json({
      logPath,
      logBytes: log.bytes,
      logTruncated: log.truncated,
      logTail: log.text,
      dataDir: options.dataDir,
      databasePath: options.databasePath ?? null,
      backupsDir: backupsDirectory(options.dataDir),
      backupCount: listBackups(options.dataDir).length,
      settings: stored.settings,
      settingsPath: stored.path,
      settingsProblem: stored.problem,
      stagedRestore: staged,
      nodeVersion: process.version,
      platform: `${process.platform} ${process.arch}`,
    });
  });

  app.get('/api/system/settings', (context) => {
    const stored = readSystemSettings(options.dataDir);
    return context.json({ settings: stored.settings, problem: stored.problem, path: stored.path });
  });

  app.put('/api/system/settings', async (context) => {
    let payload: unknown;
    try {
      payload = await context.req.json();
    } catch {
      return context.json({ error: { code: 'VALIDATION_ERROR', message: 'Settings must be JSON' } }, 400);
    }
    const parsed = settingsPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return context.json({ error: { code: 'VALIDATION_ERROR', message: 'Unknown or missing setting' } }, 400);
    }
    writeSystemSettings(options.dataDir, parsed.data);
    return context.json({ settings: parsed.data, problem: null, path: systemSettingsPath(options.dataDir) });
  });

  app.get('/api/system/backups', (context) => context.json({ backups: listBackups(options.dataDir) }));

  app.post('/api/system/backups', async (context) => {
    const created = await createBackup(options.database, options.dataDir);
    return context.json({ backup: created });
  });

  app.get('/api/system/backups/:name', (context) => {
    const name = context.req.param('name');
    if (!BACKUP_NAME.test(name)) {
      return context.json({ error: { code: 'VALIDATION_ERROR', message: 'Unknown backup name' } }, 400);
    }
    const path = join(backupsDirectory(options.dataDir), name);
    if (!existsSync(path)) {
      return context.json({ error: { code: 'NOT_FOUND', message: 'No such backup' } }, 404);
    }
    context.header('content-type', 'application/vnd.sqlite3');
    context.header('content-disposition', `attachment; filename="${name}"`);
    return context.body(Readable.toWeb(createReadStream(path)) as ReadableStream);
  });

  app.delete('/api/system/backups/:name', (context) => {
    const name = context.req.param('name');
    if (!BACKUP_NAME.test(name)) {
      return context.json({ error: { code: 'VALIDATION_ERROR', message: 'Unknown backup name' } }, 400);
    }
    const path = join(backupsDirectory(options.dataDir), name);
    if (!existsSync(path)) {
      return context.json({ error: { code: 'NOT_FOUND', message: 'No such backup' } }, 404);
    }
    rmSync(path, { force: true });
    return context.json({ removed: name });
  });

  app.post('/api/system/restore', async (context) => {
    if (options.restoreEnabled === false) {
      return context.json({ error: { code: 'CONFLICT', message: 'Restoring is unavailable here' } }, 409);
    }
    const form = await context.req.raw.formData();
    const file = form.get('file');
    const upload = typeof file === 'object' && file !== null && 'arrayBuffer' in file && typeof file.arrayBuffer === 'function'
      ? file
      : null;
    if (!upload) {
      return context.json({ error: { code: 'VALIDATION_ERROR', message: 'A backup file is required' } }, 400);
    }
    const bytes = new Uint8Array(await upload.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024 * 1024) {
      return context.json({ error: { code: 'VALIDATION_ERROR', message: 'That file is empty or too large' } }, 400);
    }
    try {
      const staged = stageRestore(options.dataDir, bytes);
      return context.json({ staged, restartRequired: true });
    } catch (cause) {
      return context.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: cause instanceof Error ? cause.message : 'That file is not a T³ library database',
        },
      }, 400);
    }
  });
}
