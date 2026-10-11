package com.speechless666.t3.spike;

import android.content.Context;
import androidx.work.*;
import androidx.work.testing.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

/** Defense coverage of production enqueue policy in real WorkManager's test scheduler.
 * WorkerFactory controls only execution outcomes, not the WorkManager queue or scheduler.
 * Production TLS/SQLite engine is exercised separately by BackgroundTransferJvmTest.
 */
@RunWith(RobolectricTestRunner.class) @Config(sdk=28)
public class BackgroundSchedulerJvmTest {
 private WorkManager initialize(Context context, WorkerFactory factory) {
  WorkManagerTestInitHelper.initializeTestWorkManager(context,new Configuration.Builder()
   .setExecutor(new SynchronousExecutor()).setWorkerFactory(factory).build());
  return WorkManager.getInstance(context);
 }
 @Test public void productionEnqueueWhileRunningRetainsBoundedSuccessorAndNetworkGate() throws Exception {
  Context context=RuntimeEnvironment.getApplication();AtomicInteger runs=new AtomicInteger();
  java.util.concurrent.atomic.AtomicReference<java.util.concurrent.CompletableFuture<Void>> successorAck=new java.util.concurrent.atomic.AtomicReference<>();
  WorkManager manager=initialize(context,new WorkerFactory(){
   @Override public ListenableWorker createWorker(Context c,String name,WorkerParameters p) {
    assertEquals(BackgroundTransferWorker.class.getName(),name);
    return new Worker(c,p){@Override public Result doWork(){
     if(runs.incrementAndGet()==1)successorAck.set(BackgroundTransferWorker.schedule(c));
     return Result.success();
    }};
   }
  });
  BackgroundTransferWorker.schedule(context).get();
  List<WorkInfo> jobs=manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get();
  assertEquals(1,jobs.size());assertEquals(WorkInfo.State.ENQUEUED,jobs.get(0).getState());assertEquals(0,runs.get());
  TestDriver driver=WorkManagerTestInitHelper.getTestDriver(context);assertNotNull(driver);
  driver.setAllConstraintsMet(jobs.get(0).getId());
  successorAck.get().get();
  jobs=manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get();
  assertEquals(jobs.toString(),2,jobs.size());assertEquals(1,runs.get());
  WorkInfo successor=jobs.stream().filter(j->j.getState()==WorkInfo.State.ENQUEUED).findFirst().orElseThrow();
  driver.setAllConstraintsMet(successor.getId());assertEquals(2,runs.get());
  for(WorkInfo job:manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get())assertEquals(WorkInfo.State.SUCCEEDED,job.getState());
 }
 @Test public void explicitCancelThenRepeatedResumeHasOneUniqueUnfinishedJob() throws Exception {
  Context context=RuntimeEnvironment.getApplication();AtomicInteger runs=new AtomicInteger();
  WorkManager manager=initialize(context,new WorkerFactory(){
   @Override public ListenableWorker createWorker(Context c,String name,WorkerParameters p) {
    assertEquals(BackgroundTransferWorker.class.getName(),name);
    return new Worker(c,p){@Override public Result doWork(){runs.incrementAndGet();return Result.success();}};
   }
  });
  BackgroundTransferWorker.schedule(context).get();
  WorkInfo original=manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get().get(0);
  manager.cancelUniqueWork(BackgroundTransferWorker.WORK).getResult().get();
  assertEquals(WorkInfo.State.CANCELLED,manager.getWorkInfoById(original.getId()).get().getState());
  // Execution outcomes alone are controlled; all resume enqueue decisions and queue states are real.
  for(int i=0;i<8;i++)BackgroundTransferWorker.schedule(context).get();
  List<WorkInfo> jobs=manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get();
  assertEquals("Repeated explicit resume must not append duplicate unfinished jobs",1,
    jobs.stream().filter(j->!j.getState().isFinished()).count());
  assertEquals(0,runs.get());
 }
 @Test public void transientRetryUsesSameBoundedJobAndIncrementsAttempt() throws Exception {
  Context context=RuntimeEnvironment.getApplication();AtomicInteger runs=new AtomicInteger(),attempt=new AtomicInteger(-1);
  WorkManager manager=initialize(context,new WorkerFactory(){
   @Override public ListenableWorker createWorker(Context c,String name,WorkerParameters p) {
    assertEquals(BackgroundTransferWorker.class.getName(),name);
    return new Worker(c,p){@Override public Result doWork(){attempt.set(getRunAttemptCount());return runs.incrementAndGet()==1?Result.retry():Result.success();}};
   }
  });
  BackgroundTransferWorker.schedule(context).get();TestDriver driver=WorkManagerTestInitHelper.getTestDriver(context);
  WorkInfo job=manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get().get(0);
  driver.setAllConstraintsMet(job.getId());assertEquals(1,runs.get());assertEquals(0,attempt.get());
  job=manager.getWorkInfoById(job.getId()).get();assertEquals(WorkInfo.State.ENQUEUED,job.getState());assertEquals(1,job.getRunAttemptCount());
  driver.setInitialDelayMet(job.getId());
  driver.setAllConstraintsMet(job.getId());
  assertEquals(2,runs.get());assertEquals(1,attempt.get());assertEquals(WorkInfo.State.SUCCEEDED,manager.getWorkInfoById(job.getId()).get().getState());
  assertEquals(1,manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get().size());
 }
 @Test public void concurrentResumeWhileActuallyRunningCoalescesOneBlockedSuccessor()throws Exception{
  Context context=RuntimeEnvironment.getApplication();AtomicInteger runs=new AtomicInteger();
  java.util.concurrent.atomic.AtomicReference<androidx.work.impl.utils.futures.SettableFuture<ListenableWorker.Result>> completion=new java.util.concurrent.atomic.AtomicReference<>();
  WorkManager manager=initialize(context,new WorkerFactory(){@Override public ListenableWorker createWorker(Context c,String name,WorkerParameters p){return new ListenableWorker(c,p){@Override public com.google.common.util.concurrent.ListenableFuture<Result> startWork(){androidx.work.impl.utils.futures.SettableFuture<Result> done=androidx.work.impl.utils.futures.SettableFuture.create();if(runs.incrementAndGet()==1)completion.set(done);else done.set(Result.success());return done;}};}});
  BackgroundTransferWorker.schedule(context).get();WorkInfo first=manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get().get(0);TestDriver driver=WorkManagerTestInitHelper.getTestDriver(context);driver.setAllConstraintsMet(first.getId());assertEquals(WorkInfo.State.RUNNING,manager.getWorkInfoById(first.getId()).get().getState());
  java.util.concurrent.ExecutorService callers=java.util.concurrent.Executors.newFixedThreadPool(4);
  try{java.util.List<java.util.concurrent.Future<?>> acknowledgments=new java.util.ArrayList<>();for(int i=0;i<8;i++)acknowledgments.add(callers.submit(()->{try{BackgroundTransferWorker.schedule(context).get();}catch(Exception e){throw new RuntimeException(e);}}));for(java.util.concurrent.Future<?> ack:acknowledgments)ack.get(10,java.util.concurrent.TimeUnit.SECONDS);}finally{callers.shutdownNow();}
  java.util.List<WorkInfo> jobs=manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get();assertEquals(2,jobs.size());assertEquals(1,jobs.stream().filter(j->j.getState()==WorkInfo.State.RUNNING).count());assertEquals(1,jobs.stream().filter(j->j.getState()==WorkInfo.State.BLOCKED).count());
  completion.get().set(ListenableWorker.Result.success());WorkInfo next=manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get().stream().filter(j->j.getState()==WorkInfo.State.ENQUEUED).findFirst().orElseThrow();driver.setAllConstraintsMet(next.getId());assertEquals(2,runs.get());for(WorkInfo job:manager.getWorkInfosForUniqueWork(BackgroundTransferWorker.WORK).get())assertEquals(WorkInfo.State.SUCCEEDED,job.getState());
 }
}
