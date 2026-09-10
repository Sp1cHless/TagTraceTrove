import { resolve } from 'node:path';
import { backfillEntryThumbnails } from './thumbnail-backfill.js';

const assetRoot = resolve(process.env.T3_DATA_DIR ?? '.data', 'assets');
const abortController = new AbortController();
process.once('SIGINT', () => abortController.abort());
process.once('SIGTERM', () => abortController.abort());

const result = await backfillEntryThumbnails(assetRoot, {
  signal: abortController.signal,
  onProgress: ({ scanned, status }) => {
    if (status === 'failed' || scanned % 25 === 0) {
      console.log(`Thumbnail backfill: ${scanned} scanned (${status})`);
    }
  },
});
console.log(JSON.stringify({ assetRoot, ...result }, null, 2));
if (result.failed > 0) process.exitCode = 1;
if (result.interrupted) process.exitCode = 130;
