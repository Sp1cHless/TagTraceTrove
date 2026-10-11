from pathlib import Path
import runpy,json
changes=[]; buffers={}
def r(path,old,new,count=1):
 s=buffers.get(path,Path(path).read_text())
 if old=='      payload: { slotUid: slot.syncUid, stars: desiredStars },':
  prefix=s[s.index("      operationKind: 'producer.rating.set',",s.index('  async function enqueueProducerRating')):s.index(old,s.index('  async function enqueueProducerRating'))]
  old,new=prefix+old,prefix+new
 assert s.count(old)==count,(path,s.count(old),old)
 buffers[path]=s.replace(old,new); changes.append(dict(path=path,old=old,new=new,count=count))
s=Path('.hermes/tmp/capability-patches.py').read_text()
s=s.replace("r=runpy.run_path('.hermes/tmp/duration-author-patch.py')['replace']",'')
s=s.replace('         await store.writeMeta(GALLERY_ORDER_CAPABILITY_KEY,','        await store.writeMeta(GALLERY_ORDER_CAPABILITY_KEY,')
s=s.replace('s=Path(f).read_text()', 's=buffers.get(f,Path(f).read_text())')
exec(compile(s,'candidate','exec'))
print('DRYRUN verified',len(changes),'unique targeted replacements')
apply=runpy.run_path('.hermes/tmp/duration-author-patch.py')['replace']
for change in changes: apply(**change)
print('APPLIED',len(changes))
