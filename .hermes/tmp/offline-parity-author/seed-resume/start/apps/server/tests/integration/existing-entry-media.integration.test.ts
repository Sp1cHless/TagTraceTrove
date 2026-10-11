import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { syncMediaUploadMetadataSchema } from '@t3/shared';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { setGalleryPartition } from '../../src/repositories/partition-repository.js';
import { createEntry, updateEntry } from '../../src/repositories/entry-repository.js';
import { getSyncIdentity } from '../../src/sync/sync-service.js';
import { replaySyncMediaUpload } from '../../src/sync/media-replay-service.js';

describe('existing Entry immutable media target', () => {
  it('negotiates existingEntryMedia and accepts the real multipart endpoint without a create operation', async () => {
    const database = createMigratedMemoryDatabase();
    const root = mkdtempSync(join(tmpdir(), 't3-existing-media-api-'));
    try {
      const { createApiApp } = await import('../../src/http/app.js');
      const app = createApiApp(database, { assetRoot: root });
      const entry = createEntry(database, { title: 'Existing API', type: 'comic' });
      const entryUid = database.prepare('SELECT sync_uid FROM entries WHERE id = ?').pluck().get(entry.id);
      const capabilities = await (await app.request('/api/sync/capabilities')).json();
      expect(capabilities.featureFlags.existingEntryMedia).toBe(true);
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#336699ff' } }).png().toBuffer();
      const metadata = { ...getSyncIdentity(database), entryUid, kind: 'cover', ordinal: 0,
        mimeType: 'image/png', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        existingEntry: { expectedCoverRef: null, expectedPreviewRefs: [] } };
      const uploadId = randomUUID();
      const send = async (value: typeof metadata) => {
        const form = new FormData();
        form.set('metadata', JSON.stringify(value));
        form.set('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'cover.png');
        return app.request(`/api/sync/media/${uploadId}`, { method: 'PUT', body: form });
      };
      const response = await send(metadata);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.entityId).toBe(entry.id);
      expect(await (await send(metadata)).json()).toEqual(result);
      expect((await send({ ...metadata, entryUid: randomUUID() })).status).toBe(409);
      expect(database.prepare('SELECT COUNT(*) FROM entries').pluck().get()).toBe(1);
      expect(database.prepare('SELECT COUNT(*) FROM sync_offline_created_entries').pluck().get()).toBe(0);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it('accepts an explicit UID target, retries its receipt and rejects changed target or concurrent media state', async () => {
    const database = createMigratedMemoryDatabase();
    const root = mkdtempSync(join(tmpdir(), 't3-existing-media-'));
    try {
      setGalleryPartition(database, 'game', true);
      const entry = createEntry(database, { title: 'Existing', type: 'game' });
      const entryUid = database.prepare('SELECT sync_uid FROM entries WHERE id = ?').pluck().get(entry.id);
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#336699ff' } }).png().toBuffer();
      const metadata = syncMediaUploadMetadataSchema.parse({
        ...getSyncIdentity(database), entryUid, kind: 'preview', ordinal: 0,
        mimeType: 'image/png', byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        existingEntry: { expectedCoverRef: null, expectedPreviewRefs: [] },
      });
      const uploadId = randomUUID();
      const result = await replaySyncMediaUpload(database, root, uploadId, metadata, bytes);
      expect(result.entityId).toBe(entry.id);
      expect(readFileSync(join(root, result.relativeRef.replace('/api/assets/', '')))).toEqual(bytes);
      await expect(replaySyncMediaUpload(database, root, uploadId, metadata, bytes)).resolves.toEqual(result);
      await expect(replaySyncMediaUpload(database, root, uploadId, { ...metadata,
        existingEntry: { expectedCoverRef: '/changed', expectedPreviewRefs: [] },
      }, bytes)).rejects.toMatchObject({ code: 'upload-id-collision' });
      const next = { ...metadata, ordinal: 1,
        existingEntry: { expectedCoverRef: null, expectedPreviewRefs: [result.relativeRef] } };
      await expect(replaySyncMediaUpload(database, root, randomUUID(), next, bytes, {
        stageWrite: async (filename, content) => {
          await writeFile(filename, content);
          if (!filename.includes('thumbnails')) updateEntry(database, entry.id, { previewRefs: [] });
        },
      })).rejects.toMatchObject({ code: 'media-state-conflict' });
      expect(database.prepare('SELECT COUNT(*) FROM sync_media_upload_receipts').pluck().get()).toBe(1);
      await expect(replaySyncMediaUpload(database, root, randomUUID(), {
        ...metadata, existingEntry: undefined,
      }, bytes)).rejects.toMatchObject({ code: 'entry-not-staged-create' });
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
