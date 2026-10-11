// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { buildPendingWorkExport } from '../src/offline/pending-work-export.js';

const operation = createPendingSyncOperation({
  clientId: 'client-1', libraryId: 'library-1', syncEpoch: 'epoch-1',
  entityKind: 'entry', entityUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  operationKind: 'entry.update', baseVersion: 1, baseValues: { title: 'before' },
  payload: { title: 'after' },
}, { randomUUID: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', now: () => new Date('2026-09-26T00:00:00Z') });

describe('pending work export', () => {
  it('preserves exact Outbox fields and binary media for a forensic backup', async () => {
    const blob = new Blob([new Uint8Array([0, 255, 42])], { type: 'image/png' });
    const result = await buildPendingWorkExport({
      list: async () => [operation],
      listMedia: async () => [{
        uploadId: 'upload-1', libraryId: 'library-1', syncEpoch: 'epoch-1',
        entryUid: operation.entityUid, kind: 'cover', ordinal: 0,
        mimeType: 'image/png', byteLength: 3, sha256: 'sha-1', blob,
        status: 'pending', lastAttemptAt: null, lastError: null,
      }],
    }, new Date('2026-09-26T01:00:00Z'));
    expect(result).toMatchObject({
      format: 't3-pending-work-v1', exportedAt: '2026-09-26T01:00:00.000Z',
      operations: [operation], media: [{ uploadId: 'upload-1', base64: 'AP8q', byteLength: 3 }],
    });
    expect(Object.hasOwn(result.media[0]!, 'blob')).toBe(false);
  });
});
