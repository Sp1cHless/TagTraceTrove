package com.speechless666.t3.spike;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=28) @SQLiteMode(SQLiteMode.Mode.NATIVE)
public class BackgroundTransferJvmTest {
 @Test public void actualFacadePinnedReplayOriginalMultipartColdLedgerThenTypedForegroundAck() throws Exception {
   String repository=System.getenv("T3_TEST_REPO");assertNotNull(repository);
   Process child=new ProcessBuilder("node",java.nio.file.Path.of(repository,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repository,"apps/server/tests/fixtures/secure-pairing-native.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
   java.io.BufferedReader reader=new java.io.BufferedReader(new java.io.InputStreamReader(child.getInputStream(),java.nio.charset.StandardCharsets.UTF_8));
   java.io.PrintWriter writer=new java.io.PrintWriter(child.getOutputStream(),true,java.nio.charset.StandardCharsets.UTF_8);
   android.content.Context context=RuntimeEnvironment.getApplication();String name="primary.db";
   context.getDatabasePath(name).getParentFile().mkdirs();
   try {
     PairingState pair=PairingState.claim(reader.readLine());
     writer.println("{\"action\":\"background-prepare\"}");String prepared=reader.readLine();assertNotNull("Actual facade fixture prepared",prepared);org.json.JSONObject job=new org.json.JSONObject(prepared);
     byte[] bytes=java.util.Base64.getDecoder().decode(job.getString("bytes"));String id=job.getString("opId");
     try(TransferLedger ledger=new TransferLedger(context,name)){
       ledger.stage(job.getString("body"),job.getString("uploadId"),job.getString("metadata"),job.getJSONArray("requiredFlags").toString(),job.getString("revision"),bytes);
       assertTrue(ledger.activate(id,job.getString("revision")));
     }
     // New handles/core constructor after staging: no JS/WebView dependency.
     try(TransferLedger ledger=new TransferLedger(context,name)){
       java.util.concurrent.atomic.AtomicInteger boundary=new java.util.concurrent.atomic.AtomicInteger();
       assertFalse(BackgroundTransferWorker.execute(ledger,PairingState.parse(pair.serialize().toString()),()->boundary.incrementAndGet()==4));
       assertEquals("active",ledger.jobs().getJSONObject(0).getString("phase"));
       assertNotNull(ledger.jobs().getJSONObject(0).get("mediaResult"));
     }
     try(TransferLedger cold=new TransferLedger(context,name)){
       assertTrue(BackgroundTransferWorker.execute(cold,pair,()->false));
       assertEquals(cold.jobs().toString(),"completed",cold.jobs().getJSONObject(0).getString("phase"));
       assertArrayEquals(bytes,cold.mediaBytes(job.getString("uploadId")));
       assertEquals(job.getString("body"),new String(cold.operationBody(id),java.nio.charset.StandardCharsets.UTF_8));
       assertTrue(cold.jobs().getJSONObject(0).getString("mediaResult").contains(job.getString("uploadId")));
       assertTrue(BackgroundTransferWorker.execute(cold,pair,()->false));
     }
     writer.println("{\"action\":\"background-foreground\"}");String foreground=reader.readLine();assertNotNull(foreground);org.json.JSONObject result=new org.json.JSONObject(foreground);
     assertEquals(result.toString(),1,result.getInt("beforeOperations"));assertEquals(1,result.getInt("beforeMedia"));
     assertTrue(result.toString(),result.getBoolean("originalUnchanged"));assertTrue(result.toString(),result.getBoolean("originalBodyRetry"));
     assertEquals(result.toString(),0,result.getInt("afterOperations"));assertEquals(0,result.getInt("afterMedia"));
     assertEquals(1,result.getInt("entryCount"));assertEquals(1,result.getInt("previewCount"));assertEquals(1,result.getInt("replayCount"));assertEquals(1,result.getInt("uploadCount"));assertEquals(1,result.getInt("ackCount"));
     assertTrue(result.isNull("pendingAck"));
     try(TransferLedger cold=new TransferLedger(context,name)){
       cold.pause(null);cold.pruneCancelled(new org.json.JSONArray(),new org.json.JSONArray());
       assertEquals(0,cold.jobs().length());assertNull(cold.operationBody(id));assertNull(cold.mediaBytes(job.getString("uploadId")));
       cold.pruneCancelled(new org.json.JSONArray(),new org.json.JSONArray());assertEquals(0,cold.jobs().length());
     }
   }finally {context.deleteDatabase(name);writer.println("{\"action\":\"close\"}");if(!child.waitFor(15,java.util.concurrent.TimeUnit.SECONDS))child.destroyForcibly();}
 }
 @Test public void actualFacadeMultipleMediaMiddleCommitColdRetryThenTypedForegroundAck() throws Exception {
   String repository=System.getenv("T3_TEST_REPO");assertNotNull(repository);
   ProcessBuilder builder=new ProcessBuilder("node",java.nio.file.Path.of(repository,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repository,"apps/server/tests/fixtures/secure-pairing-native.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT);builder.environment().put("T3_BACKGROUND_MULTIPLE","1");Process child=builder.start();
   java.io.BufferedReader reader=new java.io.BufferedReader(new java.io.InputStreamReader(child.getInputStream(),java.nio.charset.StandardCharsets.UTF_8));
   java.io.PrintWriter writer=new java.io.PrintWriter(child.getOutputStream(),true,java.nio.charset.StandardCharsets.UTF_8);
   android.content.Context context=RuntimeEnvironment.getApplication();String name="multiple.db";
   context.getDatabasePath(name).getParentFile().mkdirs();
   try {
     PairingState pair=PairingState.claim(reader.readLine());
     writer.println("{\"action\":\"background-prepare\"}");String prepared=reader.readLine();assertNotNull("Actual facade fixture prepared",prepared);org.json.JSONObject job=new org.json.JSONObject(prepared);
     byte[] bytes=java.util.Base64.getDecoder().decode(job.getString("bytes"));String id=job.getString("opId");
     try(TransferLedger ledger=new TransferLedger(context,name)){
       org.json.JSONArray uploads=job.getJSONArray("jobs");assertEquals(4,uploads.length());
       for(int n=0;n<uploads.length();n++){org.json.JSONObject image=uploads.getJSONObject(n);
         ledger.stage(image.getString("body"),image.getString("uploadId"),image.getString("metadata"),image.getJSONArray("requiredFlags").toString(),image.getString("revision"),java.util.Base64.getDecoder().decode(image.getString("bytes")));
       }
       assertTrue(ledger.activate(id,job.getString("revision")));
     }
     // New handles/core constructor after staging: no JS/WebView dependency.
     try(TransferLedger ledger=new TransferLedger(context,name)){
       java.util.concurrent.atomic.AtomicInteger boundary=new java.util.concurrent.atomic.AtomicInteger();
       boolean finished=BackgroundTransferWorker.execute(ledger,PairingState.parse(pair.serialize().toString()),()->boundary.incrementAndGet()==6);
       assertFalse(ledger.jobs().toString(),finished);
       assertEquals("active",ledger.jobs().getJSONObject(0).getString("phase"));
       assertNotNull(ledger.jobs().getJSONObject(0).get("mediaResult"));
     }
     try(TransferLedger cold=new TransferLedger(context,name)){
       assertTrue(BackgroundTransferWorker.execute(cold,pair,()->false));
       assertEquals(cold.jobs().toString(),"completed",cold.jobs().getJSONObject(0).getString("phase"));
       assertArrayEquals(bytes,cold.mediaBytes(job.getString("uploadId")));
       assertEquals(job.getString("body"),new String(cold.operationBody(id),java.nio.charset.StandardCharsets.UTF_8));
       assertTrue(cold.jobs().getJSONObject(0).getString("mediaResult").contains(job.getString("uploadId")));
       assertTrue(BackgroundTransferWorker.execute(cold,pair,()->false));
     }
     writer.println("{\"action\":\"background-foreground\"}");String foreground=reader.readLine();assertNotNull(foreground);org.json.JSONObject result=new org.json.JSONObject(foreground);
     assertEquals(result.toString(),1,result.getInt("beforeOperations"));assertEquals(4,result.getInt("beforeMedia"));
     assertTrue(result.toString(),result.getBoolean("originalUnchanged"));assertTrue(result.toString(),result.getBoolean("originalBodyRetry"));
     assertEquals(result.toString(),0,result.getInt("afterOperations"));assertEquals(0,result.getInt("afterMedia"));
     assertEquals(1,result.getInt("entryCount"));assertEquals(3,result.getInt("previewCount"));assertEquals(1,result.getInt("replayCount"));assertEquals(4,result.getInt("uploadCount"));assertEquals(1,result.getInt("ackCount"));
     assertTrue(result.isNull("pendingAck"));
     try(TransferLedger cold=new TransferLedger(context,name)){
       cold.pause(null);cold.pruneCancelled(new org.json.JSONArray(),new org.json.JSONArray());
       assertEquals(0,cold.jobs().length());assertNull(cold.operationBody(id));assertNull(cold.mediaBytes(job.getString("uploadId")));
       cold.pruneCancelled(new org.json.JSONArray(),new org.json.JSONArray());assertEquals(0,cold.jobs().length());
     }
   }finally {context.deleteDatabase(name);writer.println("{\"action\":\"close\"}");if(!child.waitFor(15,java.util.concurrent.TimeUnit.SECONDS))child.destroyForcibly();}
 }
 @Test public void missingAdditionalMediaCapabilityHoldsWholeCreateBeforeAnyWrite() throws Exception {
   String repository=System.getenv("T3_TEST_REPO");assertNotNull(repository);
   ProcessBuilder builder=new ProcessBuilder("node",java.nio.file.Path.of(repository,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repository,"apps/server/tests/fixtures/secure-pairing-native.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT);builder.environment().put("T3_BACKGROUND_MULTIPLE","1");Process child=builder.start();
   java.io.BufferedReader reader=new java.io.BufferedReader(new java.io.InputStreamReader(child.getInputStream(),java.nio.charset.StandardCharsets.UTF_8));
   java.io.PrintWriter writer=new java.io.PrintWriter(child.getOutputStream(),true,java.nio.charset.StandardCharsets.UTF_8);
   android.content.Context context=RuntimeEnvironment.getApplication();String name="missing-capability.db";
   context.getDatabasePath(name).getParentFile().mkdirs();
   try {
     PairingState pair=PairingState.claim(reader.readLine());
     writer.println("{\"action\":\"background-prepare\"}");String prepared=reader.readLine();assertNotNull("Actual facade fixture prepared",prepared);org.json.JSONObject job=new org.json.JSONObject(prepared);
     byte[] bytes=java.util.Base64.getDecoder().decode(job.getString("bytes"));String id=job.getString("opId");
     try(TransferLedger ledger=new TransferLedger(context,name)){
       org.json.JSONArray uploads=job.getJSONArray("jobs");assertEquals(4,uploads.length());
       for(int n=0;n<uploads.length();n++){org.json.JSONObject image=uploads.getJSONObject(n);
         ledger.stage(image.getString("body"),image.getString("uploadId"),image.getString("metadata"),(n==1 ? image.getJSONArray("requiredFlags").put("unimplementedRequiredCapability") : image.getJSONArray("requiredFlags")).toString(),image.getString("revision"),java.util.Base64.getDecoder().decode(image.getString("bytes")));
       }
       assertTrue(ledger.activate(id,job.getString("revision")));
     }
     try(TransferLedger ledger=new TransferLedger(context,name)){
       assertTrue(BackgroundTransferWorker.execute(ledger,pair,()->false));
       assertEquals("held",ledger.jobs().getJSONObject(0).getString("phase"));
       assertTrue("Unsupported later image must prevent parent operation writes",ledger.jobs().getJSONObject(0).isNull("replay"));
       assertArrayEquals(bytes,ledger.mediaBytes(job.getString("uploadId")));
     }
     writer.println("{\"action\":\"background-foreground\"}");org.json.JSONObject result=new org.json.JSONObject(reader.readLine());
     assertEquals(1,result.getInt("beforeOperations"));assertEquals(4,result.getInt("beforeMedia"));assertTrue(result.getBoolean("originalUnchanged"));
   }finally {context.deleteDatabase(name);writer.println("{\"action\":\"close\"}");if(!child.waitFor(15,java.util.concurrent.TimeUnit.SECONDS))child.destroyForcibly();}
 }
 @Test public void actualFacadeNoMediaPinnedReplayColdLedgerThenTypedForegroundAck() throws Exception {
   String repository=System.getenv("T3_TEST_REPO");assertNotNull(repository);
   ProcessBuilder builder=new ProcessBuilder("node",java.nio.file.Path.of(repository,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repository,"apps/server/tests/fixtures/secure-pairing-native.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT); builder.environment().put("T3_BACKGROUND_NO_MEDIA","1"); Process child=builder.start();
   java.io.BufferedReader reader=new java.io.BufferedReader(new java.io.InputStreamReader(child.getInputStream(),java.nio.charset.StandardCharsets.UTF_8));
   java.io.PrintWriter writer=new java.io.PrintWriter(child.getOutputStream(),true,java.nio.charset.StandardCharsets.UTF_8);
   android.content.Context context=RuntimeEnvironment.getApplication();String name="no-media.db";
   context.getDatabasePath(name).getParentFile().mkdirs();
   try {
     PairingState pair=PairingState.claim(reader.readLine());
     writer.println("{\"action\":\"background-prepare\"}");String prepared=reader.readLine();assertNotNull("Actual facade fixture prepared",prepared);org.json.JSONObject job=new org.json.JSONObject(prepared);
     byte[] bytes=java.util.Base64.getDecoder().decode(job.getString("bytes"));String id=job.getString("opId");
     try(TransferLedger ledger=new TransferLedger(context,name)){
       ledger.stage(job.getString("body"),null,null,job.getJSONArray("requiredFlags").toString(),job.getString("revision"),bytes);
       assertTrue(ledger.activate(id,job.getString("revision")));
     }
     // New handles/core constructor after staging: no JS/WebView dependency.
     try(TransferLedger ledger=new TransferLedger(context,name)){
       assertTrue(BackgroundTransferWorker.execute(ledger,pair,()->false));
       assertEquals("completed",ledger.jobs().getJSONObject(0).getString("phase"));
     }
     try(TransferLedger cold=new TransferLedger(context,name)){
       assertTrue(BackgroundTransferWorker.execute(cold,pair,()->false));
       assertEquals(cold.jobs().toString(),"completed",cold.jobs().getJSONObject(0).getString("phase"));
       assertEquals(0,bytes.length);
       assertEquals(job.getString("body"),new String(cold.operationBody(id),java.nio.charset.StandardCharsets.UTF_8));
       assertTrue(cold.jobs().getJSONObject(0).isNull("mediaResult"));
       assertTrue(BackgroundTransferWorker.execute(cold,pair,()->false));
     }
     writer.println("{\"action\":\"background-foreground\"}");String foreground=reader.readLine();assertNotNull(foreground);org.json.JSONObject result=new org.json.JSONObject(foreground);
     assertEquals(result.toString(),1,result.getInt("beforeOperations"));assertEquals(0,result.getInt("beforeMedia"));
     assertTrue(result.toString(),result.getBoolean("originalUnchanged"));assertTrue(result.toString(),result.getBoolean("originalBodyRetry"));
     assertEquals(result.toString(),0,result.getInt("afterOperations"));assertEquals(0,result.getInt("afterMedia"));
     assertEquals(1,result.getInt("entryCount"));assertEquals(0,result.getInt("previewCount"));assertEquals(1,result.getInt("replayCount"));assertEquals(0,result.getInt("uploadCount"));assertEquals(1,result.getInt("ackCount"));
     assertTrue(result.isNull("pendingAck"));
     try(TransferLedger cold=new TransferLedger(context,name)){
       cold.pause(null);cold.pruneCancelled(new org.json.JSONArray(),new org.json.JSONArray());
       assertEquals(0,cold.jobs().length());assertNull(cold.operationBody(id));
       cold.pruneCancelled(new org.json.JSONArray(),new org.json.JSONArray());assertEquals(0,cold.jobs().length());
     }
   }finally {context.deleteDatabase(name);writer.println("{\"action\":\"close\"}");if(!child.waitFor(15,java.util.concurrent.TimeUnit.SECONDS))child.destroyForcibly();}
 }
 @Test public void activeNativeLeaseBlocksDiscardAndExpiredOrStaleCompletionCannotAuthorizeMediaCleanup() throws Exception {
   android.content.Context context=RuntimeEnvironment.getApplication();String name="guards.db";
   byte[] bytes={1};String id="guard-op";
   String body=new org.json.JSONObject().put("opId",id).put("clientId","original-client").put("libraryId","library").put("syncEpoch","epoch").put("entityKind","entry").put("operationKind","entry.create").put("entityUid","owner").toString();
   String metadata=new org.json.JSONObject().put("libraryId","library").put("syncEpoch","epoch").put("entryUid","owner").put("byteLength",1).put("sha256",TransferLedger.sha256(bytes)).put("mimeType","image/png").toString();
   context.getDatabasePath(name).getParentFile().mkdirs();
   try(TransferLedger first=new TransferLedger(context,name);TransferLedger peer=new TransferLedger(context,name)){
     first.stage(body,"original-upload",metadata,"[]","revision",bytes);assertTrue(first.activate(id,"revision"));
     assertTrue(first.claimJob(id,"first",100));assertFalse(peer.claimJob(id,"peer",101));
     try{peer.pause(null);fail("In-flight native mutation must block discard");}catch(IllegalStateException expected){}
     assertFalse(first.finishJob(id,"first",body.getBytes(java.nio.charset.StandardCharsets.UTF_8),"completed",new byte[]{1},new byte[]{2},null,120100));
     assertTrue(peer.claimJob(id,"peer",120100));
     assertFalse(first.finishJob(id,"first",body.getBytes(java.nio.charset.StandardCharsets.UTF_8),"completed",new byte[]{1},new byte[]{2},null,120101));
     assertTrue(peer.finishJob(id,"peer",body.getBytes(java.nio.charset.StandardCharsets.UTF_8),"held",new byte[]{1},null,"conflict",120101));
     peer.pause(null);assertFalse(first.activate(id,"revision"));
     first.pruneCancelled(new org.json.JSONArray().put(id),new org.json.JSONArray().put("original-upload"));assertArrayEquals(bytes,first.mediaBytes("original-upload"));
   }finally{context.deleteDatabase(name);}
 }
 @Test public void uniqueProductionJobWaitsForNetworkConstraint() throws Exception {
   android.content.Context context=RuntimeEnvironment.getApplication();
   androidx.work.testing.WorkManagerTestInitHelper.initializeTestWorkManager(context,new androidx.work.Configuration.Builder().setExecutor(new androidx.work.testing.SynchronousExecutor()).build());
   BackgroundTransferWorker.schedule(context);
   androidx.work.WorkManager manager=androidx.work.WorkManager.getInstance(context);
   java.util.List<androidx.work.WorkInfo> jobs=manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get();
   assertEquals(1,jobs.size());assertEquals(androidx.work.WorkInfo.State.ENQUEUED,jobs.get(0).getState());
   assertEquals(androidx.work.NetworkType.CONNECTED,jobs.get(0).getConstraints().getRequiredNetworkType());
   assertNotNull(androidx.work.testing.WorkManagerTestInitHelper.getTestDriver(context));
   manager.cancelUniqueWork(BackgroundTransferWorker.WORK).getResult().get();
 }
 @Test public void productionWorkerIsRealOsScheduledWorkNotWebViewHelper() throws Exception {
   Class<?> worker;
   try { worker=Class.forName("com.speechless666.t3.spike.BackgroundTransferWorker"); }
   catch(ClassNotFoundException missing) { fail("Real production WorkManager Worker missing"); return; }
   assertEquals("androidx.work.Worker",worker.getSuperclass().getName());
 }
 @Test public void standaloneActualFacadePinnedTlsColdRetryNoSyntheticCreateThenForegroundAck() throws Exception {
   String repository=System.getenv("T3_TEST_REPO");assertNotNull(repository);
   ProcessBuilder builder=new ProcessBuilder("node",java.nio.file.Path.of(repository,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repository,"apps/server/tests/fixtures/secure-pairing-native.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT);
   builder.environment().put("T3_BACKGROUND_STANDALONE","1");Process child=builder.start();
   java.io.BufferedReader reader=new java.io.BufferedReader(new java.io.InputStreamReader(child.getInputStream(),java.nio.charset.StandardCharsets.UTF_8));
   java.io.PrintWriter writer=new java.io.PrintWriter(child.getOutputStream(),true,java.nio.charset.StandardCharsets.UTF_8);
   android.content.Context context=RuntimeEnvironment.getApplication();String name="standalone.db";
   try {
     PairingState pair=PairingState.claim(reader.readLine());writer.println("{\"action\":\"background-prepare\"}");
     org.json.JSONObject prepared=new org.json.JSONObject(reader.readLine());assertEquals(0,prepared.getInt("pendingOperations"));
     org.json.JSONArray uploads=prepared.getJSONArray("jobs");assertEquals(3,uploads.length());
     java.lang.reflect.Method stage=TransferLedger.class.getMethod("stageStandaloneMedia",String.class,String.class,String.class,String.class,String.class,byte[].class);
     java.lang.reflect.Method activate=TransferLedger.class.getMethod("activateStandaloneMedia",String.class,String.class);
     try(TransferLedger ledger=new TransferLedger(context,name)) {
       for(int n=0;n<uploads.length();n++) {org.json.JSONObject image=uploads.getJSONObject(n);
         assertFalse(image.has("body"));assertFalse(image.has("opId"));
         stage.invoke(ledger,image.getString("clientId"),image.getString("uploadId"),image.getString("metadata"),image.getJSONArray("requiredFlags").toString(),image.getString("revision"),java.util.Base64.getDecoder().decode(image.getString("bytes")));
         assertEquals(true,activate.invoke(ledger,image.getString("uploadId"),image.getString("revision")));
       }
       assertEquals(0,android.database.DatabaseUtils.longForQuery(ledger.getReadableDatabase(),"SELECT COUNT(*) FROM operations",null));
       java.util.concurrent.atomic.AtomicInteger boundary=new java.util.concurrent.atomic.AtomicInteger();
       assertFalse(BackgroundTransferWorker.execute(ledger,pair,()->false));
       assertEquals("completed",ledger.standaloneMedia().getJSONObject(0).getString("phase"));
       assertEquals("active",ledger.standaloneMedia().getJSONObject(1).getString("phase"));
     }
     try(TransferLedger cold=new TransferLedger(context,name)) {assertTrue(BackgroundTransferWorker.execute(cold,pair,()->false));}
     writer.println("{\"action\":\"background-foreground\"}");org.json.JSONObject result=new org.json.JSONObject(reader.readLine());
     assertEquals(result.toString(),0,result.getInt("beforeOperations"));assertEquals(3,result.getInt("beforeMedia"));assertTrue(result.getBoolean("originalUnchanged"));assertTrue(result.getBoolean("originalBodyRetry"));
     assertEquals(result.toString(),0,result.getInt("afterMedia"));assertEquals(0,result.getInt("replayCount"));assertEquals(3,result.getInt("uploadCount"));assertEquals(1,result.getInt("entryCount"));assertEquals(2,result.getInt("previewCount"));assertEquals(0,result.getInt("registryCount"));assertEquals(1,result.getInt("ackCount"));
     org.json.JSONArray trace=result.getJSONArray("nativeUploads");assertEquals(result.toString(),4,trace.length());assertEquals(3,result.getInt("mediaReceiptCount"));
     assertEquals(trace.getJSONObject(1).getString("uploadId"),trace.getJSONObject(2).getString("uploadId"));
     assertEquals(trace.getJSONObject(1).getJSONObject("metadata").toString(),trace.getJSONObject(2).getJSONObject("metadata").toString());assertEquals(trace.getJSONObject(1).getString("hash"),trace.getJSONObject(2).getString("hash"));
     try(TransferLedger cold=new TransferLedger(context,name)){cold.pause(null);cold.pruneStandalone(new org.json.JSONArray());assertEquals(0,cold.standaloneMedia().length());}
   }finally{context.deleteDatabase(name);writer.println("{\"action\":\"close\"}");if(!child.waitFor(15,java.util.concurrent.TimeUnit.SECONDS))child.destroyForcibly();}
 }
 @Test public void standaloneMissingCoverPredecessorIsHeldBeforeAnyUpload() throws Exception {
   String repository=System.getenv("T3_TEST_REPO");ProcessBuilder builder=new ProcessBuilder("node",java.nio.file.Path.of(repository,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repository,"apps/server/tests/fixtures/secure-pairing-native.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT);builder.environment().put("T3_BACKGROUND_STANDALONE","1");Process child=builder.start();
   java.io.BufferedReader reader=new java.io.BufferedReader(new java.io.InputStreamReader(child.getInputStream(),java.nio.charset.StandardCharsets.UTF_8));java.io.PrintWriter writer=new java.io.PrintWriter(child.getOutputStream(),true,java.nio.charset.StandardCharsets.UTF_8);android.content.Context context=RuntimeEnvironment.getApplication();String name="missing-predecessor.db";
   try {
     PairingState pair=PairingState.claim(reader.readLine());writer.println("{\"action\":\"background-prepare\"}");org.json.JSONObject image=new org.json.JSONObject(reader.readLine()).getJSONArray("jobs").getJSONObject(1);
     try(TransferLedger ledger=new TransferLedger(context,name)) {
       ledger.stageStandaloneMedia(image.getString("clientId"),image.getString("uploadId"),image.getString("metadata"),image.getJSONArray("requiredFlags").toString(),image.getString("revision"),java.util.Base64.getDecoder().decode(image.getString("bytes")));ledger.activateStandaloneMedia(image.getString("uploadId"),image.getString("revision"));
       assertTrue(BackgroundTransferWorker.execute(ledger,pair,()->false));assertEquals("held",ledger.standaloneMedia().getJSONObject(0).getString("phase"));
     }
     writer.println("{\"action\":\"background-counters\"}");org.json.JSONObject counters=new org.json.JSONObject(reader.readLine());assertEquals(counters.toString(),0,counters.getJSONArray("nativeUploads").length());
   }finally{context.deleteDatabase(name);writer.println("{\"action\":\"close\"}");if(!child.waitFor(15,java.util.concurrent.TimeUnit.SECONDS))child.destroyForcibly();}
 }
 @Test public void currentMultiKindFacadePinnedTlsSqlColdRetryThenOriginalForegroundTypedAck() throws Exception {
   String repository=System.getenv("T3_TEST_REPO");assertNotNull(repository);
   ProcessBuilder builder=new ProcessBuilder("node",java.nio.file.Path.of(repository,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repository,"apps/server/tests/fixtures/secure-pairing-native.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT);builder.environment().put("T3_BACKGROUND_KINDS","1");Process child=builder.start();
   java.io.BufferedReader reader=new java.io.BufferedReader(new java.io.InputStreamReader(child.getInputStream(),java.nio.charset.StandardCharsets.UTF_8));java.io.PrintWriter writer=new java.io.PrintWriter(child.getOutputStream(),true,java.nio.charset.StandardCharsets.UTF_8);
   android.content.Context context=RuntimeEnvironment.getApplication();String name="all-kinds-vertical.db";
   try {
    PairingState pair=PairingState.claim(reader.readLine());writer.println("{\"action\":\"background-prepare\"}");String prepared=reader.readLine();assertNotNull("Real multi-kind facade prepare",prepared);org.json.JSONObject packet=new org.json.JSONObject(prepared);org.json.JSONArray jobs=packet.getJSONArray("jobs");assertTrue(packet.toString(),jobs.length()>=8);
    try(TransferLedger ledger=new TransferLedger(context,name)){for(int n=0;n<jobs.length();n++){org.json.JSONObject job=jobs.getJSONObject(n);ledger.stagePlannedOperation(job.getString("body"),job.getString("revision"),job.getJSONObject("plan").toString());assertTrue(ledger.activate(job.getJSONObject("plan").getString("opId"),job.getString("revision")));}assertFalse(BackgroundTransferWorker.execute(ledger,pair,()->false));assertEquals("active",ledger.jobs().getJSONObject(1).getString("phase"));assertEquals("completed",ledger.jobs().getJSONObject(jobs.length()-1).getString("phase"));}
    try(TransferLedger cold=new TransferLedger(context,name)){assertTrue(BackgroundTransferWorker.execute(cold,pair,()->false));for(int n=0;n<jobs.length();n++){assertEquals(cold.jobs().toString(),"completed",cold.jobs().getJSONObject(n).getString("phase"));assertEquals(jobs.getJSONObject(n).getString("body"),new String(cold.operationBody(jobs.getJSONObject(n).getJSONObject("plan").getString("opId")),java.nio.charset.StandardCharsets.UTF_8));}}
    writer.println("{\"action\":\"background-foreground\"}");org.json.JSONObject result=new org.json.JSONObject(reader.readLine());assertEquals(result.toString(),0,result.getInt("afterOperations"));assertTrue(result.toString(),result.getBoolean("originalUnchanged"));assertTrue(result.toString(),result.getBoolean("originalBodyRetry"));assertEquals(result.toString(),1,result.getInt("acks"));assertTrue(result.isNull("pendingAck"));assertEquals("Native edited owner",result.getString("ownerTitle"));assertEquals(result.toString(),result.getInt("baselineProducerCount")+1,result.getInt("producerCount"));assertEquals(result.toString(),result.getInt("baselineFacetCount")+1,result.getInt("facetCount"));assertEquals(1,result.getInt("tagCount"));assertEquals(1,result.getInt("collectionCount"));assertEquals(1,result.getInt("directoryCount"));
    org.json.JSONArray trace=result.getJSONArray("nativeReplayBodies");assertEquals(jobs.length()+1,trace.length());String original=trace.getString(1);int retries=0;for(int n=0;n<trace.length();n++)if(original.equals(trace.getString(n)))retries++;assertEquals(2,retries);
   }finally{context.deleteDatabase(name);writer.println("{\"action\":\"close\"}");if(!child.waitFor(15,java.util.concurrent.TimeUnit.SECONDS))child.destroyForcibly();}
 }
}
