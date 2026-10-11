import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { syncReplayOperationSchema } from '../src/index.js';
it('pending metadata excludes its parent from exact captured patch keys', () => {
  const op = { opId: randomUUID(), clientId: 'test', libraryId: randomUUID(), syncEpoch: randomUUID(), entityKind: 'entry', entityUid: randomUUID(), clientCreatedAt: '2026-10-01T00:00:00Z', operationKind: 'entry.update', baseVersion: 0, baseValues: { title: 'Before' }, payload: { title: 'After', parentCreateOpId: randomUUID() } };
  expect(syncReplayOperationSchema.safeParse(op).success).toBe(true);
  expect(syncReplayOperationSchema.safeParse({ ...op, baseVersion: 1 }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({ ...op, payload: { title: 'After' } }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({ ...op, baseVersion: 1, payload: { title: 'After' } }).success).toBe(true);
  for (const payload of [{ parentCreateOpId: op.payload.parentCreateOpId }, { ...op.payload, pageCount: 1 }, { ...op.payload, parentCreateOpId: 'bad' }, { ...op.payload, type: 'comic' }]) expect(syncReplayOperationSchema.safeParse({ ...op, payload }).success).toBe(false);
});
