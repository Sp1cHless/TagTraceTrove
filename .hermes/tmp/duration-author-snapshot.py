import runpy
r=runpy.run_path('.hermes/tmp/duration-author-patch.py')['replace']
f='apps/web/src/offline/offline-api.ts'
r(f,"          const snapshot = candidate.snapshot;", """          const snapshot = candidate.snapshot;
          // Verify the final extension timeline before publishing or ACKing a candidate.
          // Cursor coverage alone does not prove the new nullable fields or rating class.
          const durations = new Map<string, number | null>();
          const anchors = new Map<string, string | null>();
          const selfValues = new Map<string, ProducerRatingOperation>();
          const layouts = new Map<string, RatingLayoutOperation>();
          for (const operation of appliedOperations) {
            if ((operation.operationKind === 'entry.create' || operation.operationKind === 'entry.update') && operation.payload.durationSeconds !== undefined) durations.set(operation.entityUid, operation.payload.durationSeconds);
            if (operation.operationKind === 'producer.update' && operation.payload.galleryAnchor !== undefined) anchors.set(operation.entityUid, operation.payload.galleryAnchor);
            if (operation.operationKind === 'producer.rating.set') selfValues.set(`${operation.entityUid}:${operation.payload.slotUid}`, operation);
            if (operation.operationKind === 'rating-layout.slots.set') layouts.set(operation.entityUid, operation);
          }
          for (const [uid, desired] of durations) {
            const owner = snapshot.payload.entries.find(row => row.syncUid === uid);
            const original = activeBeforeReplay?.snapshot.payload.entries.find(row => row.syncUid === uid);
            if (!owner || (original && owner.id !== original.id) || owner.durationSeconds !== desired) throw new Error('Snapshot refresh failed: duration final value or owner is missing');
          }
          for (const [uid, desired] of anchors) {
            const owner = snapshot.payload.producers.find(row => row.syncUid === uid);
            const original = activeBeforeReplay?.snapshot.payload.producers.find(row => row.syncUid === uid);
            if (!owner || (original && owner.id !== original.id) || owner.galleryAnchor !== desired) throw new Error('Snapshot refresh failed: stored Author anchor is missing');
          }
          for (const operation of selfValues.values()) {
            const owner = snapshot.payload.producers.find(row => row.syncUid === operation.entityUid);
            const slot = snapshot.payload.ratingSlots.find(row => row.syncUid === operation.payload.slotUid);
            const original = activeBeforeReplay?.snapshot.payload.producers.find(row => row.syncUid === operation.entityUid);
            const deleted = [...layouts.values()].some(layout => layout.payload.deletedSlotUids?.includes(operation.payload.slotUid));
            if (deleted && !slot) continue;
            if (!owner || (original && owner.id !== original.id) || !slot || slot.subjectKind !== (operation.payload.subjectKind ?? 'producer')
              || (snapshot.payload.producerRatingValues.find(row => row.producerId === owner.id && row.slotId === slot.id)?.stars ?? null) !== operation.payload.stars) throw new Error('Snapshot refresh failed: Author rating class/value is missing');
          }
          for (const operation of layouts.values()) {
            const layout = snapshot.payload.ratingLayouts?.find(row => row.syncUid === operation.entityUid);
            const original = activeBeforeReplay?.snapshot.payload.ratingLayouts?.find(row => row.syncUid === operation.entityUid);
            const kind = operation.payload.subjectKind ?? original?.subjectKind;
            if (!layout || !kind || layout.subjectKind !== kind || (original && layout.entryType !== original.entryType)
              || operation.payload.slots.some(slot => !snapshot.payload.ratingSlots.some(row => row.syncUid === slot.syncUid && row.subjectKind === kind && row.entryType === layout.entryType && row.name === slot.name && row.sortOrder === slot.sortOrder))
              || operation.payload.deletedSlotUids?.some(uid => snapshot.payload.ratingSlots.some(row => row.syncUid === uid))) throw new Error('Snapshot refresh failed: rating layout class/final slots are missing');
          }""")
r(f,"          if (result.status === 'applied') {", "          if (result.status === 'applied') {\n            if (result.opId.toLowerCase() !== operation.opId.toLowerCase()) throw new Error('Replay receipt identity mismatch');")
