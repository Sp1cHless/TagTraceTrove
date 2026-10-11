from edit import edit
p='apps/web/src/offline/offline-api.ts'
edit(p,"          for (const [uid, producerUids] of lastAppliedAuthors) {\n            if", "          for (const [uid, producerUids] of lastAppliedAuthors) {\n            const writes = appliedOperations.filter(row => row.entityUid === uid && (row.operationKind === 'entry.authors.set' || row.operationKind === 'entry.author.create-and-link'));\n            if (writes.length > 0 && writes.every(settledBeforeDelete)) continue;\n            if")
edit(p,"          for (const operation of lastAppliedTags.values()) {\n            const entry", "          for (const operation of lastAppliedTags.values()) {\n            if (settledBeforeDelete(operation)) continue;\n            const entry")
edit(p,"          for (const upload of appliedMedia) {\n            if (!upload.existingEntry) continue;\n            const receipt = mediaReceipts.get(upload.uploadId)!;", """          for (const upload of appliedMedia) {
            if (!upload.existingEntry) continue;
            const receipt = mediaReceipts.get(upload.uploadId)!;
            const deletion = entryDeleteReceipts.get(upload.entryUid);
            if (deletion) {
              if (receipt.uploadId !== upload.uploadId || receipt.entityId !== deletion.entityId || receipt.serverSeq >= deletion.serverSeq
                || receipt.resourceVersion >= deletion.resourceVersion) throw new Error('Entry deletion cannot settle noncausal media');
              continue;
            }""")
edit(p,"            if (producer === undefined || producer.id !== appliedProducerIds.get(operation.payload.producerUid) || entry === undefined) {", "            if (producer === undefined || producer.id !== appliedProducerIds.get(operation.payload.producerUid) || (entry === undefined && !settledBeforeDelete(operation))) {")
