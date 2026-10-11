import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { syncReplayOperationSchema } from '../src/index.js';
it('accepts pending existing Author sets only with a zero version and parent UUID', () => {
  const op = { opId: randomUUID(), clientId: 'test', libraryId: randomUUID(), syncEpoch: randomUUID(), entityKind: 'entry', entityUid: randomUUID(), clientCreatedAt: '2026-09-25T00:00:00Z', operationKind: 'entry.authors.set', baseVersion: 0, baseValues: { producerUids: [] }, payload: { parentCreateOpId: randomUUID(), producerUids: [randomUUID()] } };
  expect(syncReplayOperationSchema.safeParse(op).success).toBe(true);
  expect(syncReplayOperationSchema.safeParse({ ...op, baseVersion: 1 }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({ ...op, payload: { producerUids: op.payload.producerUids } }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({ ...op, baseVersion: 1, payload: { producerUids: op.payload.producerUids } }).success).toBe(true);
  for (const payload of [{ ...op.payload, parentCreateOpId: 'bad' }, { ...op.payload, producerUids: [...op.payload.producerUids, ...op.payload.producerUids] }, { ...op.payload, producerUids: [] }, { ...op.payload, producerUids: ['local:bad'] }]) expect(syncReplayOperationSchema.safeParse({ ...op, payload }).success).toBe(false);
});
