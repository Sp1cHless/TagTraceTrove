import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLibraryBackup, restoreLibraryBackup } from '../../src/database/backup-restore.js';
import { createTempFileDatabase, type TempFileDatabase } from '../../src/database/testing.js';
import { applyAllMigrations } from '../../src/database/migrations.js';
import { openDatabase } from '../../src/database/connection.js';

interface Fixture {
  temp: TempFileDatabase;
  dataDir: string;
  assetRoot: string;
  cleanup: () => void;
}

const fixtures: Fixture[] = [];

function makeFixture(): Fixture {
  const temp = createTempFileDatabase();
  applyAllMigrations(temp.database);
  const dataDir = join(tmpdir(), `t3-backup-data-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dataDir, 'assets', 'entries', '10'), { recursive: true });
  writeFileSync(join(dataDir, 'assets', 'entries', '10', 'cover.webp'), 'cover-bytes-A');
  const assetRoot = join(dataDir, 'assets');
  const fixture: Fixture = {
    temp,
    dataDir,
    assetRoot,
    cleanup: () => {
      temp.cleanup();
    },
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.cleanup();
  }
});

function insertEntry(temp: TempFileDatabase, title: string, type = 'Comic'): void {
  temp.database.prepare(
    `INSERT INTO entries (title, type) VALUES (?, ?)`,
  ).run(title, type);
}

function countEntries(temp: TempFileDatabase): number {
  return (temp.database.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;
}

describe('library backup', () => {
  it('creates a self-contained snapshot: db + assets + manifest', async () => {
    const fixture = makeFixture();
    insertEntry(fixture.temp, 'Work A');
    insertEntry(fixture.temp, 'Work B');

    const result = await createLibraryBackup({
      databasePath: fixture.temp.path,
      dataDir: fixture.dataDir,
    });

    expect(existsSync(join(result.backupDir, 'library.db'))).toBe(true);
    expect(existsSync(join(result.backupDir, 'assets', 'entries', '10', 'cover.webp'))).toBe(true);
    expect(existsSync(join(result.backupDir, 'manifest.json'))).toBe(true);
    expect(result.manifest.entryCount).toBe(2);
    expect(result.manifest.sourceDatabase).toBe(fixture.temp.path);
  });

  it('fails cleanly when the database does not exist', async () => {
    const fixture = makeFixture();
    await expect(createLibraryBackup({
      databasePath: join(fixture.dataDir, 'missing.db'),
      dataDir: fixture.dataDir,
    })).rejects.toThrow(/not found/i);
  });
});

describe('library restore', () => {
  it('rolls the database and assets back to the backup point, keeping a pre-restore snapshot', async () => {
    const fixture = makeFixture();
    insertEntry(fixture.temp, 'Work A');
    insertEntry(fixture.temp, 'Work B');
    const backup = await createLibraryBackup({
      databasePath: fixture.temp.path,
      dataDir: fixture.dataDir,
    });

    // Drift the live library away from the backup point.
    fixture.temp.database.prepare(`DELETE FROM entries WHERE title = 'Work B'`).run();
    insertEntry(fixture.temp, 'Work C');
    expect(countEntries(fixture.temp)).toBe(2);

    // The CLI owns the database exclusively: no live connection during restore.
    fixture.temp.database.close();
    const result = await restoreLibraryBackup({
      backupDir: backup.backupDir,
      databasePath: fixture.temp.path,
      dataDir: fixture.dataDir,
    });

    expect(result.doctorOk).toBe(true);
    expect(result.entryCount).toBe(2);
    expect(result.preRestoreSnapshot).toBeDefined();
    expect(existsSync(join(result.preRestoreSnapshot!, 'library.db'))).toBe(true);

    // Database content is back to the backup point.
    const reopened = openDatabase(fixture.temp.path);
    try {
      const rows = reopened.prepare('SELECT title FROM entries ORDER BY title').all() as Array<{ title: string }>;
      expect(rows.map((row) => row.title)).toEqual(['Work A', 'Work B']);

      // Media tree was restored (assets were replaced, snapshot of old one kept).
      expect(existsSync(join(fixture.assetRoot, 'entries', '10', 'cover.webp'))).toBe(true);
    } finally {
      reopened.close();
    }
  });

  it('refuses a backup that fails integrity checks and leaves the live library untouched', async () => {
    const fixture = makeFixture();
    insertEntry(fixture.temp, 'Work A');
    const backup = await createLibraryBackup({
      databasePath: fixture.temp.path,
      dataDir: fixture.dataDir,
    });

    // Corrupt the backup snapshot on disk.
    writeFileSync(join(backup.backupDir, 'library.db'), 'this is not a sqlite database at all');

    const originalTitle = (fixture.temp.database.prepare('SELECT title FROM entries').get() as { title: string }).title;
    await expect(restoreLibraryBackup({
      backupDir: backup.backupDir,
      databasePath: fixture.temp.path,
      dataDir: fixture.dataDir,
    })).rejects.toThrow(/integrity|refusing/i);

    // Live library is untouched.
    const still = (fixture.temp.database.prepare('SELECT title FROM entries').get() as { title: string }).title;
    expect(still).toBe(originalTitle);
    expect(fixture.temp.database.pragma('integrity_check' as never)).toBeDefined();
  });

  it('rejects a directory that is not a T3 backup', async () => {
    const fixture = makeFixture();
    await expect(restoreLibraryBackup({
      backupDir: fixture.dataDir,
      databasePath: fixture.temp.path,
      dataDir: fixture.dataDir,
    })).rejects.toThrow(/no library\.db/i);
  });
});
