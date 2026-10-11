import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from '../../apps/server/node_modules/sharp/lib/index.js';
import { ensureEntryThumbnail, resolveEntryThumbnail, readEntryThumbnail, readEntryMedia } from '../../apps/server/src/import/media.ts';
const root = await mkdtemp(join(tmpdir(), 't3-preview-thumbnail-probe-'));
try {
  const file = `preview.${randomUUID()}.png`;
  const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#3183ef' } }).png().toBuffer();
  await mkdir(join(root, 'entries', '1'), { recursive: true });
  await writeFile(join(root, 'entries', '1', file), bytes);
  const thumbnailRef = await ensureEntryThumbnail(root, 1, file);
  const resolved = await resolveEntryThumbnail(root, 1, file);
  const original = await readEntryMedia(root, 1, file);
  const thumbnail = await readEntryThumbnail(root, 1, basename(thumbnailRef));
  const result = { originalServed: original !== null, generatedThumbnailRef: thumbnailRef, snapshotThumbnailResolved: resolved === thumbnailRef, generatedThumbnailServed: thumbnail !== null };
  console.log(JSON.stringify(result));
  await writeFile('.hermes/tmp/preview-parent-thumbnail-red.json', JSON.stringify(result, null, 2));
  if (thumbnail === null) process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
