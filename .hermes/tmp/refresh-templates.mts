// Refresh every Gallery's exported template files so the stored JSON carries its Content kinds.
// Read-only against the database: this only rewrites the two export files per Gallery.
import { createRequire } from 'node:module';
import { openDatabase } from '../../apps/server/src/database/connection.js';
import { templatesDirFor, writeTemplateFiles } from '../../apps/server/src/repositories/template-export.js';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/');
void require;

const databasePath = 'D:/Project/TagTraceTrove/apps/server/.data/library.db';
const database = openDatabase(databasePath);
const dir = templatesDirFor(databasePath);

const types = database.prepare(
    'SELECT DISTINCT entry_type AS type FROM tag_groups ORDER BY entry_type COLLATE NOCASE',
).all() as Array<{ type: string }>;

for (const { type } of types) {
  const written = writeTemplateFiles(database, type, dir);
  console.log(`${type}: ${written.templatePath}`);
}
database.close();
