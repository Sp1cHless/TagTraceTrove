/**
 * Reproduces the import of one author folder through the real API functions.
 * Run from apps/server: node_modules/.bin/tsx ../../.hermes/tmp/reproduce-import.mts <author>
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { previewSiteProbeUpload } from '../../apps/server/src/import/upload-preview.js';

const EXPORTS = 'D:/Project/Dataextracted/site_probe/hitomi_la/exports';
const author = process.argv[2] ?? 'hews';
const folder = join(EXPORTS, author);

/** Mirrors the UI: the dropped folder's own name prefixes every relative path. */
async function jsonFiles(root: string, prefix: string): Promise<Array<{ path: string; file: File }>> {
  const found: Array<{ path: string; file: File }> = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...await jsonFiles(full, `${prefix}/${entry.name}`));
      continue;
    }
    if (!entry.name.toLocaleLowerCase().endsWith('.json')) continue;
    const buffer = await readFile(full);
    found.push({ path: `${prefix}/${entry.name}`, file: new File([buffer], entry.name, { type: 'application/json' }) });
  }
  return found;
}

const candidates = await jsonFiles(folder, author);
const rootCandidate = candidates
  .filter((candidate) => candidate.path.toLocaleLowerCase().endsWith('metadata.json'))
  .sort((left, right) => left.path.split('/').length - right.path.split('/').length)[0];
console.log(`json files: ${candidates.length}, root: ${rootCandidate?.path}`);
console.log(`staged bytes: ${Math.round(candidates.reduce((sum, c) => sum + c.file.size, 0) / 1024)} KiB`);

const formData = new FormData();
formData.set('rootPath', rootCandidate!.path);
for (const candidate of candidates) {
  formData.append('paths', candidate.path);
  formData.append('files', candidate.file, candidate.file.name);
}

try {
  const preview = await previewSiteProbeUpload(formData);
  console.log('PREVIEW OK — entries:', preview.entryCount, 'warnings:', preview.warnings);
  for (const entry of preview.batch.entries.slice(0, 3)) {
    console.log(`  ${entry.externalKey} | ${entry.title.slice(0, 60)}`);
  }
} catch (cause) {
  console.log('PREVIEW FAILED:', cause instanceof Error ? `${cause.name}: ${cause.message}` : cause);
}
