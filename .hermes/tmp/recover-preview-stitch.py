import json,re
from pathlib import Path
current=Path('apps/web/src/offline/offline-api.ts').read_text()
source=Path('.hermes/tmp/offline-api-reconstructed.ts').read_text()
needle='\n'.join(current.splitlines()[-15:])
assert source.count(needle)==1
source=current.rstrip()+'\n'+source.split(needle,1)[1].lstrip('\n')
source=source.replace('SyncReplayOperation','SyncReplayRequest')
candidates=json.loads(Path('.hermes/tmp/recovery-candidates.json').read_text())
lines={}
for id,sid,start,end,text in candidates:
 if id in [130128,130130]:
  for num,line in re.findall(r'^(\d+)\|(.*)$',text,re.M):
   if 4077<=int(num)<=4213:lines[int(num)]=line
assert all(i in lines for i in range(4077,4214)),[i for i in range(4077,4214) if i not in lines]
facade='\n'.join(lines[i] for i in range(4077,4214))
assert facade.startswith('  const facade: GalleryApi = {')
a=source.index('  const facade: GalleryApi = {');b=source.index('    preferOfflineSnapshot,',a)
source=source[:a]+facade+'\n'+source[b:]
# Reapply the already-green local media projection return/cache behavior.
source=source.replace('        return entry as EntryRecordDto;','        return (await loadOfflineLibrary())!.getEntry(entryId);')
source=source.replace("      if (mode === 'offline') { const entry = await enqueue(); await forgetEntryMedia(await touchedNow()); return entry; }","      if (mode === 'offline') return enqueue();")
source=source.replace("      if (hasMediaOutbox(store) && (await store.listMedia()).length) {\n        const entry = await enqueue();\n        await forgetEntryMedia(await touchedNow());\n        return entry;\n      }","      if (hasMediaOutbox(store) && (await store.listMedia()).length) return enqueue();")
source=source.replace('        const entry = await enqueue();\n        await forgetEntryMedia(await touchedNow());\n        return entry;','        return enqueue();')
source=source.replace('        const updated = await enqueue();\n        await forgetEntryMedia(touched);\n        return updated;','        return enqueue();')
Path('.hermes/tmp/offline-api-recovery-candidate.ts').write_text(source)
print('candidate lines',len(source.splitlines()))
