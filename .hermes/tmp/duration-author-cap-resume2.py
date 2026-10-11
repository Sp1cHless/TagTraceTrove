from pathlib import Path
import runpy
r=runpy.run_path('.hermes/tmp/duration-author-patch.py')['replace']
s=Path('.hermes/tmp/capability-patches.py').read_text().splitlines()[18:]
s='\n'.join(line for line in s if not line.startswith('r(f,"      payload: { slotUid:'))
s=s.replace('         await store.writeMeta(GALLERY_ORDER_CAPABILITY_KEY,','        await store.writeMeta(GALLERY_ORDER_CAPABILITY_KEY,')
exec(compile(s,'resume2','exec'))
f='apps/web/src/offline/offline-api.ts';s=Path(f).read_text();a=s.index("      operationKind: 'producer.rating.set',",s.index('  async function enqueueProducerRating'));b=s.index('    }, { randomUUID });',a);old=s[a:b]
r(f,old,old.replace('payload: { slotUid: slot.syncUid, stars: desiredStars }',"payload: { slotUid: slot.syncUid, stars: desiredStars, ...(slot.subjectKind === 'author_self' ? { subjectKind: 'author_self' as const } : {}) }"))
print('remaining candidate APPLIED')
