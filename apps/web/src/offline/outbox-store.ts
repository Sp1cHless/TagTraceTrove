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
  /** Atomically remove covered rows, retaining creates with uncovered children. */
  removeApplied(opIds: string[]): Promise<void>;
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

export function appliedRemovalIds(operations: PendingSyncOperation[], opIds: string[]): string[] {
  const covered = new Set(opIds);
  const retained = new Set(operations.filter(row => !covered.has(row.opId)).map(row => row.opId));
  let changed = true;
  while (changed) {
    changed = false;
    for (const child of operations.filter(row => retained.has(row.opId))) {
      for (const parent of operations) {
        if ((dependsOnEntryCreate(child, parent) || producerDependencies(child).some(dep => matchesProducerParent(child, parent, dep)) || vocabularyDependencies(child).some(dep => matchesVocabularyParent(child, parent, dep))) && !retained.has(parent.opId)) {
          retained.add(parent.opId); changed = true;
        }
      }
    }
  }
  return operations.filter(row => covered.has(row.opId) && !retained.has(row.opId)).map(row => row.opId);
}

function dependsOnEntryCreate(child: PendingSyncOperation, parent: PendingSyncOperation): boolean {
  const origin=child.payload.typeOwnerOrigin;
  if(child.operationKind==='gallery.partition.set' && origin && typeof origin==='object' && !Array.isArray(origin))return parent.operationKind==='entry.create' && origin.opId===parent.opId && origin.entityUid===parent.entityUid && parent.payload.partitionScopeUid===child.entityUid && parent.payload.type===child.payload.entryType && parent.clientId===child.clientId && parent.libraryId===child.libraryId && parent.syncEpoch===child.syncEpoch;
  return parent.operationKind === 'entry.create'
    && typeof child.payload.parentCreateOpId === 'string' && child.payload.parentCreateOpId.toLowerCase() === parent.opId.toLowerCase()
    && child.entityKind === parent.entityKind && child.entityUid.toLowerCase() === parent.entityUid.toLowerCase()
    && child.clientId === parent.clientId && child.libraryId === parent.libraryId
    && child.syncEpoch === parent.syncEpoch;
}

interface VocabularyDependency { kind: 'tag' | 'facet'; uid: string; createOpId: string }

function vocabularyDependencies(operation: PendingSyncOperation): VocabularyDependency[] {
  const dependencies: VocabularyDependency[] = [];
  for (const kind of ['tag', 'facet'] as const) {
    const value = operation.payload[kind === 'tag' ? 'tagCreates' : 'facetCreates'];
    if (value === undefined) continue;
    if (operation.operationKind !== 'entry.tags.set' || !Array.isArray(value)) throw new Error('Invalid Tag or Facet dependency');
    for (const row of value) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid Tag or Facet dependency');
      const uid = row[kind === 'tag' ? 'tagUid' : 'facetUid'];
      if (typeof uid !== 'string' || typeof row.createOpId !== 'string') throw new Error('Invalid Tag or Facet dependency');
      dependencies.push({ kind, uid, createOpId: row.createOpId });
    }
  }
  return dependencies;
}

function matchesVocabularyParent(child: PendingSyncOperation, parent: PendingSyncOperation, dep: VocabularyDependency): boolean {
  return parent.operationKind === `entry.${dep.kind}.create` && parent.entityKind === `entry_${dep.kind}`
    && parent.opId.toLowerCase() === dep.createOpId.toLowerCase() && parent.entityUid.toLowerCase() === dep.uid.toLowerCase()
    && parent.clientId === child.clientId && parent.libraryId === child.libraryId && parent.syncEpoch === child.syncEpoch;
}

function producerDependencies(operation: PendingSyncOperation): Array<{producerUid:string;createOpId:string}> {
  const value = operation.payload.producerCreates;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object' || Array.isArray(row) || typeof row.producerUid !== 'string' || typeof row.createOpId !== 'string')) throw new Error('Invalid Producer dependency');
  return value as Array<{producerUid:string;createOpId:string}>;
}
function matchesProducerParent(child: PendingSyncOperation, parent: PendingSyncOperation, dep: {producerUid:string;createOpId:string}): boolean {
  return ((parent.entityKind === 'producer' && parent.operationKind === 'producer.create' && parent.entityUid.toLowerCase() === dep.producerUid.toLowerCase())
    || (parent.entityKind === 'entry' && parent.operationKind === 'entry.author.create-and-link' && typeof parent.payload.producerUid === 'string' && parent.payload.producerUid.toLowerCase() === dep.producerUid.toLowerCase()))
    && parent.opId.toLowerCase() === dep.createOpId.toLowerCase() && parent.clientId === child.clientId
    && parent.libraryId === child.libraryId && parent.syncEpoch === child.syncEpoch;
}
export function validatePendingParent(operation: PendingSyncOperation, operations: PendingSyncOperation[]): void {
  for (const dependency of vocabularyDependencies(operation)) {
    if (dependency.createOpId.toLowerCase() === operation.opId.toLowerCase()
      || !operations.some(parent => parent.status === 'pending' && matchesVocabularyParent(operation, parent, dependency))) {
      throw new Error('Pending Tag or Facet parent is missing or blocked; refresh and retry');
    }
  }
  for (const dependency of producerDependencies(operation)) {
    if (dependency.createOpId.toLowerCase() === operation.opId.toLowerCase() || !operations.some(parent => parent.status === 'pending' && matchesProducerParent(operation, parent, dependency))) throw new Error('Pending Author parent is missing or blocked; refresh and retry');
  }
  if (operation.payload.parentCreateOpId === undefined) return;
  if (!operations.some(parent => dependsOnEntryCreate(operation, parent) && parent.status === 'pending')) {
    throw new Error('Pending Entry parent is missing or blocked; refresh and retry');
  }
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
      validatePendingParent(operation, [...records.values()].map(row => row.operation));
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
    async removeApplied(opIds) {
      const operations = [...records.values()].map(row => row.operation);
      for (const opId of appliedRemovalIds(operations, opIds)) records.delete(opId);
    },
    async removeMany(opIds) {
      for (const opId of opIds) records.delete(opId);
    },
  };
}
