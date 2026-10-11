import { expect, it, vi } from 'vitest';
import { nativeMutationContract } from '@t3/shared';
import { createNativeTransfers } from '../src/offline/native-background-transfer.js';
import type { PendingSyncOperation } from '../src/offline/outbox-store.js';
const uid='11111111-1111-4111-8111-111111111111';
const row:PendingSyncOperation={opId:uid,clientId:uid,libraryId:uid,syncEpoch:'epoch',entityUid:uid,entityKind:'producer',operationKind:'producer.update',clientCreatedAt:'now',baseVersion:1,baseValues:{name:'before'},payload:{name:'after'},status:'pending',lastAttemptAt:null,lastError:null};
const capture={snapshot:JSON.stringify({header:{libraryId:uid,syncEpoch:'epoch'},payload:{entries:[]}}),revision:'1',clientId:uid,operations:[row],media:[]};
export const protocol={protocolVersion:1,planVersion:1,operationKinds:Object.keys(nativeMutationContract)};
const caps={libraryId:uid,syncEpoch:'epoch',featureFlags:{offlineMutations:true,offlineProducerProfile:true}};
it.each([{}, {protocolVersion:0}, {...protocol,operationKinds:['entry.create']}])('old/incomplete plugin is foreground fallback before any native staging: %j',async advertised=>{
 const call=vi.fn(async(method:string)=>method==='status'?advertised:{active:0,completed:0,held:0});
 const native=createNativeTransfers({captureNativeTransfers:async()=>capture},{call});
 await native.handoff();
 expect(call.mock.calls.map(([method])=>method)).toEqual(['status']);
 const status=await native.resume();
 expect(status).toMatchObject({active:0,remainingOperations:1,foregroundReason:'Native mutation protocol unavailable; use foreground Update'});
 expect(call.mock.calls.every(([method])=>method==='status')).toBe(true);
});
it('capability downgrade during explicit resume is reported before staging and preserves originals',async()=>{
 const call=vi.fn(async(method:string)=>method==='status'?protocol:method==='preflight'?{...caps,featureFlags:{offlineMutations:true,offlineProducerProfile:false}}:{active:0,completed:0,held:0});
 const native=createNativeTransfers({captureNativeTransfers:async()=>capture},{call});
 const status=await native.resume();
 expect(call.mock.calls.some(([method])=>['stageOperation','activate','resumeOperations'].includes(method))).toBe(false);
 expect(status).toMatchObject({remainingOperations:1,capabilityHeld:1,foregroundReason:'Current required capability unavailable; original work retained'});
 expect(capture.operations).toEqual([row]);
});
it('explicit resume sends only current pending generic originals with current scope and scheduling plans',async()=>{
 const call=vi.fn(async(method:string,args:Record<string,unknown>)=>{void args;return method==='status'?protocol:method==='preflight'?caps:{active:0,completed:0,held:0};});
 const failed={...row,opId:'22222222-2222-4222-8222-222222222222',entityUid:'22222222-2222-4222-8222-222222222222',status:'conflict' as const};
 const native=createNativeTransfers({captureNativeTransfers:async()=>({...capture,operations:[row,failed]})},{call});
 await native.handoff();expect(call.mock.calls.some(([method])=>method==='resumeOperations')).toBe(false);
 await native.resume();
 const args=call.mock.calls.find(([method])=>method==='resumeOperations')?.[1] as unknown as {operations:Array<{body:string;revision:string}>};
 expect(args.operations).toHaveLength(1);expect(JSON.parse(args.operations[0]!.body)).toMatchObject({opId:uid,clientId:uid,libraryId:uid,syncEpoch:'epoch'});expect(args.operations[0]!.revision).toBe('1');
});
