import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createImportPreview } from './preview.js';
import { loadSiteProbeExport } from './site-probe.js';

const [metadataPath, outputFlag, outputPath] = process.argv.slice(2);

if (!metadataPath) {
  console.error('Usage: pnpm import:site-probe <metadata.json> [--output <canonical.json>]');
  process.exitCode = 1;
} else {
  if ((outputFlag && outputFlag !== '--output') || (outputFlag === '--output' && !outputPath)) {
    throw new Error('Expected --output followed by a destination path');
  }

  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const batch = await loadSiteProbeExport(resolve(invocationDirectory, metadataPath));
  const preview = createImportPreview(batch);

  if (outputPath) {
    await writeFile(
      resolve(invocationDirectory, outputPath),
      `${JSON.stringify(batch, null, 2)}\n`,
      'utf8',
    );
  }

  console.log(JSON.stringify({ preview, outputPath: outputPath ?? null }, null, 2));
}