import { describe, it, expect } from 'vitest';
import { syncReplayOperationSchema } from '@t3/shared';
import { nativeMutationContract } from '@t3/shared';
import { createNativeTransfers } from '../src/offline/native-background-transfer.js';
import type { PendingSyncOperation } from '../src/offline/outbox-store.js';
const uid='11111111-1111-4111-8111-111111111111';
const producer:PendingSyncOperation={opId:uid,clientId:uid,libraryId:uid,syncEpoch:'epoch',entityUid:uid,entityKind:'producer',operationKind:'producer.update',clientCreatedAt:'now',baseVersion:1,baseValues:{name:'before'},payload:{name:'after'},status:'pending',lastAttemptAt:null,lastError:null};
describe('current native mutation contract',()=>{
 it('hands off a valid immutable current Producer profile operation, not an Entry receipt interpretation',async()=>{
  const {status,lastAttemptAt,lastError,...body}=producer;void status;void lastAttemptAt;void lastError;
  expect(syncReplayOperationSchema.safeParse(body).success).toBe(true);
  const capture={snapshot:JSON.stringify({header:{libraryId:uid,syncEpoch:'epoch'},payload:{entries:[]}}),revision:'revision',clientId:uid,operations:[producer],media:[]};
  const calls:Array<{method:string;args:Record<string,unknown>}>=[];
  await createNativeTransfers({captureNativeTransfers:async()=>capture},{call:async(method,args)=>{calls.push({method,args});return method==='status'?{protocolVersion:1,planVersion:1,operationKinds:Object.keys(nativeMutationContract)}:{};}}).handoff();
  expect(calls.map(row=>row.method)).toEqual(['status','stageOperation','activate']);
  expect(JSON.parse(String(calls[1]!.args.body))).toEqual(body);
  expect(calls[1]!.args.requiredFlags).toEqual(['offlineMutations','offlineProducerProfile']);
 });
});

import { mutationQueuePlan, requiredMutationCapabilities } from '../src/offline/sync-mutation-plan.js';
it('the generated native map closes every current schema discriminant and typed owner, without an old partial allowlist',()=>{
 const current=syncReplayOperationSchema.options.map(schema=>({kind:schema.shape.operationKind.value,owner:schema.shape.entityKind.value}));
 expect(Object.keys(nativeMutationContract).sort()).toEqual(current.map(row=>row.kind).sort());
 for(const row of current)expect(nativeMutationContract[row.kind].entityKind).toBe(row.owner);
});
it('unknown and inactive originals block successors but not independent owner plans; capabilities are from the original immutable payload',()=>{
 const create:PendingSyncOperation={...producer,entityKind:'entry',operationKind:'entry.create',payload:{title:'original',type:'comic',uploadDate:null,pageCount:null,ratings:[],viewLater:false},baseVersion:0,baseValues:{}};
 const child:PendingSyncOperation={...create,opId:'22222222-2222-4222-8222-222222222222',operationKind:'entry.update',baseValues:{title:'original'},payload:{title:'later',parentCreateOpId:uid}};
 const independent={...producer,opId:'33333333-3333-4333-8333-333333333333'};
 expect(syncReplayOperationSchema.safeParse(originalCreate(create)).success).toBe(true);
 expect(syncReplayOperationSchema.safeParse(originalCreate(child)).success).toBe(true);
 const plan=mutationQueuePlan([create,child,independent]);
 expect(plan.get(child.opId)).toMatchObject({eligible:true,dependencies:[uid],ownerKey:`entry:${uid}`,requiredFlags:['offlineMutations','offlineEntryUpdate','offlinePendingEntryMetadata']});
 expect(requiredMutationCapabilities({...originalCreate(create),payload:{...create.payload,contents:[]}} as never)).toContain('offlineEntryInitialContents');
 expect(mutationQueuePlan([{...create,status:'failed'},child,independent]).get(child.opId)?.eligible).toBe(false);
 expect(mutationQueuePlan([{...create,status:'failed'},child,independent]).get(independent.opId)?.eligible).toBe(true);
 expect(mutationQueuePlan([{...create,operationKind:'unknown-current-kind'} as never,child]).get(uid)?.eligible).toBe(false);
});
it('invalid pending dependency transitively holds successors instead of staging a false runnable graph',()=>{
 const invalid={...producer,operationKind:'unknown'} as never;
 const successor={...producer,opId:'22222222-2222-4222-8222-222222222222'};
 expect(mutationQueuePlan([invalid,successor]).get(successor.opId)?.eligible).toBe(false);
});
function originalCreate(row:PendingSyncOperation){return {opId:row.opId,clientId:row.clientId,libraryId:row.libraryId,syncEpoch:row.syncEpoch,entityUid:row.entityUid,entityKind:row.entityKind,operationKind:row.operationKind,clientCreatedAt:row.clientCreatedAt,baseVersion:row.baseVersion,baseValues:row.baseValues,payload:row.payload};}
