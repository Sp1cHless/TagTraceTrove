from guard import ROOT,STAGE,sha
import json
edits=[]
def add(p,a,b): edits.append((p,a,b))
p='apps/web/src/offline/sync-mutation-plan.ts'
add(p,'export function mutationQueuePlan(rows:PendingSyncOperation[]):Map<string,MutationPlan> {','export function mutationQueuePlan(rows:PendingSyncOperation[], directoryOwners:ReadonlyMap<string,string> = new Map()):Map<string,MutationPlan> {')
add(p,"  const refs=referencedEntityKeys(operation).map(key=>key.toLowerCase());const slots=referencedRatingSlotUids(operation).map(uid=>uid.toLowerCase());", "  const refs=referencedEntityKeys(operation).map(key=>key.toLowerCase());const slots=referencedRatingSlotUids(operation).map(uid=>uid.toLowerCase());\n  if(operation.operationKind==='author.directories.set' && directoryOwners.has(operation.opId))refs.push(directoryOwners.get(operation.opId)!.toLowerCase());")
add(p,"referencedEntityKeys(op).map(key=>key.toLowerCase()).includes(ownerKey))", "(referencedEntityKeys(op).map(key=>key.toLowerCase()).includes(ownerKey) || (operation.operationKind==='producer.delete' && op.operationKind==='author.directories.set' && (!directoryOwners.has(op.opId) || directoryOwners.get(op.opId)!.toLowerCase()===ownerKey))))")
add(p,"const eligible=operation.operationKind!=='entry.media.set' && row.status==='pending'", "const eligible=operation.operationKind!=='entry.media.set' && (operation.operationKind!=='author.directories.set' || directoryOwners.has(operation.opId)) && row.status==='pending'")
p='apps/web/src/offline/offline-api.ts'
add(p,'      const replayPlan = mutationQueuePlan(operations);','''      // A Directory-set is an independent revision owner, never the Producer UID.
      // Only a verified snapshot may establish its owned scope. Keep that typed
      // foreground proof bound to the exact envelope through an absent-owner ACK retry.
      const directoryScopes = new Map<string, {producerUid:string;producerId:number;setId:number}>();
      for (const row of operations) {
        if (row.operationKind !== 'author.directories.set') continue;
        const fingerprint = operationFingerprint(row);
        const key = 'authorDirectoryScope.' + row.opId;
        const active = activeBeforeReplay?.snapshot;
        const set = active?.payload.authorDirectorySets?.find(set => set.syncUid === row.entityUid);
        const producer = active?.payload.producers.find(producer => producer.id === set?.producerId);
        if (set && producer?.syncUid && active?.header.libraryId === row.libraryId && active.header.syncEpoch === row.syncEpoch) {
          const scope = {producerUid:producer.syncUid,producerId:producer.id,setId:set.id};
          directoryScopes.set(row.opId,scope);
          await store.writeMeta(key,JSON.stringify({fingerprint,scope}));
        } else {
          const saved = await store.readMeta(key);
          if (saved) {
            try {
              const value = JSON.parse(saved) as {fingerprint:string;scope:{producerUid:string;producerId:number;setId:number}};
              if (value.fingerprint === fingerprint && typeof value.scope.producerUid === 'string'
                && Number.isSafeInteger(value.scope.producerId) && value.scope.producerId > 0 && Number.isSafeInteger(value.scope.setId) && value.scope.setId > 0) directoryScopes.set(row.opId,value.scope);
            } catch { /* Unknown scope remains held; native raw JSON is not authority. */ }
          }
        }
      }
      const replayPlan = mutationQueuePlan(operations,new Map([...directoryScopes].map(([id,scope])=>[id,`producer:${scope.producerUid}`])));''')
add(p,'          if(missingFlags.length || unsettled) {',"          if(missingFlags.length || unsettled || (operation.operationKind === 'author.directories.set' && !directoryScopes.has(operation.opId))) {")
add(p,'          // Verify the final extension timeline before publishing or ACKing a candidate.','''          for (const operation of appliedOperations) {
            if (operation.operationKind !== 'author.directories.set') continue;
            const scope = directoryScopes.get(operation.opId);
            const receipt = appliedReceipts.get(operation.opId);
            const original = operations.find(row => row.opId === operation.opId);
            if (!scope || !receipt || !original || original.entityUid !== operation.entityUid
              || original.libraryId !== operation.libraryId || original.syncEpoch !== operation.syncEpoch
              || receipt.resourceVersion < operation.baseVersion || receipt.serverSeq <= 0) throw new Error('Directory settlement needs its original receipt and trusted owned scope');
            const deletion = producerDeleteReceipts.get(scope.producerUid);
            if (deletion) {
              const last = appliedOperations.findIndex(row => row.operationKind === 'producer.delete' && row.entityUid === scope.producerUid);
              // Compare versions only within Directory-set; cross-owner causality is serverSeq.
              if (scope.producerId !== deletion.entityId || appliedOperations.indexOf(operation) >= last
                || receipt.serverSeq >= deletion.serverSeq
                || snapshot.payload.authorDirectorySets?.some(row => row.syncUid === operation.entityUid || row.producerId === scope.producerId)
                || snapshot.payload.authorDirectories.some(row => row.producerId === scope.producerId)) throw new Error('Author deletion cannot settle a foreign or noncausal Directory predecessor');
            } else {
              const set = snapshot.payload.authorDirectorySets?.find(row => row.syncUid === operation.entityUid);
              const later = appliedOperations.some(row => row.operationKind === 'author.directories.set' && row.entityUid === operation.entityUid && appliedOperations.indexOf(row) > appliedOperations.indexOf(operation));
              if (!set || set.id !== scope.setId || set.producerId !== scope.producerId || set.syncVersion < receipt.resourceVersion
                || (!later && JSON.stringify(producerDirectoriesFromSnapshot(snapshot,scope.producerId)) !== JSON.stringify(operation.payload.directories))) throw new Error('Snapshot refresh failed: Directory final owner/value is missing');
            }
          }
          // Verify the final extension timeline before publishing or ACKing a candidate.''')
# Dryrun entire sequential byte batch before first write.
ledger=json.loads((STAGE/'ledger.json').read_text()); buffers={}
for p,a,b in edits:
 raw=buffers.get(p,(ROOT/p).read_bytes()); assert sha((ROOT/p).read_bytes())==ledger[p]['current'],p
 matches=[(a.encode().replace(b'\n',nl),b.encode().replace(b'\n',nl)) for nl in [b'\n',b'\r\n'] if raw.count(a.encode().replace(b'\n',nl))==1];assert matches,(p,a[:80]);x,y=matches[0];buffers[p]=raw.replace(x,y,1)
for p,b in buffers.items():
 (ROOT/p).write_bytes(b);ledger[p]['current']=sha(b)
(STAGE/'ledger.json').write_text(json.dumps(ledger,indent=2));print('Applied',len(edits),'guarded replacements')
