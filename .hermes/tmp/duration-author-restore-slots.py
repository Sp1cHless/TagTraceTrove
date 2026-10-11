import runpy
r=runpy.run_path('.hermes/tmp/duration-author-patch.py')['replace']
f='apps/web/src/offline/pending-work-restore.ts'
r(f,"    requireRef(payload.ratingSlots.some(row=>same(row.syncUid,op.payload.slotUid) && row.subjectKind===subjectKind && row.entryType===type));", """    const staged = prior.filter(row => {
      if (row.operationKind !== 'rating-layout.slots.set') return false;
      const layout = payload.ratingLayouts?.find(layout => same(layout.syncUid, row.entityUid));
      return layout?.subjectKind === subjectKind && layout.entryType === type;
    }).at(-1);
    const slots = staged ? (staged.payload.slots as Array<{syncUid:string}>) : payload.ratingSlots.filter(row => row.subjectKind === subjectKind && row.entryType === type);
    requireRef(slots.some(row => same(row.syncUid, op.payload.slotUid)));""")
f='apps/web/src/offline/offline-api.ts'
r(f,"throw new Error('Update this offline copy to enable Author self ratings');", "throw new Error('Refresh this offline copy to enable Author self ratings');", count=2)
f='apps/web/src/api/gallery.ts'
r(f,"  localKey: `local:${string}`;\n  title: string;", "  localKey: `local:${string}`;\n  durationSeconds?: number | null;\n  title: string;")
