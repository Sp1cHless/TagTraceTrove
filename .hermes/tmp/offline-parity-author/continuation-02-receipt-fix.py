from guard import edit
p='apps/web/src/offline/offline-api.ts'
edit(p,"""            const original = operations.find(row => row.opId === operation.opId);
            if (!original || original.entityKind !== 'producer'""","""            const original = operations.find(row => row.opId === operation.opId);
            const ownerId = receipt?.entityId ?? activeBeforeReplay?.snapshot.payload.producers.find(row => row.syncUid === operation.entityUid)?.id;
            if (!original || original.entityKind !== 'producer'""")
edit(p,'|| !receipt || receipt.entityId !== deletion.entityId || appliedOperations.indexOf(operation) >= last','|| !receipt || ownerId !== deletion.entityId || appliedOperations.indexOf(operation) >= last')
