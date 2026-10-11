from guard import edit
edit('apps/web/src/offline/offline-api.ts','|| !receipt || ownerId !== deletion.entityId || appliedOperations.indexOf(operation) >= last','|| !receipt || (ownerId !== undefined && ownerId !== deletion.entityId) || appliedOperations.indexOf(operation) >= last')
