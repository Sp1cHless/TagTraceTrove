import { describe, expect, it } from 'vitest';
import { createMigratedMemoryDatabase } from '../../src/database/testing.js';
import { createEntry } from '../../src/repositories/entry-repository.js';
import { setGalleryOrder } from '../../src/repositories/gallery-order-repository.js';
import { buildSyncSnapshot, buildSyncCapabilities } from '../../src/sync/sync-service.js';

import { randomUUID } from 'node:crypto';
import { syncReplayOperationSchema } from '@t3/shared';
import { replaySyncOperation } from '../../src/sync/replay-service.js';

describe('Gallery order sync owner', () => {
  it('replays with durable exact receipts and conflicts with an online peer on the same owner', () => {
    const db = createMigratedMemoryDatabase();
    try {
      for (const type of ['Alpha', 'Hidden', 'Zebra']) createEntry(db, { title: type, type });
      const snapshot = buildSyncSnapshot(db);
      const scope = snapshot.payload.galleryOrder!;
      const raw = { opId: randomUUID(), clientId: 'phone', libraryId: snapshot.header.libraryId, syncEpoch: snapshot.header.syncEpoch,
        entityKind: 'gallery_order', entityUid: scope.syncUid, clientCreatedAt: '2026-10-08', operationKind: 'gallery.order.set',
        baseVersion: scope.syncVersion, baseValues: { orderedTypes: scope.orderedTypes }, payload: { orderedTypes: ['Zebra', 'Hidden', 'Alpha'] } };
      const operation = syncReplayOperationSchema.parse(raw);
      const applied = replaySyncOperation(db, operation);
      expect(applied).toMatchObject({ status: 'applied', resourceVersion: 2 });
      expect(replaySyncOperation(db, operation)).toEqual(applied);
      expect(replaySyncOperation(db, syncReplayOperationSchema.parse({ ...raw, payload: { orderedTypes: ['Hidden','Alpha','Zebra'] } })))
        .toMatchObject({ status: 'failed', errorCode: 'operation-id-collision' });
      const base = buildSyncSnapshot(db).payload.galleryOrder!;
      setGalleryOrder(db, ['Alpha', 'Hidden', 'Zebra']);
      const stale = syncReplayOperationSchema.parse({ ...raw, opId: randomUUID(), baseVersion: base.syncVersion,
        baseValues: { orderedTypes: base.orderedTypes }, payload: { orderedTypes: ['Hidden', 'Zebra', 'Alpha'] } });
      expect(replaySyncOperation(db, stale)).toMatchObject({ status: 'conflict', currentVersion: 3 });
      expect(buildSyncSnapshot(db).payload.galleryOrder!.orderedTypes).toEqual(['Alpha','Hidden','Zebra']);
      expect(syncReplayOperationSchema.safeParse({ ...raw, payload: { orderedTypes: ['Alpha','Zebra'] } }).success).toBe(false);
    } finally { db.close(); }
  });
  it('captures the complete server order with an independently journaled revision', () => {
    const db = createMigratedMemoryDatabase();
    try {
      createEntry(db, { title: 'A', type: 'Alpha' });
      createEntry(db, { title: 'Z', type: 'Zebra' });
      const before = buildSyncSnapshot(db);
      setGalleryOrder(db, ['Zebra', 'Alpha']);
      const after = buildSyncSnapshot(db);
      expect(after.payload).toMatchObject({ galleryOrder: { orderedTypes: ['Zebra', 'Alpha'], syncVersion: 2 } });
      expect(after.header.changeSeq).toBeGreaterThan(before.header.changeSeq!);
      expect(buildSyncCapabilities(db, 'test').featureFlags.offlineGalleryOrder).toBe(true);
      expect(db.prepare("SELECT entity_kind FROM sync_changes ORDER BY seq DESC LIMIT 1").pluck().get()).toBe('gallery_order');
    } finally { db.close(); }
  });
});
