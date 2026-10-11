import { File } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const requireServer = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const sharp = requireServer('sharp') as typeof import('../../apps/server/node_modules/sharp');
import { createMigratedMemoryDatabase } from '../../apps/server/src/database/testing.js';
import { createEntry } from '../../apps/server/src/repositories/entry-repository.js';
import { storeEntryMedia, entryMediaRefs } from '../../apps/server/src/import/media.js';
import { getSyncIdentity, buildSyncSnapshot } from '../../apps/server/src/sync/sync-service.js';
import { createMemoryOfflineStore } from '../../apps/web/src/offline/memory-offline-store.js';
import { createOfflineAwareGalleryApi } from '../../apps/web/src/offline/offline-api.js';
import type { GalleryApi } from '../../apps/web/src/api/gallery.js';
import { replayEntryMediaOperation } from '../../apps/server/src/sync/replay-service.js';
import type { SyncEntryMediaOperation } from '@t3/shared';

const db = createMigratedMemoryDatabase();
const assets = await mkdtemp(join(tmpdir(), 't3-preview-diagnosis-'));
try {
  const entry = createEntry(db, { title: 'Disposable preview diagnosis', type: 'Comic' });
  const refs: string[] = [];
  for (const [index, color] of ['#ff0000', '#00ff00', '#0000ff', '#ffff00'].entries()) {
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: color } }).png().toBuffer();
    const stored = await storeEntryMedia(db, assets, { entryId: entry.id, kind: index === 0 ? 'cover' : 'preview', mimeType: 'image/png', bytes });
    refs.push(stored.relativeRef);
  }
  const identity = getSyncIdentity(db);
  const row = db.prepare('SELECT sync_uid AS uid, sync_version AS version FROM entries WHERE id = ?').get(entry.id) as { uid: string; version: number };
  const afterFirst = [refs[0]!, refs[2]!, refs[3]!];
  const op = (id: string, base: string[], desired: string[], version: number): SyncEntryMediaOperation => ({ opId: id, clientId: 'disposable-diagnosis', libraryId: identity.libraryId, syncEpoch: identity.syncEpoch, entityKind: 'entry', entityUid: row.uid, operationKind: 'entry.media.set', baseVersion: version, baseValues: { refs: base }, payload: { refs: desired }, clientCreatedAt: '2026-10-08T00:00:00.000Z' });
  const first = await replayEntryMediaOperation(db, assets, op('11111111-1111-4111-8111-111111111111', refs, afterFirst, row.version));
  const second = await replayEntryMediaOperation(db, assets, op('22222222-2222-4222-8222-222222222222', afterFirst, [refs[0]!, refs[3]!], row.version + 1));
  const state = db.prepare('SELECT cover_ref AS coverRef, preview_refs AS previewRefs FROM entries WHERE id = ?').get(entry.id) as { coverRef: string | null; previewRefs: string };
  console.log(JSON.stringify({ first, second, actualRefs: entryMediaRefs({ coverRef: state.coverRef, previewRefs: JSON.parse(state.previewRefs) }) }, null, 2));
  const store = createMemoryOfflineStore();
  const snapshot = buildSyncSnapshot(db);
  await store.writeGeneration(1, JSON.stringify(snapshot));
  await store.writeMeta('activeGeneration', '1');
  await store.writeMeta('capability.offlineEntryMediaOrder', '1');
  let networkCalls = 0;
  const online = { replaySyncOperation: async () => { networkCalls += 1; throw new Error('diagnostic should reject before network'); } } as unknown as GalleryApi;
  const api = createOfflineAwareGalleryApi(online, store, { clientId: 'disposable-facade' });
  await api.preferOfflineSnapshot!();
  await api.setEntryMediaOrder!(entry.id, [state.coverRef!]);
  await api.replayOfflineOperations!();
  console.log('facade-replay', JSON.stringify({ networkCalls, queue: (await store.list()).map(row => ({ kind: row.operationKind, status: row.status, error: row.lastError })) }));
  const mixed = createMemoryOfflineStore();
  await mixed.writeGeneration(1, JSON.stringify(snapshot));
  await mixed.writeMeta('activeGeneration', '1');
  for (const flag of ['existingEntryMedia', 'offlineMediaMultiplePreviews', 'offlineEntryMediaOrder']) await mixed.writeMeta(`capability.${flag}`, '1');
  const mixedApi = createOfflineAwareGalleryApi({} as GalleryApi, mixed, { clientId: 'disposable-mixed' });
  await mixedApi.preferOfflineSnapshot!();
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ee00ee' } }).png().toBuffer();
  await mixedApi.uploadEntryMedia(entry.id, 'preview', new File([bytes], 'new.png', { type: 'image/png' }) as unknown as globalThis.File);
  const added = await mixedApi.getEntry(entry.id);
  const originalRefs = [state.coverRef!, ...JSON.parse(state.previewRefs) as string[]];
  await mixedApi.setEntryMediaOrder!(entry.id, originalRefs);
  const deleted = await mixedApi.getEntry(entry.id);
  console.log('append-then-delete', JSON.stringify({ before: originalRefs, afterAppend: [added.coverRef, ...added.previewRefs], afterDelete: [deleted.coverRef, ...deleted.previewRefs], pendingUploads: (await mixed.listMedia()).length, operations: (await mixed.list()).length }));
} finally {
  db.close();
  await rm(assets, { recursive: true, force: true });
}
