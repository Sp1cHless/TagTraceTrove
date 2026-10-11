import { describe, expect, it } from 'vitest';
import { syncReplayOperationSchema } from '../src/schemas/sync.js';

const operation = {
  opId: '11111111-1111-4111-8111-111111111111', clientId: 'client',
  libraryId: 'library', syncEpoch: 'epoch', entityKind: 'entry',
  entityUid: '22222222-2222-4222-8222-222222222222',
  clientCreatedAt: '2026-09-27T12:00:00.000Z', operationKind: 'entry.create',
  baseVersion: 0, baseValues: {}, payload: {
    title: 'Offline', type: 'game', uploadDate: null, pageCount: null,
    ratings: [], viewLater: false,
  },
} as const;

const content = { syncUid: '33333333-3333-4333-8333-333333333333', contentType: 'Source URL', content: 'https://example.test/a', sortOrder: 0 };

describe('initial Content in offline Entry creation', () => {
  it('accepts stable Content rows and keeps old create operations compatible', () => {
    expect(syncReplayOperationSchema.parse(operation).payload).toMatchObject(operation.payload);
    expect(syncReplayOperationSchema.parse({ ...operation, payload: { ...operation.payload, contents: [content] } }).payload)
      .toMatchObject({ contents: [content] });
  });
  it('rejects repeated Content UUIDs and unknown Content fields', () => {
    expect(syncReplayOperationSchema.safeParse({ ...operation, payload: { ...operation.payload, contents: [content, content] } }).success).toBe(false);
    expect(syncReplayOperationSchema.safeParse({ ...operation, payload: { ...operation.payload, contents: [{ ...content, unexpected: true }] } }).success).toBe(false);
  });
});
