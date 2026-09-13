/**
 * Runs the real importer loader over the folders that previously failed.
 * Run from apps/server: node_modules/.bin/tsx ../../.hermes/tmp/verify-hitomi-imports.mts
 */
import { join } from 'node:path';
import { loadSiteProbeExport } from '../../apps/server/src/import/site-probe.js';

const EXPORTS = 'D:/Project/Dataextracted/site_probe/hitomi_la/exports';

const targets = [
  'bonnie',        // 2 items with null language (user fixed by hand)
  'dmm.com',       // 9 items with null language
  'mushi',         // 2 items with null language
  'sole_work',     // manifest lists 888260 with no metadata.json
  'artist_dmm.com', // no root metadata.json at all
  'abe_inori',     // healthy control
];

for (const author of targets) {
  const metadataPath = join(EXPORTS, author, 'metadata.json');
  try {
    const batch = await loadSiteProbeExport(metadataPath);
    const withoutLanguage = batch.entries.filter((entry) => entry.fields?.language === undefined).length;
    console.log(
      `OK   ${author}: ${batch.entries.length} entries,`
      + ` ${withoutLanguage} without a language tag, warnings: ${batch.warnings.length}`,
    );
    for (const warning of batch.warnings) console.log(`       ! ${warning}`);
  } catch (cause) {
    console.log(`FAIL ${author}: ${(cause as Error).message.split('\n')[0]}`);
  }
}
