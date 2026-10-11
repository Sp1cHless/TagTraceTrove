from guard import edit
edit('apps/web/src/offline/offline-api.ts','authorDirectoryEntries: authorDirectoryEntries.filter(row => !deletedIds.has(row.entryId) && !deletedDirectoryIds.has(row.directoryId)),','authorDirectoryEntries: authorDirectoryEntries.filter(row => !deletedIds.has(row.entryId) && !deletedDirectoryIds.has(row.directoryId) && !deletedProducerIds.has(row.producerId)),')
