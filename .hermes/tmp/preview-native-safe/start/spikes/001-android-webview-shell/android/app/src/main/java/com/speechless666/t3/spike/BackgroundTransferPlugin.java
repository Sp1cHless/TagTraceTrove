package com.speechless666.t3.spike;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.JSObject;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import org.json.JSONArray;
import android.util.Base64;
import java.io.File;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
@CapacitorPlugin(name="T3BackgroundTransfer")
public final class BackgroundTransferPlugin extends Plugin {
 private final ExecutorService executor=Executors.newSingleThreadExecutor();
 interface Action { JSObject run() throws Exception; }
 private void action(PluginCall call,Action action) {
   // The bridge's app URL is a plain field readable from any thread; reading
   // WebView state here would be a fatal wrong-thread crash. The bundled SPA
   // never navigates inside this WebView, so the app URL is the document.
   String document=getBridge().getAppUrl();
   if(document==null || !(document.equals("https://localhost") || document.startsWith("https://localhost/"))){call.reject("Untrusted document");return;}
   executor.execute(()->{try{call.resolve(action.run());}catch(Exception e){call.reject("Native transfer paused; original offline work retained", "TRANSFER_PAUSED");}});
 }
 private static byte[] read(File file) throws Exception {
   try(java.io.FileInputStream in=new java.io.FileInputStream(file);java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream()){
     byte[] buffer=new byte[8192];int count;
     while((count=in.read(buffer))!=-1){if(out.size()+count>21*1024*1024)throw new SecurityException("Staging bound exceeded");out.write(buffer,0,count);}return out.toByteArray();
   }
 }
 private static void write(File file,byte[] bytes) throws Exception {
   try(java.io.FileOutputStream out=new java.io.FileOutputStream(file)){out.write(bytes);out.getFD().sync();}
 }
 private File directory(){File dir=new File(getContext().getFilesDir(),"transfer-staging");dir.mkdirs();return dir;}
 private String newStage() throws Exception {
   File[] captures=directory().listFiles();int count=0;if(captures!=null)for(File f:captures){if(System.currentTimeMillis()-f.lastModified()>86400000L)f.delete();else if(f.getName().endsWith(".json"))count++;}
   if(count>=64)throw new SecurityException("Too many unsealed captures; use foreground Update");return java.util.UUID.randomUUID().toString();
 }
 private File file(String stage,String suffix){if(stage==null || !stage.matches("[a-f0-9-]{36}"))throw new SecurityException("Invalid stage");return new File(directory(),stage+suffix);}
 @PluginMethod public void status(PluginCall call){action(call,()->{
   JSObject result=new JSObject();result.put("protocolVersion",1);result.put("planVersion",1);
   JSONArray kinds=new JSONArray();java.util.Iterator<String> keys=new JSONObject(NativeMutationContract.JSON).keys();while(keys.hasNext())kinds.put(keys.next());result.put("operationKinds",kinds);return result;
 });}
 @PluginMethod public void preflight(PluginCall call){action(call,()->{
   PairingState pair=new PairingVault(getContext()).load();if(pair==null)throw new SecurityException("Pairing required");
   JSONObject caps=BackgroundTransferWorker.json(pair.transport.request("/api/sync/capabilities","GET",null,null,pair.token));
   if(!pair.libraryId.equals(caps.getString("libraryId")))throw new SecurityException("Pairing scope changed");return JSObject.fromJSONObject(caps);
 });}
 @PluginMethod public void resumeOperations(PluginCall call){action(call,()->{
   PairingState pair=new PairingVault(getContext()).load();if(pair==null)throw new SecurityException("Pairing required");
   JSONArray rows=call.getArray("operations");boolean activated=false;int held=0;
   try(TransferLedger ledger=new TransferLedger(getContext(),BackgroundTransferWorker.DATABASE)) {
     for(int n=0;n<rows.length();n++) {
       JSONObject row=rows.getJSONObject(n),op=new JSONObject(row.getString("body"));
       try{BackgroundTransferWorker.scope(pair,op,NativeMutationPlan.flags(op));
         JSONArray images=ledger.images(op.getString("opId"));for(int i=0;i<images.length();i++)BackgroundTransferWorker.scope(pair,op,images.getJSONObject(i).getJSONArray("flags"));
         activated=ledger.resumeOperation(row.getString("body"),row.getString("revision"),row.getJSONObject("plan").toString()) || activated;
       }catch(SecurityException rejected){held++;}
     }
   }
   if(activated)BackgroundTransferWorker.schedule(getContext());JSObject result=new JSObject();result.put("capabilityHeld",held);if(held>0)result.put("reason","Current pairing, scope or required capability unavailable; original work retained");return result;
 });}
 @PluginMethod public void stage(PluginCall call){action(call,()->{
   PairingState pair=new PairingVault(getContext()).load();if(pair==null)throw new SecurityException("Pairing required");
   JSONObject op=new JSONObject(call.getString("body"));JSONObject metadata=new JSONObject(call.getString("metadata"));
   if(!pair.libraryId.equals(op.getString("libraryId")) || !"entry.create".equals(op.getString("operationKind")))throw new SecurityException("Foreign/unsupported original");
   int length=metadata.getInt("byteLength");if(length<=0 || length>20*1024*1024)throw new SecurityException("Media too large");
   JSONArray flags=new JSONArray();flags.put("offlineMutations").put("offlineEntryCreate").put("offlineMediaUpload");
   JSONObject payload=op.getJSONObject("payload");if(payload.has("contents"))flags.put("offlineEntryInitialContents");
   JSONArray ratings=payload.optJSONArray("ratings");if(ratings!=null)for(int i=0;i<ratings.length();i++)if(ratings.getJSONObject(i).has("slotUid")){flags.put("offlineRatingSlotLayout");break;}
   if(metadata.getInt("ordinal")>0)flags.put("offlineMediaMultiplePreviews");
   String stage=newStage();
   JSONObject capture=new JSONObject().put("body",call.getString("body")).put("uploadId",call.getString("uploadId")).put("metadata",call.getString("metadata")).put("flags",flags.toString()).put("revision",call.getString("revision"));
   if(call.getObject("plan")!=null)capture.put("plan",call.getObject("plan"));
   try(TransferLedger ledger=new TransferLedger(getContext(),BackgroundTransferWorker.DATABASE)){ledger.requireLiveCapture(op.getString("opId"),call.getString("uploadId"));}
   write(file(stage,".json"),capture.toString().getBytes(StandardCharsets.UTF_8));write(file(stage,".part"),new byte[0]);
   JSObject result=new JSObject();result.put("stageId",stage);return result;
 });}
 @PluginMethod public void stageStandaloneMedia(PluginCall call){action(call,()->{
   PairingState pair=new PairingVault(getContext()).load();if(pair==null)throw new SecurityException("Pairing required");
   JSONObject metadata=new JSONObject(call.getString("metadata"));
   if(!pair.libraryId.equals(metadata.getString("libraryId")) || !metadata.has("existingEntry"))throw new SecurityException("Foreign media");
   int length=metadata.getInt("byteLength");if(length<=0 || length>20*1024*1024)throw new SecurityException("Use foreground Update for images larger than 20 MiB");
   JSONArray flags=new JSONArray().put("offlineMediaUpload").put("existingEntryMedia");if(metadata.getInt("ordinal")>0)flags.put("offlineMediaMultiplePreviews");
   String stage=newStage();
   JSONObject capture=new JSONObject().put("clientId",call.getString("clientId")).put("uploadId",call.getString("uploadId")).put("metadata",call.getString("metadata")).put("flags",flags.toString()).put("revision",call.getString("revision"));
   try(TransferLedger ledger=new TransferLedger(getContext(),BackgroundTransferWorker.DATABASE)){ledger.requireLiveCapture(null,call.getString("uploadId"));}
   write(file(stage,".json"),capture.toString().getBytes(StandardCharsets.UTF_8));write(file(stage,".part"),new byte[0]);JSObject result=new JSObject();result.put("stageId",stage);return result;
 });}
 @PluginMethod public void activateStandaloneMedia(PluginCall call){action(call,()->{
   try(TransferLedger ledger=new TransferLedger(getContext(),BackgroundTransferWorker.DATABASE)){ledger.activateStandaloneMedia(call.getString("uploadId"),call.getString("revision"));}
   BackgroundTransferWorker.schedule(getContext());return new JSObject();
 });}
 @PluginMethod public void resumeStandaloneMedia(PluginCall call){action(call,()->{
   JSONArray rows=call.getArray("uploads");boolean activated=false;
   try(TransferLedger ledger=new TransferLedger(getContext(),BackgroundTransferWorker.DATABASE)){
     PairingState pair=new PairingVault(getContext()).load();if(pair==null)throw new SecurityException("Pairing required");
     for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i),metadata=new JSONObject(row.getString("metadata"));JSONArray flags=new JSONArray().put("offlineMediaUpload").put("existingEntryMedia");if(metadata.getInt("ordinal")>0)flags.put("offlineMediaMultiplePreviews");BackgroundTransferWorker.scope(pair,metadata,flags);activated=ledger.resumeStandaloneMedia(row.getString("uploadId"),row.getString("metadata"),row.getString("revision")) || activated;}
   }if(activated)BackgroundTransferWorker.schedule(getContext());return new JSObject();
 });}
 @PluginMethod public void pauseStandaloneMedia(PluginCall call){action(call,()->{
   try(TransferLedger ledger=new TransferLedger(getContext(),BackgroundTransferWorker.DATABASE)){ledger.pauseStandaloneMedia(call.getArray("uploadIds"));}return new JSObject();
 });}
 @PluginMethod public void stageOperation(PluginCall call){action(call,()->{
   PairingState pair=new PairingVault(getContext()).load();if(pair==null)throw new SecurityException("Pairing required");
   String body=call.getString("body");JSONObject op=new JSONObject(body);
   if(!pair.libraryId.equals(op.getString("libraryId")))throw new SecurityException("Foreign original");
   try(TransferLedger ledger=new TransferLedger(getContext(),BackgroundTransferWorker.DATABASE)){
     ledger.stagePlannedOperation(body,call.getString("revision"),call.getObject("plan").toString());
   }return new JSObject();
 });}
 @PluginMethod public void chunk(PluginCall call){action(call,()->{
   String stage=call.getString("stageId");File part=file(stage,".part");
   JSONObject capture=new JSONObject(new String(read(file(stage,".json")),StandardCharsets.UTF_8));
   try(TransferLedger ledger=new TransferLedger(getContext(),BackgroundTransferWorker.DATABASE)){ledger.requireLiveCapture(capture.has("body")?new JSONObject(capture.getString("body")).getString("opId"):null,capture.getString("uploadId"));}
   byte[] chunk=Base64.decode(call.getString("body"),Base64.NO_WRAP);if(chunk.length>262144 || part.length()!=call.getInt("offset",-1) || part.length()+chunk.length>20*1024*1024)throw new SecurityException("Chunk mismatch");
   try(java.io.FileOutputStream out=new java.io.FileOutputStream(part,true)){out.write(chunk);out.getFD().sync();}return new JSObject();
 });}
 @PluginMethod public void seal(PluginCall call){action(call,()->{
   String stage=call.getString("stageId");JSONObject capture=new JSONObject(new String(read(file(stage,".json")),StandardCharsets.UTF_8));
   try(TransferLedger ledger=new TransferLedger(getContext(),BackgroundTransferWorker.DATABASE)){
     ledger.requireLiveCapture(capture.has("body")?new JSONObject(capture.getString("body")).getString("opId"):null,capture.getString("uploadId"));
     if(capture.has("clientId"))ledger.stageStandaloneMedia(capture.getString("clientId"),capture.getString("uploadId"),capture.getString("metadata"),capture.getString("flags"),capture.getString("revision"),read(file(stage,".part")));
     else {ledger.stage(capture.getString("body"),capture.getString("uploadId"),capture.getString("metadata"),capture.getString("flags"),capture.getString("revision"),read(file(stage,".part")));if(capture.has("plan"))ledger.attachPlan(capture.getString("body"),capture.getJSONObject("plan").toString());}
   }file(stage,".part").delete();file(stage,".json").delete();return new JSObject();
 });}
 @PluginMethod public void activate(PluginCall call){action(call,()->{
   try(TransferLedger ledger=new TransferLedger(getContext(),BackgroundTransferWorker.DATABASE)){
     ledger.activate(call.getString("opId"),call.getString("revision"));
   }BackgroundTransferWorker.schedule(getContext());return new JSObject();
 });}
 @PluginMethod public void pause(PluginCall call){action(call,()->{
   try(TransferLedger ledger=new TransferLedger(getContext(),BackgroundTransferWorker.DATABASE)){
     cancelCaptures(ledger,directory(),call.getArray("opIds"),call.getArray("captureOpIds"),call.getArray("captureUploadIds"));
   }return new JSObject();
 });}
 static void cancelCaptures(TransferLedger ledger,File directory,JSONArray requested,JSONArray canonicalOps,JSONArray canonicalUploads) throws Exception {
     JSONArray capturedIds=new JSONArray(),uploads=new JSONArray();java.util.List<File> captures=new java.util.ArrayList<>();
     File[] files=directory.listFiles();if(files!=null)for(File f:files)if(f.getName().endsWith(".json")){
       JSONObject capture=new JSONObject(new String(read(f),StandardCharsets.UTF_8));String id=capture.has("body")?new JSONObject(capture.getString("body")).getString("opId"):null;
       boolean selected=requested==null;if(requested!=null)for(int n=0;n<requested.length();n++)if(requested.getString(n).equals(id))selected=true;
       if(selected){captures.add(f);if(id!=null)capturedIds.put(id);uploads.put(capture.getString("uploadId"));}
     }
     android.database.sqlite.SQLiteDatabase db=ledger.getWritableDatabase();db.beginTransaction();try {
       ledger.pause(requested);ledger.pause(capturedIds);ledger.pauseStandaloneMedia(uploads);
       if(canonicalOps!=null)ledger.pause(canonicalOps);
       if(canonicalUploads!=null)ledger.pauseStandaloneMedia(canonicalUploads);
       db.setTransactionSuccessful();
     }finally{db.endTransaction();}
     for(File f:captures){new File(directory,f.getName().substring(0,f.getName().length()-5)+".part").delete();f.delete();}
 }
 @PluginMethod public void reconcile(PluginCall call){action(call,()->{
   try(TransferLedger ledger=new TransferLedger(getContext(),BackgroundTransferWorker.DATABASE)){
     if(call.getArray("liveOpIds")!=null)ledger.pruneCancelled(call.getArray("liveOpIds"),call.getArray("liveUploadIds"));
     if(call.getArray("liveUploadIds")!=null)ledger.pruneStandalone(call.getArray("liveUploadIds"));
     int active=0,completed=0,held=0,dependencyHeld=0;JSONArray jobs=ledger.jobs();JSONArray standalone=ledger.standaloneMedia();for(int i=0;i<standalone.length();i++)jobs.put(standalone.getJSONObject(i));
     for(int i=0;i<jobs.length();i++){String phase=jobs.getJSONObject(i).getString("phase");if("active".equals(phase)){JSONObject row=jobs.getJSONObject(i);if(row.has("opId") && !ledger.dependenciesApplied(row.getString("opId")))dependencyHeld++;else active++;}else if("completed".equals(phase))completed++;else if("held".equals(phase))held++;}
     JSObject result=new JSObject();result.put("active",active);result.put("completed",completed);result.put("held",held);result.put("dependencyHeld",dependencyHeld);return result;
   }
 });}
}
