import { dirname } from 'node:path';
import { resolveCliDatabasePath } from './cli-path.js';
import { restoreLibraryBackup } from './backup-restore.js';

// Usage: tsx src/database/restore-cli.ts <backupDir> [databasePath]
//   <backupDir>   a backup directory produced by db:backup (contains library.db)
//   [databasePath] defaults to the server package's .data/library.db regardless of caller cwd
//
// The current library is snapshotted first (backups/restore-prestore-<ts>/).
// Stop the T3 server (tray Exit / close T3.bat) before restoring.
const backupDir = process.argv[2];
if (!backupDir) {
  console.error('Usage: pnpm db:restore <backupDir> [databasePath]');
  process.exitCode = 1;
} else {
  const databasePath = resolveCliDatabasePath(process.argv[3], process.env.INIT_CWD ?? process.cwd());
  try {
    const result = await restoreLibraryBackup({
      backupDir,
      databasePath,
      dataDir: dirname(databasePath),
    });
    console.log('PASS restore complete (doctor ok)');
    console.log(`  database: ${result.restoredDatabase}`);
    console.log(`  entries: ${result.entryCount}, producers: ${result.producerCount}`);
    if (result.preRestoreSnapshot) {
      console.log(`  pre-restore snapshot kept at: ${result.preRestoreSnapshot}`);
    }
  } catch (error) {
    console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
