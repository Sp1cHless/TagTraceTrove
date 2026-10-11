package com.speechless666.t3.spike;
import android.content.Context;
import androidx.work.*;
import androidx.work.testing.*;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import java.nio.charset.StandardCharsets;
import java.util.function.LongSupplier;
import static org.junit.Assert.*;
/** Real Worker.doWork, WorkManager retry, pinned TLS and temporary file SQL business applies. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=28,instrumentedPackages={"com.speechless666.t3.spike"},shadows={FiniteBudgetJvmTest.VaultShadow.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class FiniteBudgetJvmTest {
 @Test public void createTwoImagesBudgetRetainsProgressThenColdExactRetryAndTypedAck()throws Exception{
  String repo=System.getenv("T3_TEST_REPO");assertNotNull(repo);
  ProcessBuilder builder=new ProcessBuilder("node",java.nio.file.Path.of(repo,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repo,"apps/server/tests/fixtures/secure-pairing-native.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT);
  builder.environment().put("T3_BACKGROUND_TWO","1");Process child=builder.start();
  java.io.BufferedReader reader=new java.io.BufferedReader(new java.io.InputStreamReader(child.getInputStream(),StandardCharsets.UTF_8));java.io.PrintWriter writer=new java.io.PrintWriter(child.getOutputStream(),true,StandardCharsets.UTF_8);
  Context context=RuntimeEnvironment.getApplication();context.deleteDatabase(BackgroundTransferWorker.DATABASE);
  java.util.concurrent.atomic.AtomicBoolean cut=new java.util.concurrent.atomic.AtomicBoolean(true);
  try{
   pair=PairingState.claim(reader.readLine());writer.println("{\"action\":\"background-prepare\"}");JSONObject packet=new JSONObject(reader.readLine());JSONArray jobs=packet.getJSONArray("jobs");assertEquals(2,jobs.length());String id=packet.getString("opId");
   String first;
   try(TransferLedger ledger=new TransferLedger(context,BackgroundTransferWorker.DATABASE)){
    for(int i=0;i<jobs.length();i++){JSONObject job=jobs.getJSONObject(i);ledger.stage(job.getString("body"),job.getString("uploadId"),job.getString("metadata"),job.getJSONArray("requiredFlags").toString(),job.getString("revision"),java.util.Base64.getDecoder().decode(job.getString("bytes")));}
    assertTrue(ledger.activate(id,packet.getString("revision")));first=ledger.images(id).getJSONObject(0).getString("uploadId");
   }
   LongSupplier clock=()->{if(!cut.get())return 0;try(TransferLedger l=new TransferLedger(context,BackgroundTransferWorker.DATABASE)){return l.uploadResult(first)!=null?10:0;}catch(Exception e){throw new RuntimeException(e);}};
   WorkerFactory factory=new WorkerFactory(){@Override public ListenableWorker createWorker(Context c,String name,WorkerParameters p){assertEquals(BackgroundTransferWorker.class.getName(),name);return new BackgroundTransferWorker(c,p,clock,10L);}};
   WorkManagerTestInitHelper.initializeTestWorkManager(context,new Configuration.Builder().setExecutor(new SynchronousExecutor()).setWorkerFactory(factory).build());WorkManager manager=WorkManager.getInstance(context);TestDriver driver=WorkManagerTestInitHelper.getTestDriver(context);
   BackgroundTransferWorker.schedule(context).get();WorkInfo work=manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get().get(0);driver.setAllConstraintsMet(work.getId());
   writer.println("{\"action\":\"background-counters\"}");JSONArray writes=new JSONObject(reader.readLine()).getJSONArray("nativeUploads");assertEquals("Deadline after persisted first upload must prevent second PUT",1,writes.length());assertEquals(first,writes.getJSONObject(0).getString("uploadId"));
   work=manager.getWorkInfoById(work.getId()).get();assertEquals(WorkInfo.State.ENQUEUED,work.getState());assertEquals(1,work.getRunAttemptCount());
   try(TransferLedger cold=new TransferLedger(context,BackgroundTransferWorker.DATABASE)){
    JSONObject job=cold.jobs().getJSONObject(0);assertEquals("active",job.getString("phase"));assertTrue(AppliedReceipt.valid(new JSONObject(job.getString("replay")),id));assertNotNull(cold.uploadResult(first));
    assertEquals(0,android.database.DatabaseUtils.longForQuery(cold.getReadableDatabase(),"SELECT COUNT(*) FROM background_jobs WHERE owner IS NOT NULL OR expires != 0",null));
    assertEquals(2,cold.images(id).length());assertNull(cold.uploadResult(cold.images(id).getJSONObject(1).getString("uploadId")));
    for(int i=0;i<2;i++){JSONObject original=jobs.getJSONObject(i);String upload=original.getString("uploadId");assertArrayEquals(java.util.Base64.getDecoder().decode(original.getString("bytes")),cold.mediaBytes(upload));JSONObject metadata=new JSONObject(original.getString("metadata"));assertEquals(metadata.getString("sha256"),TransferLedger.sha256(cold.mediaBytes(upload)));}
    assertEquals(packet.getString("body"),new String(cold.operationBody(id),StandardCharsets.UTF_8));
   }
   cut.set(false);driver.setInitialDelayMet(work.getId());driver.setAllConstraintsMet(work.getId());assertEquals(2,manager.getWorkInfoById(work.getId()).get().getRunAttemptCount());
   driver.setInitialDelayMet(work.getId());driver.setAllConstraintsMet(work.getId());assertEquals(WorkInfo.State.SUCCEEDED,manager.getWorkInfoById(work.getId()).get().getState());
   try(TransferLedger cold=new TransferLedger(context,BackgroundTransferWorker.DATABASE)){assertEquals("completed",cold.jobs().getJSONObject(0).getString("phase"));assertEquals(2,cold.images(id).length());assertNotNull(cold.operationBody(id));}
   writer.println("{\"action\":\"background-foreground\"}");JSONObject result=new JSONObject(reader.readLine());assertTrue(result.toString(),result.getBoolean("originalUnchanged"));assertTrue(result.getBoolean("originalBodyRetry"));assertEquals(1,result.getInt("beforeOperations"));assertEquals(2,result.getInt("beforeMedia"));assertEquals(0,result.getInt("afterOperations"));assertEquals(0,result.getInt("afterMedia"));assertEquals(1,result.getInt("ackCount"));assertTrue(result.isNull("pendingAck"));assertEquals(1,result.getInt("entryCount"));assertEquals(1,result.getInt("previewCount"));assertEquals(2,result.getInt("mediaReceiptCount"));
   JSONArray trace=result.getJSONArray("nativeUploads");assertEquals(3,trace.length());assertEquals(first,trace.getJSONObject(0).getString("uploadId"));assertEquals(trace.getJSONObject(1).toString(),trace.getJSONObject(2).toString());JSONObject remaining=jobs.getJSONObject(0).getString("uploadId").equals(first)?jobs.getJSONObject(1):jobs.getJSONObject(0);assertEquals(remaining.getString("uploadId"),trace.getJSONObject(1).getString("uploadId"));assertEquals(new JSONObject(remaining.getString("metadata")).toString(),trace.getJSONObject(1).getJSONObject("metadata").toString());assertEquals(new JSONObject(remaining.getString("metadata")).getString("sha256"),trace.getJSONObject(1).getString("hash"));
   JSONArray replay=result.getJSONArray("nativeReplayBodies");assertEquals(3,replay.length());for(int i=0;i<replay.length();i++)assertEquals(packet.getString("body"),replay.getString(i));
   try(TransferLedger cold=new TransferLedger(context,BackgroundTransferWorker.DATABASE)){cold.pause(null);cold.pruneCancelled(new JSONArray(),new JSONArray());assertEquals(0,cold.jobs().length());for(int i=0;i<2;i++)assertNull(cold.mediaBytes(jobs.getJSONObject(i).getString("uploadId")));}
  }finally{context.deleteDatabase(BackgroundTransferWorker.DATABASE);writer.println("{\"action\":\"close\"}");if(!child.waitFor(15,java.util.concurrent.TimeUnit.SECONDS))child.destroyForcibly();pair=null;}
 }
 static PairingState pair;
 @Implements(PairingVault.class) public static class VaultShadow {@Implementation public PairingState load(){return pair;}}
 @Test public void finiteBudgetPersistsFirstCommitThenColdWorkManagerRetryAndTypedAck()throws Exception{
  String repo=System.getenv("T3_TEST_REPO");assertNotNull(repo);
  ProcessBuilder builder=new ProcessBuilder("node",java.nio.file.Path.of(repo,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repo,"apps/server/tests/fixtures/secure-pairing-native.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT);
  builder.environment().put("T3_BACKGROUND_STANDALONE","1");Process child=builder.start();
  java.io.BufferedReader reader=new java.io.BufferedReader(new java.io.InputStreamReader(child.getInputStream(),StandardCharsets.UTF_8));java.io.PrintWriter writer=new java.io.PrintWriter(child.getOutputStream(),true,StandardCharsets.UTF_8);
  Context context=RuntimeEnvironment.getApplication();context.deleteDatabase(BackgroundTransferWorker.DATABASE);
  java.util.concurrent.atomic.AtomicBoolean cut=new java.util.concurrent.atomic.AtomicBoolean(true);
  try{
   pair=PairingState.claim(reader.readLine());writer.println("{\"action\":\"background-prepare\"}");JSONArray jobs=new JSONObject(reader.readLine()).getJSONArray("jobs");assertEquals(3,jobs.length());
   try(TransferLedger ledger=new TransferLedger(context,BackgroundTransferWorker.DATABASE)){
    for(int i=0;i<jobs.length();i++){JSONObject job=jobs.getJSONObject(i);ledger.stageStandaloneMedia(job.getString("clientId"),job.getString("uploadId"),job.getString("metadata"),job.getJSONArray("requiredFlags").toString(),job.getString("revision"),java.util.Base64.getDecoder().decode(job.getString("bytes")));assertTrue(ledger.activateStandaloneMedia(job.getString("uploadId"),job.getString("revision")));}
   }
   LongSupplier clock=()->{if(!cut.get())return 0;try(TransferLedger l=new TransferLedger(context,BackgroundTransferWorker.DATABASE)){return "completed".equals(l.standaloneMedia().getJSONObject(0).getString("phase"))?10:0;}catch(Exception e){throw new RuntimeException(e);}};
   WorkerFactory factory=new WorkerFactory(){@Override public ListenableWorker createWorker(Context c,String name,WorkerParameters p){
    assertEquals(BackgroundTransferWorker.class.getName(),name);
    return new BackgroundTransferWorker(c,p,clock,10L);
   }};
   WorkManagerTestInitHelper.initializeTestWorkManager(context,new Configuration.Builder().setExecutor(new SynchronousExecutor()).setWorkerFactory(factory).build());WorkManager manager=WorkManager.getInstance(context);TestDriver driver=WorkManagerTestInitHelper.getTestDriver(context);
   BackgroundTransferWorker.schedule(context).get();WorkInfo work=manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get().get(0);driver.setAllConstraintsMet(work.getId());
   work=manager.getWorkInfoById(work.getId()).get();assertEquals(WorkInfo.State.ENQUEUED,work.getState());assertEquals(1,work.getRunAttemptCount());
   writer.println("{\"action\":\"background-counters\"}");assertEquals("Budget must stop before second original write",1,new JSONObject(reader.readLine()).getJSONArray("nativeUploads").length());
   try(TransferLedger cold=new TransferLedger(context,BackgroundTransferWorker.DATABASE)){
    assertEquals("completed",cold.standaloneMedia().getJSONObject(0).getString("phase"));
    for(int i=1;i<3;i++){assertEquals("active",cold.standaloneMedia().getJSONObject(i).getString("phase"));assertTrue(cold.standaloneMedia().getJSONObject(i).isNull("result"));}
    for(int i=0;i<3;i++)assertArrayEquals(java.util.Base64.getDecoder().decode(jobs.getJSONObject(i).getString("bytes")),cold.standaloneBytes(jobs.getJSONObject(i).getString("uploadId")));
   }
   cut.set(false);driver.setInitialDelayMet(work.getId());driver.setAllConstraintsMet(work.getId());
   assertEquals(2,manager.getWorkInfoById(work.getId()).get().getRunAttemptCount()); // actual committed second response is truncated by fixture
   driver.setInitialDelayMet(work.getId());driver.setAllConstraintsMet(work.getId());assertEquals(WorkInfo.State.SUCCEEDED,manager.getWorkInfoById(work.getId()).get().getState());assertEquals(1,manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get().size());
   try(TransferLedger cold=new TransferLedger(context,BackgroundTransferWorker.DATABASE)){for(int i=0;i<3;i++)assertEquals("completed",cold.standaloneMedia().getJSONObject(i).getString("phase"));}
   writer.println("{\"action\":\"background-foreground\"}");JSONObject result=new JSONObject(reader.readLine());assertTrue(result.toString(),result.getBoolean("originalUnchanged"));assertTrue(result.getBoolean("originalBodyRetry"));assertEquals(0,result.getInt("afterMedia"));assertEquals(1,result.getInt("ackCount"));assertEquals(3,result.getInt("mediaReceiptCount"));assertEquals(0,result.getInt("replayCount"));
   JSONArray trace=result.getJSONArray("nativeUploads");assertEquals(4,trace.length());assertEquals(trace.getJSONObject(1).toString(),trace.getJSONObject(2).toString());assertEquals(jobs.getJSONObject(0).getString("uploadId"),trace.getJSONObject(0).getString("uploadId"));
  }finally{context.deleteDatabase(BackgroundTransferWorker.DATABASE);writer.println("{\"action\":\"close\"}");if(!child.waitFor(15,java.util.concurrent.TimeUnit.SECONDS))child.destroyForcibly();pair=null;}
 }
}
