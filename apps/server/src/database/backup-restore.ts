import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from './connection.js';
import { inspectDatabase } from './doctor.js';
import { applyAllMigrations } from './migrations.js';
import { rotateSyncEpoch } from '../sync/sync-service.js';

/**
 * Whole-library backup/restore. A backup is a self-contained directory
 * `<dataDir>/backups/backup-<timestamp>/` holding:
 *   - `library.db`   — consistent SQLite snapshot (better-sqlite3 backup API,
 *                      WAL-safe, taken from a read-only connection so a
 *                      running server is never disturbed),
 *   - `assets/`      — copy of the media tree (`<dataDir>/assets`),
 *   - `manifest.json`— creation time, source path, entry/producer counts.
 *
 * Restore validates the backup with db:doctor, snapshots the CURRENT library
 * first (`backups/restore-prestore-<timestamp>/`), then swaps database and
 * assets. A running T3 server holds the database file, so the swap renames the
 * old files aside first and fails with a clear message if they are locked.
 */

export interface LibraryBackupManifest {
  createdAt: string;
  sourceDatabase: string;
  entryCount: number;
  producerCount: number;
}

export interface LibraryBackupResult {
  backupDir: string;
  manifest: LibraryBackupManifest;
}

export interface LibraryBackupOptions {
  databasePath: string;
  /** Directory holding the live `assets/` tree. Defaults to dirname(databasePath). */
  dataDir?: string;
  /** Root that receives backup folders. Defaults to `<dataDir>/backups`. */
  backupsDir?: string;
}

export interface LibraryRestoreOptions {
  /** A backup directory produced by createLibraryBackup (or a legacy single-file snapshot). */
  backupDir: string;
  databasePath: string;
  dataDir?: string;
}

