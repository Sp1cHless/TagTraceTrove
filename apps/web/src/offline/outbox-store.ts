import { randomUuid } from './random-id.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface PendingSyncOperationInput {
  clientId: string;
  libraryId: string;
  syncEpoch: string;
  entityKind: string;
  entityUid: string;
  operationKind: string;
  baseVersion: number;
  baseValues: { [key: string]: JsonValue };
  payload: { [key: string]: JsonValue };
}

export interface PendingSyncOperation extends PendingSyncOperationInput {
  opId: string;
  clientCreatedAt: string;
  status: 'pending' | 'conflict' | 'failed';
  lastAttemptAt: string | null;
  lastError: string | null;
}

export type EnqueueResult = 'queued' | 'duplicate';

export interface OutboxStore {
  enqueue(operation: PendingSyncOperation): Promise<EnqueueResult>;
  list(): Promise<PendingSyncOperation[]>;
  update(
    opId: string,
    patch: Partial<Pick<PendingSyncOperation, 'status' | 'lastAttemptAt' | 'lastError'>>,
  ): Promise<void>;
  remove(opId: string): Promise<void>;
  removeMany(opIds: string[]): Promise<void>;
}

interface OperationFactoryOptions {
  randomUUID?: () => string;
  now?: () => Date;
}

export function createPendingSyncOperation(
  input: PendingSyncOperationInput,
  options: OperationFactoryOptions = {},
): PendingSyncOperation {
  return {
    ...input,
    opId: (options.randomUUID ?? randomUuid)(),
    clientCreatedAt: (options.now ?? (() => new Date()))().toISOString(),
    status: 'pending',
    lastAttemptAt: null,
    lastError: null,
  };
}

export function operationFingerprint(operation: PendingSyncOperation): string {
  return JSON.stringify(canonicalize({
    opId: operation.opId,
    clientId: operation.clientId,
    libraryId: operation.libraryId,
    syncEpoch: operation.syncEpoch,
    entityKind: operation.entityKind,
    entityUid: operation.entityUid,
    operationKind: operation.operationKind,
    baseVersion: operation.baseVersion,
    baseValues: operation.baseValues,
    payload: operation.payload,
    clientCreatedAt: operation.clientCreatedAt,
  }));
}

function canonicalize(value: JsonValue | PendingSyncOperation): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item as JsonValue)]),
  );
}

function cloneOperation(operation: PendingSyncOperation): PendingSyncOperation {
  return structuredClone(operation);
}

export function createMemoryOutboxStore(): OutboxStore {
  let nextSequence = 1;
  const records = new Map<string, {
    sequence: number;
    fingerprint: string;
    operation: PendingSyncOperation;
  }>();

  return {
    async enqueue(operation) {
      const fingerprint = operationFingerprint(operation);
      const existing = records.get(operation.opId);
      if (existing !== undefined) {
        if (existing.fingerprint === fingerprint) return 'duplicate';
        throw new Error('Outbox operation ID already exists with different content');
      }
      records.set(operation.opId, {
        sequence: nextSequence,
        fingerprint,
        operation: cloneOperation(operation),
      });
      nextSequence += 1;
      return 'queued';
    },
    async list() {
      return [...records.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .map((record) => cloneOperation(record.operation));
    },
    async update(opId, patch) {
      const record = records.get(opId);
      if (record !== undefined) {
        record.operation = cloneOperation({ ...record.operation, ...patch });
      }
    },
    async remove(opId) {
      records.delete(opId);
    },
    async removeMany(opIds) {
      for (const opId of opIds) records.delete(opId);
    },
  };
}
