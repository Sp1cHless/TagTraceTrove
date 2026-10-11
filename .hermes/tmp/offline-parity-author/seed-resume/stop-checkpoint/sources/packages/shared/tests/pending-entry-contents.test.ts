import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { syncReplayOperationSchema } from '../src/index.js';

it('accepts pending replacement/removal with an explicit parent and preserves positive envelopes', () => {
  const row = { syncUid: randomUUID(), contentType: 'Note', content: 'original', sortOrder: 0 };
  const op = { opId: randomUUID(), clientId: 'test', libraryId: randomUUID(), syncEpoch: randomUUID(), entityKind: 'entry', entityUid: randomUUID(), clientCreatedAt: '2026-09-25T00:00:00Z', operationKind: 'entry.contents.set', baseVersion: 0, baseValues: { contents: [row] }, payload: { parentCreateOpId: randomUUID(), contents: [] } };
  expect(syncReplayOperationSchema.safeParse(op).success).toBe(true);
  expect(syncReplayOperationSchema.safeParse({ ...op, payload: { ...op.payload, contents: [{ ...row, content: '   ' }] } }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({ ...op, baseVersion: 1 }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({ ...op, payload: { contents: [] } }).success).toBe(false);
  expect(syncReplayOperationSchema.safeParse({ ...op, baseVersion: 1, payload: { contents: [] } }).success).toBe(true);
});
