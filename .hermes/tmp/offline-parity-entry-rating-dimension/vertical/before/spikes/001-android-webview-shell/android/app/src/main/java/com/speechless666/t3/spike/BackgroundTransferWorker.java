package com.speechless666.t3.spike;
import android.content.Context;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import androidx.work.WorkManager;
import androidx.work.OneTimeWorkRequest;
import androidx.work.Constraints;
import androidx.work.NetworkType;
import androidx.work.ExistingWorkPolicy;
import androidx.work.BackoffPolicy;
import org.json.JSONObject;
import org.json.JSONArray;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
/** Finite OS job, app-private SQLite only. Never asks a background WebView for data. */
public final class BackgroundTransferWorker extends Worker {
 public static final String DATABASE="native-transfers.db", WORK="t3-entry-original-transfers";
 private final java.util.function.LongSupplier clock;
 private final long budget;
 public BackgroundTransferWorker(Context context,WorkerParameters parameters){this(context,parameters,android.os.SystemClock::elapsedRealtime,480000);}
 BackgroundTransferWorker(Context context,WorkerParameters parameters,java.util.function.LongSupplier clock,long budget){super(context,parameters);if(budget<=0)throw new IllegalArgumentException("Finite positive budget required");this.clock=clock;this.budget=budget;}
 // One process-wide asynchronous scheduling lane; query only after prior enqueue is acknowledged.
 // A RUNNING worker needs one successor (KEEP alone loses its in-flight handoff).
 private static final Object scheduleLock=new Object();
 private static final class Schedule {
   final Context context;final java.util.concurrent.CompletableFuture<Void> done=new java.util.concurrent.CompletableFuture<>();
   Schedule(Context context){this.context=context;}
 }
 private static Schedule pendingSchedule;
 private static boolean scheduling;
 public static java.util.concurrent.CompletableFuture<Void> schedule(Context context){
   Schedule request;boolean start;
   synchronized(scheduleLock){if(pendingSchedule==null)pendingSchedule=new Schedule(context.getApplicationContext());request=pendingSchedule;start=!scheduling;scheduling=true;}
   if(start)scheduleNext();return request.done;
 }
 private static void scheduleNext(){
   Schedule request;
   synchronized(scheduleLock){request=pendingSchedule;pendingSchedule=null;if(request==null){scheduling=false;return;}}
   WorkManager manager=WorkManager.getInstance(request.context);
   com.google.common.util.concurrent.ListenableFuture<java.util.List<androidx.work.WorkInfo>> query=manager.getWorkInfosForUniqueWork(WORK);
   query.addListener(()->{
     try {
       // Listener runs only after completion: get() never blocks the caller/UI thread.
       boolean pending=false;
       for(androidx.work.WorkInfo job:query.get()){
         pending|=job.getState()==androidx.work.WorkInfo.State.ENQUEUED || job.getState()==androidx.work.WorkInfo.State.BLOCKED;
       }
       if(pending){request.done.complete(null);scheduleNext();return;}
       androidx.work.Operation enqueue=manager.enqueueUniqueWork(WORK,ExistingWorkPolicy.APPEND_OR_REPLACE,
         new OneTimeWorkRequest.Builder(BackgroundTransferWorker.class).setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).setBackoffCriteria(BackoffPolicy.EXPONENTIAL,30,TimeUnit.SECONDS).build());
       enqueue.getResult().addListener(()->{try{enqueue.getResult().get();request.done.complete(null);}catch(Exception failure){request.done.completeExceptionally(failure);}finally{scheduleNext();}},Runnable::run);
     }catch(Exception failure){request.done.completeExceptionally(failure);scheduleNext();}
   },Runnable::run);
 }

 @Override public Result doWork(){
   try(TransferLedger ledger=new TransferLedger(getApplicationContext(),DATABASE)) {
     PairingState state=new PairingVault(getApplicationContext()).load();
     if(state==null)return Result.failure();
     return execute(ledger,state,()->isStopped() || !currentAuthority(state),clock,budget)?Result.success():Result.retry();
   }catch(SecurityException | javax.net.ssl.SSLException rejected){return Result.failure();}
   catch(Exception unavailable){return Result.retry();}
 }
 private boolean currentAuthority(PairingState expected) {
   try { PairingState latest=new PairingVault(getApplicationContext()).load();return latest!=null
     && latest.libraryId.equals(expected.libraryId) && latest.deviceId.equals(expected.deviceId)
     && latest.token.equals(expected.token) && latest.transport.endpoint.equals(expected.transport.endpoint) && latest.transport.pin.equals(expected.transport.pin);
   } catch(Exception invalid){return false;}
 }
 interface Stop {boolean stopped();}
 static JSONObject json(PinnedLanTransport.Result response) throws Exception {
   if(response.status<200 || response.status>=300) throw new SecurityException("Server authorization or mutation rejected: "+response.status);
   return new JSONObject(new String(response.bytes,StandardCharsets.UTF_8));
 }
 static void scope(PairingState state,JSONObject op,JSONArray flags) throws Exception {
   JSONObject caps=json(state.transport.request("/api/sync/capabilities","GET",null,null,state.token));
   if(!state.libraryId.equals(op.getString("libraryId")) || !state.libraryId.equals(caps.getString("libraryId")) || !op.getString("syncEpoch").equals(caps.getString("syncEpoch")))throw new SecurityException("Library/epoch changed; canonical work retained");
   JSONObject features=caps.getJSONObject("featureFlags");
   // A sealed partition origin denotes a new type; legacy absent originals remain unchanged.
   if("entry.create".equals(op.optString("operationKind")) && op.getJSONObject("payload").has("partitionScopeUid") && !features.optBoolean("offlineEntryNewType",false))throw new SecurityException("New Gallery capability unavailable; original retained");
   for(int i=0;i<flags.length();i++)if(!features.optBoolean(flags.getString(i),false))throw new SecurityException("Required capability unavailable");
 }
 /** Same core used by production Worker and actual TLS/SQLite tracer. Raw results never authorize IDB cleanup. */
 static boolean execute(TransferLedger ledger,PairingState state,Stop stop) throws Exception {
   return execute(ledger,state,stop,android.os.SystemClock::elapsedRealtime,480000);
 }
 static boolean execute(TransferLedger ledger,PairingState state,Stop stop,java.util.function.LongSupplier clock,long budget) throws Exception {
   if(budget<=0)throw new IllegalArgumentException("Finite positive budget required");
   long started=clock.getAsLong(); JSONArray jobs=ledger.jobs();boolean unfinished=false;
   for(int i=0;i<jobs.length();i++) {
     if(stop.stopped() || clock.getAsLong()-started>=budget)return false;
     JSONObject job=jobs.getJSONObject(i);if(!"active".equals(job.getString("phase")))continue;
     String id=job.getString("opId"),owner=UUID.randomUUID().toString();byte[] body=ledger.operationBody(id);
     // Foreground owns settlement across queues. A retained upload (even a
     // completed uncertain receipt) is not authority to delete its owner.
     JSONObject staged=new JSONObject(new String(body,StandardCharsets.UTF_8));
     if("entry.delete".equals(staged.optString("operationKind"))) {
       boolean retained=false;JSONArray mediaRows=ledger.standaloneMedia();
       for(int n=0;n<mediaRows.length();n++)if(staged.optString("entityUid").equalsIgnoreCase(mediaRows.getJSONObject(n).getJSONObject("metadata").optString("entryUid")))retained=true;
       if(retained)continue;
     }
     if(!ledger.dependenciesApplied(id))continue;
     if(!ledger.claimJob(id,owner,System.currentTimeMillis()))continue;
     byte[] replay=null,media=null;
     try {
       JSONObject op=new JSONObject(new String(body,StandardCharsets.UTF_8));
       NativeMutationPlan.validate(op,ledger.plan(id));
       scope(state,op,NativeMutationPlan.flags(op));
       scope(state,op,job.getJSONArray("flags"));
       JSONArray requiredImages=ledger.images(id);
       for(int n=0;n<requiredImages.length();n++){scope(state,op,requiredImages.getJSONObject(n).getJSONArray("flags"));if(!ledger.renewJob(id,owner,System.currentTimeMillis()))throw new java.io.IOException("Preflight lease lost");}
       if(stop.stopped() || !ledger.renewJob(id,owner,System.currentTimeMillis()))throw new java.io.IOException("Stopped or lease lost before write");
       PinnedLanTransport.Result response=state.transport.request("/api/sync/replay","POST","application/json",body,state.token);replay=response.bytes;
       JSONObject receipt=json(response);
       if(!AppliedReceipt.valid(receipt,op))throw new SecurityException("Mutation failed/conflicted; successors held");
       if(job.isNull("uploadId")) {
         if(stop.stopped() || !ledger.finishJob(id,owner,body,"completed",replay,null,null,System.currentTimeMillis()))throw new java.io.IOException("Lease lost; exact retry required");
         continue;
       }
       if(!"entry.create".equals(op.getString("operationKind")) || !"entry".equals(op.getString("entityKind")) || receipt.getInt("entityId")<=0)throw new SecurityException("Media owner is not typed Entry create");
       JSONObject snapshot=json(state.transport.request("/api/sync/snapshot?media=none","GET",null,null,state.token));
       JSONObject header=snapshot.getJSONObject("header");
       if(!op.getString("libraryId").equals(header.getString("libraryId")) || !op.getString("syncEpoch").equals(header.getString("syncEpoch")))throw new SecurityException("Snapshot scope changed");
       JSONArray entries=snapshot.getJSONObject("payload").getJSONArray("entries");boolean found=false;
       for(int n=0;n<entries.length();n++){JSONObject entry=entries.getJSONObject(n);if(entry.getInt("id")==receipt.getInt("entityId") && op.getString("entityUid").equalsIgnoreCase(entry.optString("syncUid")))found=true;}
       if(!found)throw new SecurityException("Create receipt Entry UID not covered");
       JSONArray images=ledger.images(id);
       for(int imageIndex=0;imageIndex<images.length();imageIndex++) {
       JSONObject image=images.getJSONObject(imageIndex);
       if(ledger.uploadResult(image.getString("uploadId"))!=null)continue;
       scope(state,op,image.getJSONArray("flags"));
       if(stop.stopped() || !ledger.renewJob(id,owner,System.currentTimeMillis()))throw new java.io.IOException("Stopped or lease lost before media");
       JSONObject metadata=image.getJSONObject("metadata");String upload=image.getString("uploadId");
       byte[] bytes=ledger.mediaBytes(upload);
       if(!TransferLedger.sha256(bytes).equals(metadata.getString("sha256")))throw new SecurityException("Original media hash changed");
       String boundary="t3-"+upload;
       java.io.ByteArrayOutputStream multipart=new java.io.ByteArrayOutputStream();
       multipart.write(("--"+boundary+"\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n"+metadata+"\r\n--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"original\"\r\nContent-Type: "+metadata.getString("mimeType")+"\r\n\r\n").getBytes(StandardCharsets.UTF_8));
       multipart.write(bytes); multipart.write(("\r\n--"+boundary+"--\r\n").getBytes(StandardCharsets.UTF_8));
       if(clock.getAsLong()-started>=budget)throw new java.io.IOException("Finite media budget exhausted; exact original retry required");
       PinnedLanTransport.Result uploaded=state.transport.request("/api/sync/media/"+upload,"PUT","multipart/form-data; boundary="+boundary,multipart.toByteArray(),state.token); media=uploaded.bytes;
       if(stop.stopped())throw new java.io.IOException("Interrupted after committed multipart; retry original UUID");
       JSONObject result=json(uploaded);
       if(!upload.equalsIgnoreCase(result.getString("uploadId")) || !"applied".equals(result.getString("status")) || result.getInt("entityId")!=receipt.getInt("entityId"))throw new SecurityException("Upload receipt mismatch");
       if(!ledger.recordUpload(upload,id,owner,media,System.currentTimeMillis()))throw new java.io.IOException("Upload lease lost");
       }
       if(!ledger.finishJob(id,owner,body,"completed",replay,media,null,System.currentTimeMillis()))throw new java.io.IOException("Lease lost; exact retry required");
     }catch(SecurityException | javax.net.ssl.SSLException held) {
       ledger.finishJob(id,owner,body,"held",replay,media,held.getMessage(),System.currentTimeMillis());
     }catch(Exception retry) {
       ledger.finishJob(id,owner,body,"active",replay,media,"Interrupted; exact original retry required",System.currentTimeMillis());unfinished=true;
     }
   }return executeStandalone(ledger,state,stop,clock,started,budget) && !unfinished;
 }
 static boolean executeStandalone(TransferLedger ledger,PairingState state,Stop stop,java.util.function.LongSupplier clock,long started,long budget) throws Exception {
   JSONArray rows=ledger.standaloneMedia();java.util.Set<String> blocked=new java.util.HashSet<>();boolean unfinished=false;
   java.util.List<JSONObject> ordered=new java.util.ArrayList<>();for(int i=0;i<rows.length();i++)ordered.add(rows.getJSONObject(i));
   ordered.sort((a,b)->{JSONObject x=a.optJSONObject("metadata"),y=b.optJSONObject("metadata");int owner=x.optString("entryUid").compareTo(y.optString("entryUid"));if(owner!=0)return owner;int kind=Boolean.compare(!"cover".equals(x.optString("kind")),!"cover".equals(y.optString("kind")));return kind!=0?kind:Integer.compare(x.optInt("ordinal"),y.optInt("ordinal"));});
   for(JSONObject job:ordered) {
     JSONObject metadata=job.getJSONObject("metadata");String uid=metadata.getString("entryUid"),id=job.getString("uploadId"),phase=job.getString("phase");
     if("completed".equals(phase))continue;
     if(!"active".equals(phase) || blocked.contains(uid)){blocked.add(uid);continue;}
     if(stop.stopped() || clock.getAsLong()-started>=budget)return false;
     String owner=UUID.randomUUID().toString();if(!ledger.claimStandalone(id,owner,System.currentTimeMillis())){blocked.add(uid);unfinished=true;continue;}
     byte[] result=null;
     try {
       scope(state,metadata,job.getJSONArray("flags"));
       JSONObject snapshot=json(state.transport.request("/api/sync/snapshot?media=none","GET",null,null,state.token));
       JSONObject header=snapshot.getJSONObject("header");
       if(!metadata.getString("libraryId").equals(header.getString("libraryId")) || !metadata.getString("syncEpoch").equals(header.getString("syncEpoch")))throw new SecurityException("Snapshot scope changed");
       int entityId=0;JSONObject target=null;JSONArray entries=snapshot.getJSONObject("payload").getJSONArray("entries");
       for(int n=0;n<entries.length();n++){JSONObject entry=entries.getJSONObject(n);if(uid.equalsIgnoreCase(entry.optString("syncUid"))){if(entityId!=0)throw new SecurityException("Ambiguous Entry UID");entityId=entry.getInt("id");target=entry;}}
       if(entityId<=0)throw new SecurityException("Existing Entry UID unavailable");
       JSONObject expected=metadata.getJSONObject("existingEntry");
       if(!expected.isNull("expectedCoverRef") && !expected.getString("expectedCoverRef").equals(target.optString("coverRef")))throw new SecurityException("Cover predecessor not committed; original chain retained");
       JSONArray prior=expected.getJSONArray("expectedPreviewRefs"),current=target.getJSONArray("previewRefs");
       for(int n=0;n<prior.length();n++)if(n>=current.length() || !prior.getString(n).equals(current.getString(n)))throw new SecurityException("Preview predecessor not committed; original chain retained");
       byte[] bytes=ledger.standaloneBytes(id);
       if(bytes==null || bytes.length!=metadata.getInt("byteLength") || !TransferLedger.sha256(bytes).equals(metadata.getString("sha256")))throw new SecurityException("Original media changed");
       if(stop.stopped() || !ledger.renewStandalone(id,owner,System.currentTimeMillis()))throw new java.io.IOException("Stopped or lease lost before original upload");
       String boundary="t3-"+id;java.io.ByteArrayOutputStream multipart=new java.io.ByteArrayOutputStream();
       multipart.write(("--"+boundary+"\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n"+metadata+"\r\n--"+boundary+"\r\nContent-Disposition: form-data; name=\"file\"; filename=\"original\"\r\nContent-Type: "+metadata.getString("mimeType")+"\r\n\r\n").getBytes(StandardCharsets.UTF_8));
       multipart.write(bytes);multipart.write(("\r\n--"+boundary+"--\r\n").getBytes(StandardCharsets.UTF_8));
       PinnedLanTransport.Result uploaded=state.transport.request("/api/sync/media/"+id,"PUT","multipart/form-data; boundary="+boundary,multipart.toByteArray(),state.token);result=uploaded.bytes;
       if(stop.stopped())throw new java.io.IOException("Interrupted after committed original; exact UUID retry");
       JSONObject receipt=json(uploaded);
       if(!id.equalsIgnoreCase(receipt.getString("uploadId")) || !"applied".equals(receipt.getString("status")) || entityId!=receipt.getInt("entityId"))throw new SecurityException("Existing Entry upload receipt mismatch");
       if(!ledger.finishStandalone(id,owner,job.getString("originalMetadata"),"completed",result,null,System.currentTimeMillis()))throw new java.io.IOException("Completion lease lost");
     }catch(SecurityException | javax.net.ssl.SSLException held) {
       ledger.finishStandalone(id,owner,job.getString("originalMetadata"),"held",result,held.getMessage(),System.currentTimeMillis());blocked.add(uid);
     }catch(Exception retry) {
       ledger.finishStandalone(id,owner,job.getString("originalMetadata"),"active",result,"Interrupted; exact original retry required",System.currentTimeMillis());blocked.add(uid);unfinished=true;
     }
   }return !unfinished;
 }
}
