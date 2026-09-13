/**
 * Reproduces the commit half of an author-folder import on a COPY of the library.
 * Run from apps/server: node_modules/.bin/tsx ../../.hermes/tmp/reproduce-commit.mts <author>
 */
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitImportBatch } from '../../apps/server/src/import/commit.js';
import { loadSiteProbeExport } from '../../apps/server/src/import/site-probe.js';

const require = createRequire('D:/Project/TagTraceTrove/apps/server/package.json');
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const author = process.argv[2] ?? 'hews';
const source = new Database('D:/Project/TagTraceTrove/apps/server/.data/library.db', {
  readonly: true,
  fileMustExist: true,
});
const copyPath = join(mkdtempSync(join(tmpdir(), `t3-commit-${author}-`)), 'library-copy.db');
await source.backup(copyPath);
source.close();
const database = new Database(copyPath);

const metadataPath = `D:/Project/Dataextracted/site_probe/hitomi_la/exports/${author}/metadata.json`;
const batch = await loadSiteProbeExport(metadataPath, { preserveRelativeMediaPaths: true });
console.log(`batch: ${batch.entries.length} entries, warnings: ${batch.warnings.length}`);
const fields = new Set(batch.entries.flatMap((entry) => Object.keys(entry.fields ?? {})));
console.log('fields present:', [...fields].join(', '));

const mapping = {
  entryType: 'Comic',
  canonicalTagFacetId: 132,
  sourceContentType: 'Source URL',
  externalKeyContentType: 'External Key',
  fieldMappings: {
    authors: { kind: 'producer' as const, createUnmatched: true, existingProducerIds: {} },
    works: { kind: 'tag' as const, facetId: 128 },
    characters: { kind: 'tag' as const, facetId: 129 },
    language: { kind: 'tag' as const, facetId: 130 },
    contentTypes: { kind: 'tag' as const, facetId: 127 },
  },
  ignoredFields: [] as string[],
  authorRatings: [] as Array<{ name: string; slotName: string; stars: number }>,
};

try {
  const result = commitImportBatch(database, batch, mapping);
  console.log('COMMIT OK:', JSON.stringify({
    entryCount: result.entryCount,
    createdProducerCount: result.createdProducerCount,
    tagAssignmentCount: result.tagAssignmentCount,
    contentCount: result.contentCount,
  }));
  console.log(`warnings (${result.warnings.length}):`);
  for (const warning of result.warnings) console.log('  -', warning);
} catch (cause) {
  const error = cause as Error;
  console.log('COMMIT FAILED:', error.name, '|', error.message);
  console.log((error.stack ?? '').split('\n').slice(0, 6).join('\n'));
}
database.close();
