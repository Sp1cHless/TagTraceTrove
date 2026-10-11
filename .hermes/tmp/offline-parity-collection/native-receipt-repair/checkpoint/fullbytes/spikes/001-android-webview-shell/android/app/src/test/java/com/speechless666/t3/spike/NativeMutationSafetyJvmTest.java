package com.speechless666.t3.spike;
import android.content.Context;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import org.json.JSONArray;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=28) @SQLiteMode(SQLiteMode.Mode.NATIVE)
public class NativeMutationSafetyJvmTest {
 private static String body() throws Exception {return new JSONObject().put("opId","11111111-1111-4111-8111-111111111111").put("clientId","22222222-2222-4222-8222-222222222222").put("libraryId","33333333-3333-4333-8333-333333333333").put("syncEpoch","epoch").put("entityKind","producer").put("entityUid","44444444-4444-4444-8444-444444444444").put("operationKind","producer.update").put("baseVersion",1).put("baseValues",new JSONObject().put("name","Before")).put("payload",new JSONObject().put("name","After")).put("clientCreatedAt","2026-10-04T00:00:00.000Z").toString();}
 private static String plan(String body) throws Exception {JSONObject op=new JSONObject(body);return new JSONObject().put("version",1).put("eligible",true).put("opId",op.getString("opId")).put("ownerKey",NativeMutationPlan.owner(op)).put("order",0).put("requiredFlags",NativeMutationPlan.flags(op)).put("dependencies",new JSONArray()).toString();}
 @Test public void unchangedOriginalCanRestageAtNewRevisionButStaleActivationCannotWin() throws Exception {
  Context c=RuntimeEnvironment.getApplication();String name="generic-revision.db",body=body(),id=new JSONObject(body).getString("opId");c.deleteDatabase(name);
  try(TransferLedger ledger=new TransferLedger(c,name)) {
   ledger.stagePlannedOperation(body,"r1",plan(body));ledger.stagePlannedOperation(body,"r2",plan(body));
   assertFalse(ledger.activate(id,"r1"));assertTrue(ledger.activate(id,"r2"));assertArrayEquals(body.getBytes(java.nio.charset.StandardCharsets.UTF_8),ledger.operationBody(id));
  }finally{c.deleteDatabase(name);}
 }
 @Test public void cancelledUnsealedOperationIdentityCannotLaterSeal() throws Exception {
  Context c=RuntimeEnvironment.getApplication();String name="unsealed-cancel.db",body=body(),id=new JSONObject(body).getString("opId");c.deleteDatabase(name);
  try(TransferLedger ledger=new TransferLedger(c,name)) {
   ledger.pause(new JSONArray().put(id));
   try{ledger.stagePlannedOperation(body,"1",plan(body));fail("Unsealed cancelled capture must not resurrect");}catch(SecurityException expected){}
  }finally{c.deleteDatabase(name);}
 }
 @Test public void oldCapturedNumericGenerationCannotReplaceNewGeneration() throws Exception {
  Context c=RuntimeEnvironment.getApplication();String name="stale-restage.db",body=body(),id=new JSONObject(body).getString("opId");c.deleteDatabase(name);
  try(TransferLedger ledger=new TransferLedger(c,name)) {
   ledger.stagePlannedOperation(body,"1",plan(body));ledger.stagePlannedOperation(body,"2",plan(body));
   try{ledger.stagePlannedOperation(body,"1",plan(body));fail("Stale capture must not replace generation");}catch(SecurityException expected){}
   assertFalse(ledger.activate(id,"1"));assertTrue(ledger.activate(id,"2"));
  }finally{c.deleteDatabase(name);}
 }
 @Test public void explicitGenericResumeRechecksImmutableBodyGenerationAndRefusesConflictReplay() throws Exception {
  Context c=RuntimeEnvironment.getApplication();String name="generic-resume.db",body=body(),id=new JSONObject(body).getString("opId");c.deleteDatabase(name);
  try(TransferLedger ledger=new TransferLedger(c,name)) {
   ledger.stagePlannedOperation(body,"1",plan(body));assertTrue(ledger.activate(id,"1"));assertTrue(ledger.claimJob(id,"first",100));
   assertTrue(ledger.finishJob(id,"first",body.getBytes(java.nio.charset.StandardCharsets.UTF_8),"held",null,null,"Capability held",101));
   assertFalse(ledger.activate(id,"1"));assertFalse(ledger.resumeOperation(body,"0",plan(body)));assertTrue(ledger.resumeOperation(body,"1",plan(body)));
   assertTrue(ledger.claimJob(id,"second",102));
   assertTrue(ledger.finishJob(id,"second",body.getBytes(java.nio.charset.StandardCharsets.UTF_8),"held","{\"status\":\"conflict\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8),null,"Conflict",103));
   assertFalse("Native conflict is not an automatic or explicit unchanged replay",ledger.resumeOperation(body,"1",plan(body)));
  }finally{c.deleteDatabase(name);}
 }
 @Test public void lateOldOwnerResultCannotSettleTheNewLease() throws Exception {
  Context c=RuntimeEnvironment.getApplication();String name="late-result.db",body=body(),id=new JSONObject(body).getString("opId");c.deleteDatabase(name);
  try(TransferLedger ledger=new TransferLedger(c,name)) {
   ledger.stagePlannedOperation(body,"1",plan(body));ledger.activate(id,"1");assertTrue(ledger.claimJob(id,"old",100));assertTrue(ledger.claimJob(id,"new",120101));
   assertFalse(ledger.finishJob(id,"old",body.getBytes(java.nio.charset.StandardCharsets.UTF_8),"completed",new byte[]{1},null,null,120102));
   assertTrue(ledger.renewJob(id,"new",120102));assertEquals("active",ledger.jobs().getJSONObject(0).getString("phase"));
   try{ledger.pause(null);fail("In-flight canonical work must be retained");}catch(IllegalStateException expected){}
  }finally{c.deleteDatabase(name);}
 }
 @Test public void productionCancellationDeletesUnsealedFilesAndPersistsBothIdentities() throws Exception {
  Context c=RuntimeEnvironment.getApplication();String name="capture-files.db",body=body(),id=new JSONObject(body).getString("opId"),upload="55555555-5555-4555-8555-555555555555",stage="66666666-6666-4666-8666-666666666666";c.deleteDatabase(name);
  java.io.File dir=new java.io.File(c.getFilesDir(),"test-captures");dir.mkdirs();java.io.File capture=new java.io.File(dir,stage+".json"),part=new java.io.File(dir,stage+".part");
  try(TransferLedger ledger=new TransferLedger(c,name)) {
   try(java.io.FileOutputStream out=new java.io.FileOutputStream(capture)){out.write(new JSONObject().put("body",body).put("uploadId",upload).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));}
   try(java.io.FileOutputStream out=new java.io.FileOutputStream(part)){out.write(new byte[]{1,2,3});}
   BackgroundTransferPlugin.cancelCaptures(ledger,dir,null,new JSONArray().put(id),new JSONArray().put(upload));
   assertFalse(capture.exists());assertFalse(part.exists());
   try{ledger.requireLiveCapture(id,null);fail("Cancelled operation capture");}catch(SecurityException expected){}
   try{ledger.requireLiveCapture(null,upload);fail("Cancelled image capture");}catch(SecurityException expected){}
  }finally{capture.delete();part.delete();dir.delete();c.deleteDatabase(name);}
 }
 // Defense coverage: settlement linearizes before cancellation; no new production behavior.
 @Test public void completedSettlementBeforeLaterCancellationKeepsItsReceiptAndOriginal() throws Exception {
  Context c=RuntimeEnvironment.getApplication();String name="settled-before-cancel.db",body=body(),id=new JSONObject(body).getString("opId");c.deleteDatabase(name);
  byte[] original=body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
  byte[] receipt=new JSONObject().put("opId",id).put("status","applied").put("resourceVersion",2).put("serverSeq",1).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
  try(TransferLedger ledger=new TransferLedger(c,name)) {
   ledger.stagePlannedOperation(body,"1",plan(body));assertTrue(ledger.activate(id,"1"));assertTrue(ledger.claimJob(id,"owner",100));
   assertTrue(ledger.finishJob(id,"owner",original,"completed",receipt,null,null,101));
   ledger.pause(new JSONArray().put(id));
   assertArrayEquals(original,ledger.operationBody(id));
   assertEquals(new String(receipt,java.nio.charset.StandardCharsets.UTF_8),ledger.jobs().getJSONObject(0).getString("replay"));
   assertFalse(ledger.finishJob(id,"owner",original,"active",null,null,"late",102));
   assertEquals(new String(receipt,java.nio.charset.StandardCharsets.UTF_8),ledger.jobs().getJSONObject(0).getString("replay"));
  }finally{c.deleteDatabase(name);}
 }
 @Test public void genericDiscardTombstoneRejectsLateRestageAfterPrune() throws Exception {
  Context c=RuntimeEnvironment.getApplication();String name="generic-tombstone.db",body=body();c.deleteDatabase(name);
  try(TransferLedger ledger=new TransferLedger(c,name)) {
   ledger.stagePlannedOperation(body,"r1",plan(body));ledger.pause(null);ledger.pruneCancelled(new JSONArray(),new JSONArray());
   try{ledger.stagePlannedOperation(body,"r1",plan(body));fail("Discarded operation must not resurrect");}catch(SecurityException expected){}
  }finally{c.deleteDatabase(name);}
 }
}
