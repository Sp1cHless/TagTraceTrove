import { expect, it } from 'vitest';
import { syncReplayRequestSchema } from '@t3/shared';
import { requiredMutationCapabilities } from '../src/offline/sync-mutation-plan.js';
const base = { opId:'11111111-1111-4111-8111-111111111111', clientId:'phone', libraryId:'library',syncEpoch:'epoch',entityUid:'22222222-2222-4222-8222-222222222222',clientCreatedAt:'2026-10-08',baseVersion:1 };
it('new fields carry additional foreground/native capability requirements without defaulting old envelopes',()=>{
 const duration = syncReplayRequestSchema.parse({...base,entityKind:'entry',operationKind:'entry.update',baseValues:{durationSeconds:null},payload:{durationSeconds:0}});
 expect(requiredMutationCapabilities(duration)).toContain('offlineEntryDuration');
 const anchor = syncReplayRequestSchema.parse({...base,entityKind:'producer',operationKind:'producer.update',baseValues:{galleryAnchor:null},payload:{galleryAnchor:'comic'}});
 expect(requiredMutationCapabilities(anchor)).toContain('offlineAuthorSelfRatings');
 const self = syncReplayRequestSchema.parse({...base,entityKind:'producer',operationKind:'producer.rating.set',baseValues:{slotUid:base.entityUid,stars:null},payload:{slotUid:base.entityUid,stars:3.5,subjectKind:'author_self'}});
 expect(requiredMutationCapabilities(self)).toContain('offlineAuthorSelfRatings');
 const old = {...base,entityKind:'producer',operationKind:'producer.rating.set',baseValues:{slotUid:base.entityUid,stars:null},payload:{slotUid:base.entityUid,stars:3.5}};
 expect(syncReplayRequestSchema.parse(old)).toEqual(old);
});
