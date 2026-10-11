from edit import edit
p='apps/web/src/offline/offline-api.ts'
edit(p,"      const entryDeleteReceipts = new Map<string, {entityId:number; resourceVersion:number; serverSeq:number}>();","      const entryDeleteReceipts = new Map<string, {entityId:number; resourceVersion:number; serverSeq:number}>();\n      const appliedReceipts = new Map<string, {resourceVersion:number; serverSeq:number}>();")
edit(p,"            appliedOperations.push(operation);","            appliedReceipts.set(operation.opId, {resourceVersion:result.resourceVersion, serverSeq:result.serverSeq});\n            appliedOperations.push(operation);")
edit(p,"          // Verify the final extension timeline before publishing or ACKing a candidate.","""          // Only matching journal/absence/cursor proof above can authorize a
          // predecessor whose receipt causally precedes the final delete.
          const settledBeforeDelete = (operation: SyncReplayRequest): boolean => {
            const deletion = entryDeleteReceipts.get(operation.entityUid);
            if (!deletion || operation.entityKind !== 'entry' || operation.operationKind === 'entry.delete') return false;
            const receipt = appliedReceipts.get(operation.opId);
            const last = appliedOperations.findIndex(row => row.operationKind === 'entry.delete' && row.entityUid === operation.entityUid);
            if (!receipt || appliedOperations.indexOf(operation) >= last || receipt.serverSeq >= deletion.serverSeq
              || receipt.resourceVersion >= deletion.resourceVersion) throw new Error('Entry deletion cannot settle a noncausal predecessor');
            return true;
          };
          // Verify the final extension timeline before publishing or ACKing a candidate.""")
edit(p,"          for (const [uid, desired] of durations) {\n            const owner", "          for (const [uid, desired] of durations) {\n            const writes = appliedOperations.filter(row => row.entityUid === uid && (row.operationKind === 'entry.update' || row.operationKind === 'entry.create') && row.payload.durationSeconds !== undefined);\n            if (writes.length > 0 && writes.every(settledBeforeDelete)) continue;\n            const owner")
