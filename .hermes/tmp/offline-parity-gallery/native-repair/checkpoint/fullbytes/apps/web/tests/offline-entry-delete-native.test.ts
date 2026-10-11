import { expect, it } from 'vitest';
import { nativeMutationContract } from '@t3/shared';
import { createNativeTransfers, type NativeTransferCapture } from '../src/offline/native-background-transfer.js';
import { createPendingSyncOperation } from '../src/offline/outbox-store.js';
import { mutationQueuePlan, originalMutationEnvelope } from '../src/offline/sync-mutation-plan.js';
const uid='11111111-1111-4111-8111-111111111111';
const operation=()=>createPendingSyncOperation({clientId:'phone',libraryId:uid,syncEpoch:'epoch',entityKind:'entry',entityUid:uid,operationKind:'entry.delete',baseVersion:2,baseValues:{},payload:{}});
it('delete with pending existing media is held natively without throwing away originals; independent owner still stages',async()=>{
 const deletion=operation(), independent=createPendingSyncOperation({clientId:'phone',libraryId:uid,syncEpoch:'epoch',entityKind:'producer',entityUid:uid,operationKind:'producer.update',baseVersion:1,baseValues:{name:'Old'},payload:{name:'New'}});
 const capture:NativeTransferCapture={snapshot:JSON.stringify({header:{libraryId:uid,syncEpoch:'epoch'},payload:{entries:[{id:1,syncUid:uid}]}}),revision:'r',clientId:'phone',operations:[deletion,independent],media:[{uploadId:uid,entryUid:uid,existingEntry:{expectedCoverRef:null,expectedPreviewRefs:[]},libraryId:uid,syncEpoch:'epoch',kind:'cover',ordinal:0,mimeType:'image/png',byteLength:1,sha256:'a'.repeat(64),blob:new Blob(['x']),status:'pending',lastAttemptAt:null,lastError:null}]};
 const calls:Array<{method:string;args:Record<string,unknown>}>=[];
 const native=createNativeTransfers({captureNativeTransfers:async()=>capture},{call:async(method,args)=>{calls.push({method,args});return method==='status'?{protocolVersion:1,planVersion:1,operationKinds:Object.keys(nativeMutationContract)}:{};}});
 await native.handoff();
 const staged=calls.filter(row=>row.method==='stageOperation').map(row=>JSON.parse(String(row.args.body)));
 expect(staged).toEqual([originalMutationEnvelope(independent)]);expect(capture.operations[0]).toEqual(deletion);expect(capture.media).toHaveLength(1);
});
it('delete follows a preceding Collection membership relation while unrelated owners remain independently eligible',()=>{
 const deletion=operation(), membership=createPendingSyncOperation({clientId:'phone',libraryId:uid,syncEpoch:'epoch',entityKind:'collection',entityUid:'22222222-2222-4222-8222-222222222222',operationKind:'collection.entry.set',baseVersion:1,baseValues:{entryUid:uid,present:false},payload:{entryUid:uid,present:true}});
 expect(mutationQueuePlan([membership,deletion]).get(deletion.opId)?.dependencies).toContain(membership.opId);
 expect(mutationQueuePlan([{...membership,status:'conflict'},deletion]).get(deletion.opId)?.eligible).toBe(false);
});
