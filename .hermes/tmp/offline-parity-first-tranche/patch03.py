from safe_edit import edit
edit('apps/web/tests/fixtures/native-valid-kind-fixture.ts'," 'entry.update': {", " 'entry.delete': { baseVersion: 1, baseValues: {}, payload: {} },\n 'entry.update': {")
edit('apps/web/src/offline/native-background-transfer.ts',"      const plan=plans.get(row.opId)!;", """      const plan=plans.get(row.opId)!;
      // Existing-media originals require foreground crossqueue receipt ordering;
      // deletion must not race ahead of an upload that has not settled there.
      if (row.operationKind === 'entry.delete' && capture.media.some(image => image.entryUid.toLowerCase() === row.entityUid.toLowerCase())) continue;""")
edit('apps/web/src/offline/native-background-transfer.ts',"          || (row.operationKind === 'entry.create' && latest.media.some(value => value.entryUid.toLowerCase() === row.entityUid.toLowerCase()))", "          || ((row.operationKind === 'entry.create' || row.operationKind === 'entry.delete') && latest.media.some(value => value.entryUid.toLowerCase() === row.entityUid.toLowerCase()))")
edit('apps/web/src/offline/sync-mutation-plan.ts',"   if(refs.includes(`${op.entityKind}:${op.entityUid.toLowerCase()}`)", "   if((operation.operationKind==='entry.delete' && referencedEntityKeys(op).map(key=>key.toLowerCase()).includes(ownerKey)) || refs.includes(`${op.entityKind}:${op.entityUid.toLowerCase()}`)")
