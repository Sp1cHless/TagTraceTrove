from guard import edit
p='apps/web/src/offline/offline-api.ts'
edit(p,"""          // Verify the final extension timeline before publishing or ACKing a candidate.
""","""          const settledBeforeProducerDelete = (operation: SyncReplayRequest): boolean => {
            if (operation.entityKind !== 'producer' || operation.operationKind === 'producer.delete') return false;
            const deletion = producerDeleteReceipts.get(operation.entityUid);
            if (!deletion) return false;
            const receipt = appliedReceipts.get(operation.opId);
            const last = appliedOperations.findIndex(row => row.operationKind === 'producer.delete' && row.entityUid === operation.entityUid);
            const original = operations.find(row => row.opId === operation.opId);
            if (!original || original.entityKind !== 'producer' || original.entityUid !== operation.entityUid
              || original.libraryId !== operation.libraryId || original.syncEpoch !== operation.syncEpoch
              || !receipt || receipt.entityId !== deletion.entityId || appliedOperations.indexOf(operation) >= last
              || receipt.serverSeq <= 0 || receipt.serverSeq >= deletion.serverSeq
              || receipt.resourceVersion < operation.baseVersion || receipt.resourceVersion >= deletion.resourceVersion) {
              throw new Error('Author deletion cannot settle a foreign or noncausal predecessor');
            }
            return true;
          };
          // Every removed Producer write needs its own original receipt, not just
          // the last folded value. Delete journal/absence/cursor were verified above.
          for (const operation of appliedOperations) settledBeforeProducerDelete(operation);
          // Verify the final extension timeline before publishing or ACKing a candidate.
""")
edit(p,"""          for (const [uid,desired] of profiles) {
            const owner""","""          for (const [uid,desired] of profiles) {
            const writes = appliedOperations.filter(row => row.entityUid === uid && (row.operationKind === 'producer.create' || row.operationKind === 'producer.update'));
            if (writes.length && writes.every(settledBeforeProducerDelete)) continue;
            const owner""")
edit(p,"""          for (const [uid, desired] of anchors) {
            const owner""","""          for (const [uid, desired] of anchors) {
            const writes = appliedOperations.filter(row => row.entityUid === uid && row.operationKind === 'producer.update' && row.payload.galleryAnchor !== undefined);
            if (writes.length && writes.every(settledBeforeProducerDelete)) continue;
            const owner""")
edit(p,"""          for (const operation of selfValues.values()) {
            const owner""","""          for (const operation of selfValues.values()) {
            if (settledBeforeProducerDelete(operation)) continue;
            const owner""")
