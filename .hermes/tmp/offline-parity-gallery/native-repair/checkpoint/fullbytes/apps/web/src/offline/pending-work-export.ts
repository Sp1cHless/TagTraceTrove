import type { MediaOutboxStore, StagedMediaUpload } from './media-outbox-store.js';
import type { OutboxStore, PendingSyncOperation } from './outbox-store.js';

const MAX_EXPORT_MEDIA_BYTES = 64 * 1024 * 1024;

export interface PendingWorkExport {
  format: 't3-pending-work-v1';
  exportedAt: string;
  operations: PendingSyncOperation[];
  media: Array<Omit<StagedMediaUpload, 'blob'> & { base64: string }>;
}

/**
 * Forensic, user-directed export, not an automatic replay/import format. The
 * entire ordered Outbox and every staged Blob are included; never claim success
 * after truncating an image or omitting a pending operation.
 */
export async function buildPendingWorkExport(
  store: Pick<OutboxStore, 'list'> & Pick<MediaOutboxStore, 'listMedia'>,
  now = new Date(),
): Promise<PendingWorkExport> {
  const [operations, uploads] = await Promise.all([store.list(), store.listMedia()]);
  const totalBytes = uploads.reduce((total, upload) => total + upload.byteLength, 0);
  if (totalBytes > MAX_EXPORT_MEDIA_BYTES) {
    throw new Error('Pending images exceed the safe single-file export limit (64 MiB); keep the device intact and sync first');
  }
  const media: PendingWorkExport['media'] = [];
  for (const { blob, ...upload } of uploads) {
    if (blob.size !== upload.byteLength) {
      throw new Error(`Staged image ${upload.uploadId} has a byte-length mismatch; refusing an incomplete export`);
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 16_384) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
    }
    media.push({ ...upload, base64: btoa(binary) });
  }
  return { format: 't3-pending-work-v1', exportedAt: now.toISOString(), operations, media };
}
