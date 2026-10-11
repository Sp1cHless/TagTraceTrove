from edit import edit
edit('apps/web/tests/offline-entry-delete.integration.test.ts',"  await f.current.deleteEntry(f.entry.id);const operations=await f.store.list();const media=await f.store.listMedia();expect(media).toHaveLength(1);", "  await f.current.setEntryMediaOrder!(f.entry.id,[]);\n  await f.current.deleteEntry(f.entry.id);const operations=await f.store.list();const media=await f.store.listMedia();expect(media).toHaveLength(1);")
edit('spikes/001-android-webview-shell/android/app/src/main/java/com/speechless666/t3/spike/BackgroundTransferWorker.java',"     if(!ledger.dependenciesApplied(id))continue;", """     // Foreground owns settlement across queues. A retained upload (even a
     // completed uncertain receipt) is not authority to delete its owner.
     JSONObject staged=new JSONObject(new String(body,StandardCharsets.UTF_8));
     if("entry.delete".equals(staged.optString("operationKind"))) {
       boolean retained=false;JSONArray mediaRows=ledger.standaloneMedia();
       for(int n=0;n<mediaRows.length();n++)if(staged.optString("entityUid").equalsIgnoreCase(mediaRows.getJSONObject(n).getJSONObject("metadata").optString("entryUid")))retained=true;
       if(retained)continue;
     }
     if(!ledger.dependenciesApplied(id))continue;""")
