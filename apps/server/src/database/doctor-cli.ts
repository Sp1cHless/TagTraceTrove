import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { inspectDatabase } from './doctor.js';
import { createMigratedMemoryDatabase } from './testing.js';

const databasePath = process.argv[2];
const database = databasePath
  ? new Database(resolve(process.env.INIT_CWD ?? process.cwd(), databasePath), {
      readonly: true,
      fileMustExist: true,
    })
  : createMigratedMemoryDatabase();

try {
  database.pragma('foreign_keys = ON');
  const result = inspectDatabase(database);
  if (result.ok) {
    console.log('PASS database integrity, foreign keys, and application invariants');
  } else {
    for (const issue of result.issues) {
      console.error(`FAIL ${issue}`);
    }
    process.exitCode = 1;
  }
} finally {
  database.close();
}