export interface LibraryRestoreResult {
  backupDir: string;
  restoredDatabase: string;
  /** Snapshot of the pre-restore library, or undefined when nothing was replaced. */
  preRestoreSnapshot: string | undefined;
  entryCount: number;
  producerCount: number;
  doctorOk: boolean;
  doctorIssues: string[];
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function readOnlyDatabase(path: string): Database.Database {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  database.pragma('busy_timeout = 5000');
  return database;
}

export async function createLibraryBackup(options: LibraryBackupOptions): Promise<LibraryBackupResult> {
  const databasePath = resolve(options.databasePath);
  if (!existsSync(databasePath)) {
    throw new Error(`Database not found: ${databasePath}`);
  }
  const dataDir = resolve(options.dataDir ?? dirname(databasePath));
  const assetRoot = join(dataDir, 'assets');
  const backupsRoot = resolve(options.backupsDir ?? join(dataDir, 'backups'));
  const backupDir = join(backupsRoot, `backup-${timestamp()}`);
  mkdirSync(backupDir, { recursive: true });

  const source = readOnlyDatabase(databasePath);
  try {
    // better-sqlite3 backup(): consistent snapshot that includes WAL content.
    await source.backup(join(backupDir, 'library.db'));
  } finally {
    source.close();
  }

  if (existsSync(assetRoot)) {
    cpSync(assetRoot, join(backupDir, 'assets'), { recursive: true });
  }

  // Counts come from the snapshot itself, which also proves it opens cleanly.
  const snapshot = readOnlyDatabase(join(backupDir, 'library.db'));
  let manifest: LibraryBackupManifest;
  try {
    const counts = snapshot.prepare(
      `SELECT
         (SELECT COUNT(*) FROM entries) AS entryCount,
         (SELECT COUNT(*) FROM producers) AS producerCount`,
    ).get() as { entryCount: number; producerCount: number };
    manifest = {
      createdAt: new Date().toISOString(),
      sourceDatabase: databasePath,
      entryCount: counts.entryCount,
      producerCount: counts.producerCount,
    };
  } finally {
    snapshot.close();
  }
  writeFileSync(join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  return { backupDir, manifest };
}

export async function restoreLibraryBackup(options: LibraryRestoreOptions): Promise<LibraryRestoreResult> {
  const backupDir = resolve(options.backupDir);
  const backupDatabase = join(backupDir, 'library.db');
  if (!existsSync(backupDatabase)) {
    throw new Error(`Not a T3 backup (no library.db): ${backupDir}`);
  }

  // Gate 1: the backup itself must pass the doctor before we touch anything.
  let verification: Database.Database;
  try {
    verification = readOnlyDatabase(backupDatabase);
  } catch {
    throw new Error(`Backup is not a readable SQLite database, refusing to restore: ${backupDir}`);
  }
  let backupCounts: { entryCount: number; producerCount: number };
  try {
    const result = inspectDatabase(verification);
    if (!result.ok) {
      throw new Error(`Backup failed integrity checks, refusing to restore:\n${result.issues.join('\n')}`);
    }
    backupCounts = verification.prepare(
      `SELECT
         (SELECT COUNT(*) FROM entries) AS entryCount,
         (SELECT COUNT(*) FROM producers) AS producerCount`,
    ).get() as { entryCount: number; producerCount: number };
  } catch (error) {
    if (error instanceof Error && error.message.includes('refusing to restore')) {
      throw error;
    }
    // SQLite-level failures (e.g. "file is not a database") surface from the
    // integrity pragma, not from opening the file — wrap them the same way.
    throw new Error(
      `Backup is not a valid T3 database (${error instanceof Error ? error.message : String(error)}), refusing to restore: ${backupDir}`,
    );
  } finally {
    verification.close();
  }

  const databasePath = resolve(options.databasePath);
  const dataDir = resolve(options.dataDir ?? dirname(databasePath));
  const assetRoot = join(dataDir, 'assets');
  const backupsRoot = join(dataDir, 'backups');
  const preRestoreTag = `restore-prestore-${timestamp()}`;

  // Gate 2: the current library must not be locked by a running server.
  // Renaming first makes a lock surface as an OS error instead of a silent
  // partial overwrite.
  const moveAside = (path: string, suffix: string): void => {
    if (!existsSync(path)) {
      return;
    }
    try {
      renameSync(path, `${path}.${suffix}`);
    } catch (error) {
      throw new Error(
        `Cannot replace ${path} (is the T3 server running? Exit the tray icon / close T3.bat first).\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // Self-preservation: snapshot whatever is there now (best effort — a
  // corrupt current library may refuse, and restoring over it is the point).
  let preRestoreSnapshot: string | undefined;
  try {
    if (existsSync(databasePath)) {
      const preserved = await createLibraryBackup({
        databasePath,
        dataDir,
        backupsDir: join(backupsRoot, preRestoreTag),
      });
      preRestoreSnapshot = preserved.backupDir;
    }
  } catch (error) {
    console.warn(`WARNING: could not snapshot the current library before restoring: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const suffix of ['-wal', '-shm'] as const) {
    moveAside(`${databasePath}${suffix}`, preRestoreTag);
  }
  moveAside(databasePath, preRestoreTag);
  mkdirSync(dirname(databasePath), { recursive: true });
  cpSync(backupDatabase, databasePath);

  // Gate 3 runs before touching the live asset tree. Legacy backups are
  // upgraded first so migration 015 can create sync_metadata; rotating the
  // epoch here also ensures a later asset-copy failure cannot leave a
  // runnable rewound database with its backed-up epoch.
  const restored = openDatabase(databasePath);
  let doctorOk = false;
  let doctorIssues: string[] = [];
  try {
    applyAllMigrations(restored);
    rotateSyncEpoch(restored);
    const result = inspectDatabase(restored);
    doctorOk = result.ok;
    doctorIssues = result.issues;
  } finally {
    restored.close();
  }
  if (!doctorOk) {
    throw new Error(`Restore completed but the restored database failed integrity checks:\n${doctorIssues.join('\n')}\nPre-restore snapshot: ${preRestoreSnapshot ?? '(none)'}`);
  }

  if (existsSync(assetRoot) || existsSync(join(backupDir, 'assets'))) {
    moveAside(assetRoot, preRestoreTag);
  }
  const backupAssets = join(backupDir, 'assets');
  if (existsSync(backupAssets)) {
    cpSync(backupAssets, assetRoot, { recursive: true });
  }


  return {
    backupDir,
    restoredDatabase: databasePath,
    preRestoreSnapshot,
    entryCount: backupCounts.entryCount,
    producerCount: backupCounts.producerCount,
    doctorOk,
    doctorIssues,
  };
}

/** Cleanup helper for tests: remove a backup tree. */
export function removeBackup(backupDir: string): void {
  rmSync(backupDir, { recursive: true, force: true });
}
