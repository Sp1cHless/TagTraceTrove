import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { importBatchSchema, importCommitMappingSchema } from '@t3/shared';
import { openDatabase } from '../database/connection.js';
import { applyAllMigrations } from '../database/migrations.js';
import { commitImportBatch } from './commit.js';

const [canonicalPath, mappingPath, databasePath, confirmation] = process.argv.slice(2);

if (!canonicalPath || !mappingPath || !databasePath || confirmation !== '--commit') {
  console.error(
    'Usage: pnpm import:commit <canonical.json> <mapping.json> <database-path> --commit',
  );
  process.exitCode = 1;
} else {
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const resolvedCanonicalPath = resolve(invocationDirectory, canonicalPath);
  const resolvedMappingPath = resolve(invocationDirectory, mappingPath);
  const resolvedDatabasePath = resolve(invocationDirectory, databasePath);
  const [batchDocument, mappingDocument] = await Promise.all([
    readFile(resolvedCanonicalPath, 'utf8'),
    readFile(resolvedMappingPath, 'utf8'),
  ]);
  const batch = importBatchSchema.parse(JSON.parse(batchDocument) as unknown);
  const mapping = importCommitMappingSchema.parse(JSON.parse(mappingDocument) as unknown);
  mkdirSync(dirname(resolvedDatabasePath), { recursive: true });
  const database = openDatabase(resolvedDatabasePath);

  try {
    applyAllMigrations(database);
    const result = commitImportBatch(database, batch, mapping);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    database.close();
  }
}
