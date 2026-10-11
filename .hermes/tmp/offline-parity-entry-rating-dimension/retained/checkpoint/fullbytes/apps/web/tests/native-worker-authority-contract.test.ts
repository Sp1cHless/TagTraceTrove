import { describe, expect, it } from 'vitest';
import { nativeMutationContract, syncReplayOperationSchema, syncReplayResultSchema } from '@t3/shared';
import { validKindRows } from './fixtures/native-valid-kind-fixture.js';
describe('Worker authority acceptance contract mocks (not SQL business applies)', () => {
 it('all current-kind queue-builder originals and fixture applied receipts satisfy shared contracts', () => {
  const rows=validKindRows();
  expect(rows).toHaveLength(Object.keys(nativeMutationContract).length);
  expect(rows.map(row=>row.operationKind).sort()).toEqual(Object.keys(nativeMutationContract).sort());
  for(const row of rows){
   expect(syncReplayOperationSchema.safeParse(row).success).toBe(true);
   expect(syncReplayResultSchema.safeParse({opId:row.opId,status:'applied',resourceVersion:2,serverSeq:1}).success).toBe(true);
  }
 });
 it.each(['libraryId','syncEpoch','resourceKind'])('foreign %s receipt is invalid under the actual strict shared response contract', field => {
  const op=validKindRows()[0]!;
  expect(syncReplayResultSchema.safeParse({opId:op.opId,status:'applied',resourceVersion:2,serverSeq:1,[field]:'foreign-scope'}).success).toBe(false);
 });
});
