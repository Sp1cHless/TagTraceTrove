import { describe, expect, it } from 'vitest';
import { nativeMutationContract, syncReplayOperationSchema } from '@t3/shared';
import { createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { originalMutationEnvelope, requiredMutationCapabilities, mutationQueuePlan } from '../src/offline/sync-mutation-plan.js';

const uid = '11111111-1111-4111-8111-111111111111';
import { shapes } from './fixtures/native-valid-kind-fixture.js';

describe('bounded valid current-kind defense coverage', () => {
 it('has no missing schema discriminants or generated native contract kinds', () => {
  const discriminants = syncReplayOperationSchema.options.map(schema => schema.shape.operationKind.value).sort();
  expect(Object.keys(shapes).sort()).toEqual(discriminants);
  expect(Object.keys(nativeMutationContract).sort()).toEqual(discriminants);
 });
 for (const [kind, shape] of Object.entries(shapes)) {
  it(`${kind}: complete production-built immutable body parses and generates matching flags and typed owner`, () => {
   const contract = nativeMutationContract[kind as keyof typeof nativeMutationContract];
   const row = createPendingSyncOperation({ clientId: uid, libraryId: uid, syncEpoch: 'epoch', entityKind: contract.entityKind, entityUid: shape.entityUid ?? uid, operationKind: kind, baseVersion: shape.baseVersion, baseValues: shape.baseValues, payload: shape.payload }, { randomUUID: () => uid, now: () => new Date('2026-10-04T00:00:00.000Z') });
   const before = JSON.stringify(row);
   const body = originalMutationEnvelope(row);
   expect(syncReplayOperationSchema.safeParse(body).success).toBe(true);
   const plan = mutationQueuePlan([row]).get(row.opId)!;
   expect(plan.ownerKey).toBe(`${contract.entityKind}:${row.entityUid}`);
   expect(plan.requiredFlags).toEqual(requiredMutationCapabilities(body));
   expect(plan.requiredFlags).toEqual(expect.arrayContaining([...contract.flags]));
   expect(JSON.stringify(row)).toBe(before);
  });
 }
});
