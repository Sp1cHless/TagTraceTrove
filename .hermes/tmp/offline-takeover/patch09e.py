import io

path = r'D:\Project\TagTraceTrove\apps\web\src\offline\offline-api.ts'
text = io.open(path, encoding='utf-8').read()

anchor = "          const partitionWrites=appliedOperations.filter((op):op is Extract<SyncReplayRequest,{operationKind:'gallery.partition.set'}>=>op.operationKind==='gallery.partition.set');"
add = """          for (const operation of appliedOperations) {
            if (operation.operationKind !== 'entry.tag-layout.apply') continue;
            const receipt = causalReceipts.get(operation.opId)!;
            if (!candidate.acknowledgement) throw new Error('Tag layout apply settlement needs durable ACK');
            const peerIds = new Set(snapshot.payload.entries.filter(row => row.type === operation.baseValues.entryType && row.syncUid !== operation.entityUid).map(row => row.id));
            for (const assignment of operation.baseValues.assignments) {
              const tag = snapshot.payload.tags.find(row => row.syncUid?.toLowerCase() === assignment.tagUid.toLowerCase());
              const facet = snapshot.payload.tagGroups.find(row => row.syncUid?.toLowerCase() === assignment.facetUid.toLowerCase());
              if (!tag || !facet) throw new Error('Tag layout apply snapshot lacks the frozen tag or Facet');
              for (const row of snapshot.payload.entryTags) {
                if (peerIds.has(row.entryId) && row.tagId === tag.id && row.facetId !== facet.id) {
                  throw new Error('Tag layout apply snapshot retains a misplaced peer assignment');
                }
              }
            }
            const proofKey='tagLayoutApplyProof.'+operation.opId;
            const proof=JSON.stringify({receipt,fingerprint:operationFingerprint(operations.find(row=>row.opId===operation.opId)!)});
            if (await store.readMeta(proofKey)!==proof) await store.writeMeta(proofKey,proof);
          }
          {
            const templateOps = new Map<string, Extract<SyncReplayRequest,{operationKind:'entry.layout-template.apply'}>[]>();
            for (const operation of appliedOperations) {
              if (operation.operationKind !== 'entry.layout-template.apply') continue;
              const list = templateOps.get(operation.entityUid.toLowerCase()) ?? [];
              list.push(operation);
              templateOps.set(operation.entityUid.toLowerCase(), list);
            }
            const canonical = (groups: Array<{ syncUid: string; name: string; groupKind: 'section' | 'facet'; parentUid: string | null; sortOrder: number }>) => groups
              .map(row => ({ ...row, syncUid: row.syncUid.toLowerCase(), parentUid: row.parentUid === null ? null : row.parentUid.toLowerCase() }))
              .sort((a, b) => a.syncUid.localeCompare(b.syncUid));
            for (const [uid, list] of templateOps) {
              if (!candidate.acknowledgement) throw new Error('Layout template settlement needs durable ACK');
              list.sort((a, b) => a.clientCreatedAt.localeCompare(b.clientCreatedAt));
              for (let index = 0; index < list.length - 1; index += 1) {
                if (causalReceipts.get(list[index]!.opId)!.resourceVersion !== list[index + 1]!.baseVersion) {
                  throw new Error('Layout template receipts do not chain onto the next frozen base');
                }
              }
              const last = list.at(-1)!;
              const receipt = causalReceipts.get(last.opId)!;
              const layout = snapshot.payload.entryTagLayouts?.find(row => row.syncUid.toLowerCase() === uid);
              const actual = canonical(snapshot.payload.tagGroups.filter(row => row.entryType === layout?.entryType && row.syncUid).map(row => {
                const parent = row.parentId === null ? null : snapshot.payload.tagGroups.find(candidateRow => candidateRow.id === row.parentId && candidateRow.entryType === layout?.entryType);
                return { syncUid: row.syncUid!, name: row.name, groupKind: row.groupKind, parentUid: parent?.syncUid ?? null, sortOrder: row.sortOrder };
              }));
              if (!layout || layout.syncVersion !== receipt.resourceVersion || JSON.stringify(actual) !== JSON.stringify(canonical([...last.payload.groups]))) {
                throw new Error('Layout template snapshot lacks exact rebuilt groups and revision');
              }
              for (const operation of list) {
                const opReceipt = causalReceipts.get(operation.opId)!;
                const proofKey='layoutTemplateProof.'+operation.opId;
                const proof=JSON.stringify({receipt:opReceipt,fingerprint:operationFingerprint(operations.find(row=>row.opId===operation.opId)!)});
                if (await store.readMeta(proofKey)!==proof) await store.writeMeta(proofKey,proof);
              }
            }
          }
          const partitionWrites=appliedOperations.filter((op):op is Extract<SyncReplayRequest,{operationKind:'gallery.partition.set'}>=>op.operationKind==='gallery.partition.set');"""
assert anchor in text
text = text.replace(anchor, add, 1)
io.open(path, 'w', encoding='utf-8', newline='').write(text)
print('settlement proofs added')
