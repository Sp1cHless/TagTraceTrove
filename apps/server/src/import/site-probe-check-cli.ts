/** Pure probe boundary: parses scratch exports without opening the library or committing entries. */
import { loadSiteProbeExport } from './site-probe.js';

try {
  const metadataPath = process.argv[2];
  if (!metadataPath) throw new Error('A metadata path is required');
  const batch = await loadSiteProbeExport(metadataPath);
  if (batch.entries.length === 0) throw new Error('The export produces zero import entries');
  const identities = batch.entries.map((entry) => entry.externalKey);
  if (new Set(identities).size !== identities.length) throw new Error('Repeated import identities');
  console.log(JSON.stringify({ entries: batch.entries.length }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
