import { expect, it } from 'vitest';
import { syncReplayOperationSchema } from '../src/schemas/sync.js';
const uid='abcdefab-abcd-4abc-8abc-abcdefabcdef';
const op='123456ab-abcd-4abc-8abc-abcdefabcdef';
const envelope={opId:op,clientId:'cross',libraryId:'library',syncEpoch:'epoch',entityKind:'entry',entityUid:uid,clientCreatedAt:'2026-10-03T00:00:00Z',baseVersion:1};
it('rejects a case-only Author set no-op without transforming immutable UUID bodies',()=>{
 expect(syncReplayOperationSchema.safeParse({...envelope,operationKind:'entry.authors.set',baseValues:{producerUids:[uid]},payload:{producerUids:[uid.toUpperCase()]}}).success).toBe(false);
});
it('accepts case-equivalent dependency membership and preserves the original envelope',()=>{
 const body={...envelope,operationKind:'entry.authors.set',baseValues:{producerUids:[]},payload:{producerUids:[uid.toUpperCase()],producerCreates:[{producerUid:uid,createOpId:'222222ab-abcd-4abc-8abc-abcdefabcdef'}]}};
 expect(syncReplayOperationSchema.parse(body)).toEqual(body);
});
it.each(['self','duplicate','new-already-linked'] as const)('rejects semantic identity collision: %s',reason=>{
 const body=reason==='new-already-linked'
  ? {...envelope,operationKind:'entry.author.create-and-link',baseValues:{producerUids:[uid]},payload:{producerUid:uid.toUpperCase(),name:'New'}}
  : {...envelope,operationKind:'entry.authors.set',baseValues:{producerUids:[]},payload:{producerUids:[uid],producerCreates:reason==='self'?[{producerUid:uid,createOpId:op.toUpperCase()}]:[{producerUid:uid,createOpId:'222222ab-abcd-4abc-8abc-abcdefabcdef'},{producerUid:uid.toUpperCase(),createOpId:'333333ab-abcd-4abc-8abc-abcdefabcdef'}]}};
 expect(syncReplayOperationSchema.safeParse(body).success).toBe(false);
});

it('makes a Producer-origin cycle unrepresentable by strict creation envelopes',()=>{
 const dependency=[{producerUid:uid,createOpId:op}];
 expect(syncReplayOperationSchema.safeParse({...envelope,operationKind:'entry.author.create-and-link',baseValues:{producerUids:[]},payload:{producerUid:uid,name:'Cycle',producerCreates:dependency}}).success).toBe(false);
 expect(syncReplayOperationSchema.safeParse({...envelope,entityKind:'producer',operationKind:'entry.author.create-and-link',baseValues:{producerUids:[]},payload:{producerUid:uid,name:'Wrong kind'}}).success).toBe(false);
});
