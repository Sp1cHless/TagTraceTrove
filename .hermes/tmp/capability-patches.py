import runpy
from pathlib import Path
r=runpy.run_path('.hermes/tmp/duration-author-patch.py')['replace']
f='packages/shared/src/schemas/sync.ts'
s=Path(f).read_text();a=s.index('const syncProducerRatingOperationSchema');b=s.index('const syncProducerTagValueSchema',a);old=s[a:b];new=old.replace("  payload: z.strictObject({\n    slotUid: syncUidSchema,", "  payload: z.strictObject({\n    subjectKind: z.enum(['producer', 'author_self']).optional(),\n    slotUid: syncUidSchema,");r(f,old,new)
r(f,'deletedSlotUids: z.array(syncUidSchema).max(1).optional(),','deletedSlotUids: z.array(syncUidSchema).max(1).optional(),\n    subjectKind: ratingSubjectKindSchema.optional(),')
f='apps/web/src/offline/sync-mutation-plan.ts'
r(f," const add=(flag:string)=>{if(!flags.includes(flag))flags.push(flag);};", """ const add=(flag:string)=>{if(!flags.includes(flag))flags.push(flag);};
 if((operation.operationKind==='entry.update' || operation.operationKind==='entry.create') && Object.hasOwn(p,'durationSeconds'))add('offlineEntryDuration');
 if(p.subjectKind==='author_self' || Object.hasOwn(p,'galleryAnchor'))add('offlineAuthorSelfRatings');
 if(Object.hasOwn(p,'deletedSlotUids'))add('offlineRatingSlotDelete');""")
f='spikes/001-android-webview-shell/android/app/src/main/java/com/speechless666/t3/spike/NativeMutationPlan.java'
r(f,'  return result;','''  if((kind.equals("entry.update") || kind.equals("entry.create")) && p.has("durationSeconds"))add(result,"offlineEntryDuration");
  if("author_self".equals(p.optString("subjectKind")) || p.has("galleryAnchor"))add(result,"offlineAuthorSelfRatings");
  if(p.has("deletedSlotUids"))add(result,"offlineRatingSlotDelete");
  return result;''')
# JS adds extensions before existing conditional flags. Native must match that order exactly.
s=Path(f).read_text();start=s.index('  if((kind.equals("entry.update")');end=s.index('  return result;',start);block=s[start:end];r(f,block,'');r(f,'  if(kind.equals("entry.create"))',block+'  if(kind.equals("entry.create"))')
f='apps/server/src/sync/sync-service.ts'
r(f,'      offlineProducerRating: true,','      offlineProducerRating: true,\n      offlineEntryDuration: sqliteSchemaVersion >= 38,\n      offlineRatingSlotDelete: sqliteSchemaVersion >= 39,')
f='apps/web/src/offline/offline-api.ts'
r(f,"         await store.writeMeta(GALLERY_ORDER_CAPABILITY_KEY,", """         for (const flag of ['offlineEntryDuration', 'offlineAuthorSelfRatings', 'offlineRatingSlotDelete']) {
           await store.writeMeta(`capability.${flag}`, result.featureFlags?.offlineMutations === true && result.featureFlags[flag] === true ? '1' : '0');
         }
         await store.writeMeta(GALLERY_ORDER_CAPABILITY_KEY,""")
r(f,"if (input.durationSeconds !== undefined && (active.snapshot.header.sqliteSchemaVersion < 38 || current.durationSeconds === undefined))", "if (input.durationSeconds !== undefined && (await store.readMeta('capability.offlineEntryDuration') !== '1' || active.snapshot.header.sqliteSchemaVersion < 38 || current.durationSeconds === undefined))")
r(f,"    if (slot?.syncUid === undefined) {\n      throw new Error('Author rating slot", "    if (slot?.subjectKind === 'author_self' && await store.readMeta('capability.offlineAuthorSelfRatings') !== '1') throw new Error('Update this offline copy to enable Author self ratings');\n    if (slot?.syncUid === undefined) {\n      throw new Error('Author rating slot")
r(f,"      payload: { slotUid: slot.syncUid, stars: desiredStars },", "      payload: { slotUid: slot.syncUid, stars: desiredStars, ...(slot.subjectKind === 'author_self' ? { subjectKind: 'author_self' as const } : {}) },")
r(f,"    if (input.galleryAnchor !== undefined) {", "    if (input.galleryAnchor !== undefined) {\n      if (await store.readMeta('capability.offlineAuthorSelfRatings') !== '1') throw new Error('Update this offline copy to enable Gallery anchor edits');")
r(f,"    const active = await readActiveSnapshot(store);\n    if (active === null) throw transportError ?? new Error('Rating slot layout", "    if (subjectKind === 'author_self' && await store.readMeta('capability.offlineAuthorSelfRatings') !== '1') throw new Error('Update this offline copy to enable Author self ratings');\n    const active = await readActiveSnapshot(store);\n    if (active === null) throw transportError ?? new Error('Rating slot layout")
r(f,"    if (JSON.stringify(currentSlots) === JSON.stringify(desiredSlots)) return projected;", "    if (JSON.stringify(currentSlots) === JSON.stringify(desiredSlots)) return projected;\n    if (currentSlots.some(slot => !desiredSlots.some(row => row.syncUid === slot.syncUid)) && await store.readMeta('capability.offlineRatingSlotDelete') !== '1') throw new Error('Update this offline copy to enable rating dimension deletion');")
r(f,"      payload: { slots: desiredSlots,", "      payload: { slots: desiredSlots, ...(subjectKind === 'author_self' ? { subjectKind } : {}),")
