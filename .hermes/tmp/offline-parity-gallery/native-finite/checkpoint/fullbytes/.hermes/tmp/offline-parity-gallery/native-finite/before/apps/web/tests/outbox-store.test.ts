// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  createMemoryOutboxStore,
  createPendingSyncOperation,
  type PendingSyncOperationInput,
} from '../src/offline/outbox-store.js';

const baseInput: PendingSyncOperationInput = {
  clientId: '11111111-1111-4111-8111-111111111111',
  libraryId: 'library-1',
  syncEpoch: 'epoch-1',
  entityKind: 'entry',
  entityUid: '22222222-2222-4222-8222-222222222222',
  operationKind: 'entry.patch',
  baseVersion: 3,
  baseValues: { title: 'Before' },
  payload: { title: 'After' },
};

function operation(overrides: Partial<PendingSyncOperationInput> = {}) {
  return createPendingSyncOperation(
    { ...baseInput, ...overrides },
    {
      randomUUID: () => '33333333-3333-4333-8333-333333333333',
      now: () => new Date('2026-09-14T12:00:00.000Z'),
    },
  );
}

describe('durable outbox domain store', () => {
  it('creates one stable operation identity and timestamp', () => {
    expect(operation()).toEqual({
      ...baseInput,
      opId: '33333333-3333-4333-8333-333333333333',
      clientCreatedAt: '2026-09-14T12:00:00.000Z',
      status: 'pending',
      lastAttemptAt: null,
      lastError: null,
    });
  });

  it('keeps insertion order and removes only an acknowledged operation', async () => {
    const store = createMemoryOutboxStore();
    const first = operation();
    const second = operation({
      operationKind: 'rating.set',
      entityKind: 'rating',
      entityUid: '44444444-4444-4444-8444-444444444444',
    });
    second.opId = '55555555-5555-4555-8555-555555555555';

    expect(await store.enqueue(first)).toBe('queued');
    expect(await store.enqueue(second)).toBe('queued');
    expect(await store.list()).toEqual([first, second]);

    await store.update(first.opId, {
      status: 'conflict',
      lastAttemptAt: '2026-09-14T12:01:00.000Z',
      lastError: 'newer server value',
    });
    expect((await store.list())[0]).toMatchObject({
      status: 'conflict',
      lastAttemptAt: '2026-09-14T12:01:00.000Z',
      lastError: 'newer server value',
    });
    expect(await store.enqueue(first)).toBe('duplicate');

    await store.removeMany([first.opId, 'missing-op-id']);
    expect(await store.list()).toEqual([second]);
  });

  it('accepts an exact retry but rejects an operation-id collision with changed content', async () => {
    const store = createMemoryOutboxStore();
    const first = operation();
    await store.enqueue(first);

    expect(await store.enqueue({
      ...first,
      baseValues: { title: 'Before' },
      payload: { title: 'After' },
    })).toBe('duplicate');
    await expect(store.enqueue({
      ...first,
      payload: { title: 'Different' },
    })).rejects.toThrow('operation ID already exists with different content');
    expect(await store.list()).toEqual([first]);
  });
});
