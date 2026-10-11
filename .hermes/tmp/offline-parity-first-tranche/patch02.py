from safe_edit import edit
edit('apps/web/src/offline/offline-api.ts',"    if (!hasOutbox(store)) throw new Error('Offline mutation storage is unavailable');\n    // Only NEW envelopes", """    if (!hasOutbox(store)) throw new Error('Offline mutation storage is unavailable');
    if (operation.entityKind === 'entry' && (await store.list()).some(row => row.operationKind === 'entry.delete' && row.entityUid === operation.entityUid)) {
      throw new Error('Entry deletion is already queued; retain its original operation before editing');
    }
    // Only NEW envelopes""")
edit('apps/web/src/offline/offline-api.ts',"      const appliedMetadataOwnerIds = new Map<string, number>();", """      const entryDeleteReceipts = new Map<string, {entityId:number; resourceVersion:number; serverSeq:number}>();
      const appliedMetadataOwnerIds = new Map<string, number>();""")
edit('apps/web/src/offline/offline-api.ts',"            if (operation.operationKind === 'entry.media.set' && deletionProofs.has(operation.opId)) {", """            if (operation.operationKind === 'entry.delete') {
              if (result.entityId === undefined || result.resourceVersion !== operation.baseVersion + 1 || result.serverSeq <= 0) throw new Error('Entry delete receipt identity/version is invalid');
              const original = activeBeforeReplay?.snapshot.payload.entries.find(row => row.syncUid === operation.entityUid);
              if (original && original.id !== result.entityId) throw new Error('Entry delete receipt has a different owner');
              entryDeleteReceipts.set(operation.entityUid, {entityId:result.entityId,resourceVersion:result.resourceVersion,serverSeq:result.serverSeq});
            }
            if (operation.operationKind === 'entry.media.set' && deletionProofs.has(operation.opId)) {""")
edit('apps/web/src/offline/offline-api.ts',"          const snapshot = candidate.snapshot;\n          // Verify", """          const snapshot = candidate.snapshot;
          for (const [uid, receipt] of entryDeleteReceipts) {
            const operation = appliedOperations.find(row => row.operationKind === 'entry.delete' && row.entityUid === uid)!;
            if (snapshot.payload.entries.some(row => row.syncUid === uid || row.id === receipt.entityId)
              || snapshot.header.libraryId !== operation.libraryId || snapshot.header.syncEpoch !== operation.syncEpoch
              || (snapshot.header.changeSeq ?? -1) < receipt.serverSeq || !online.fetchSyncChanges || !candidate.acknowledgement) throw new Error('Entry deletion needs verified absence, cursor coverage and durable ACK support');
            const proof = await online.fetchSyncChanges({libraryId:operation.libraryId,syncEpoch:operation.syncEpoch,
              protocolVersion:snapshot.header.snapshotFormatVersion,clientId,afterSeq:receipt.serverSeq-1,limit:1});
            if (!proof.changes.some(row => row.seq === receipt.serverSeq && row.entityKind === 'entry' && row.entityUid.toLowerCase() === uid.toLowerCase()
              && row.changeKind === 'delete' && row.resourceVersion === receipt.resourceVersion && row.record === null)) throw new Error('Entry deletion needs an authoritative matching delete tombstone journal');
          }
          // Verify""")
