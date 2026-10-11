from guard import ROOT,STAGE,edit
import json
p='apps/web/src/stores/preferences.ts';b=(ROOT/p).read_bytes();q=STAGE/'gap4-start'/p;q.parent.mkdir(parents=True,exist_ok=True);assert not q.exists();q.write_bytes(b)
# Final membership projection must resolve the projected create, not only baseline owners.
p='apps/web/src/offline/offline-api.ts';text=(ROOT/p).read_text();batch=[]
for marker in ['  for (const operation of producerViewLaterOperations) {','  for (const operation of producerRatingOperations) {']:
 a=text.index(marker);b=text.index('\n  }',a)+4;scope=text[a:b];old='snapshot.payload.producers.find((row) => row.syncUid === operation.entityUid)';assert scope.count(old)==1;batch.append((p,scope,scope.replace(old,'producers.find((row) => row.syncUid === operation.entityUid)')))
batch.append(('apps/web/src/stores/preferences.ts','  viewLaterAuthorIds.value = normalizeViewLaterIds(state.producerIds);',"  // Facade state includes stable negative local Author IDs before replay.\n  // Legacy localStorage/HTTP numeric validation remains positive-only.\n  viewLaterAuthorIds.value = [...new Set(state.producerIds.filter(id => Number.isSafeInteger(id) && id !== 0))];"))
for p,old,new in batch:
 data=(ROOT/p).read_bytes();assert sum(data.count(old.encode().replace(b'\n',nl)) for nl in [b'\n',b'\r\n'])>=1,p
for p,old,new in batch:edit(p,old,new)
