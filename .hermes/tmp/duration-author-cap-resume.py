from pathlib import Path
import runpy
r=runpy.run_path('.hermes/tmp/duration-author-patch.py')['replace']
f='spikes/001-android-webview-shell/android/app/src/main/java/com/speechless666/t3/spike/NativeMutationPlan.java'
s=Path(f).read_text();a=s.index(' static JSONArray flags(');b=s.index(' static boolean nonempty',a);old=s[a:b]
x=old.index('  if((kind.equals("entry.update")');y=old.index('  return result;',x);block=old[x:y];new=old[:x]+old[y:];new=new.replace('  if(kind.equals("entry.create"))',block+'  if(kind.equals("entry.create"))');r(f,old,new)
s=Path('.hermes/tmp/capability-patches.py').read_text().splitlines();s='\n'.join(s[18:]);s=s.replace('         await store.writeMeta(GALLERY_ORDER_CAPABILITY_KEY,','        await store.writeMeta(GALLERY_ORDER_CAPABILITY_KEY,')
s=s.replace("r(f,\"      payload: { slotUid: slot.syncUid, stars: desiredStars },\", \"      payload: { slotUid: slot.syncUid, stars: desiredStars, ...(slot.subjectKind === 'author_self' ? { subjectKind: 'author_self' as const } : {}) },\")", "old=Path(f).read_text();a=old.index(\"      operationKind: 'producer.rating.set',\",old.index('  async function enqueueProducerRating'));b=old.index('    }, { randomUUID });',a);old=old[a:b];r(f,old,old.replace('payload: { slotUid: slot.syncUid, stars: desiredStars }','payload: { slotUid: slot.syncUid, stars: desiredStars, ...(slot.subjectKind === \'author_self\' ? { subjectKind: \'author_self\' as const } : {}) }'))")
exec(compile(s,'resume','exec'))
print('Remaining capability replacements applied')
