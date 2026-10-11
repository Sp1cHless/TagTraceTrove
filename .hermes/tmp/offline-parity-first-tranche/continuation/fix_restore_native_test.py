from edit import edit
edit('apps/web/src/offline/pending-work-restore.ts',"  for (const [index,row] of union.entries()) {\n    if", "  for (const [index,row] of union.entries()) {\n    if (row.entityKind === 'entry' && union.slice(0,index).some(prior => prior.operationKind === 'entry.delete' && uid(prior.entityUid) === uid(row.entityUid))) {\n      throw new Error('A deleted Entry cannot accept later restored edits; nothing was restored');\n    }\n    if")
p='spikes/001-android-webview-shell/android/app/src/test/java/com/speechless666/t3/spike/NativeWorkerAuthorityAcceptanceJvmTest.java'
edit(p,' @Test public void cachedCompletedInvalidReceiptsNeverGrantDependencies()throws Exception{', ''' @Test public void deletionDefersAcrossStandaloneMediaQueueAndRetainsUncertainOriginals()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="delete-media.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
   JSONObject op=row(f,"entry.delete");stage(l,op,new JSONArray());byte[] bytes={1,2,3};String upload=java.util.UUID.randomUUID().toString();
   JSONObject metadata=new JSONObject().put("libraryId",op.getString("libraryId")).put("syncEpoch",op.getString("syncEpoch")).put("entryUid",op.getString("entityUid")).put("byteLength",3).put("sha256",TransferLedger.sha256(bytes)).put("mimeType","image/png").put("kind","cover").put("ordinal",0).put("existingEntry",new JSONObject().put("expectedCoverRef",JSONObject.NULL).put("expectedPreviewRefs",new JSONArray()));
   l.stageStandaloneMedia(op.getString("clientId"),upload,metadata.toString(),"[]","1",bytes);l.activateStandaloneMedia(upload,"1");f.mode(new JSONObject());
   BackgroundTransferWorker.execute(l,f.pair,()->false);assertEquals("active",job(l,op.getString("opId")).getString("phase"));retained(l,op);assertArrayEquals(bytes,l.standaloneBytes(upload));assertEquals(0,f.counters().getJSONArray("mutations").length());
  }finally{c.deleteDatabase(name);}
 }
 @Test public void cachedCompletedInvalidReceiptsNeverGrantDependencies()throws Exception{''')
