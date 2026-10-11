import { dirname } from 'node:path';
import { resolveCliDatabasePath } from './cli-path.js';
import { createLibraryBackup } from './backup-restore.js';

// Usage: tsx src/database/backup-cli.ts [databasePath]
// Defaults to .data/library.db relative to the server package (like the dev server).
const databasePath = resolveCliDatabasePath(process.argv[2], process.env.INIT_CWD ?? process.cwd());

try {
  const result = await createLibraryBackup({
    databasePath,
    dataDir: dirname(databasePath),
  });
  console.log(`PASS backup created`);
  console.log(`  directory: ${result.backupDir}`);
  console.log(`  entries: ${result.manifest.entryCount}, producers: ${result.manifest.producerCount}`);
  console.log(`  created: ${result.manifest.createdAt}`);
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
