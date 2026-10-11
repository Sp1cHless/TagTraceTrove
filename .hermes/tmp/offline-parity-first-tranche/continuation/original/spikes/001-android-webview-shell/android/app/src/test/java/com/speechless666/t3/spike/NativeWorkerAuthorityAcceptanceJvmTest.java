package com.speechless666.t3.spike;
import android.content.Context;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;
/** Defense acceptance of production Worker.execute; TLS is real, replay receipts are contract mocks. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=28) @SQLiteMode(SQLiteMode.Mode.NATIVE)
public class NativeWorkerAuthorityAcceptanceJvmTest {
 static class Fixture implements AutoCloseable {
  final Process child;final java.io.BufferedReader reader;final java.io.PrintWriter writer;final PairingState pair;final JSONArray rows;
  Fixture() throws Exception {
   String repo=System.getenv("T3_TEST_REPO");assertNotNull(repo);
   child=new ProcessBuilder("node",java.nio.file.Path.of(repo,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repo,"apps/server/tests/fixtures/native-worker-authority-acceptance.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
   reader=new java.io.BufferedReader(new java.io.InputStreamReader(child.getInputStream(),StandardCharsets.UTF_8));writer=new java.io.PrintWriter(child.getOutputStream(),true,StandardCharsets.UTF_8);
   pair=PairingState.claim(reader.readLine());rows=command(new JSONObject().put("action","rows")).getJSONArray("rows");assertEquals(new JSONObject(NativeMutationContract.JSON).length(),rows.length());
  }
  JSONObject command(JSONObject c)throws Exception{writer.println(c);String line=reader.readLine();assertNotNull("Fixture terminated for "+c,line);return new JSONObject(line);}
  void mode(JSONObject value)throws Exception{value.put("action","mode");command(value);}
  JSONObject counters()throws Exception{return command(new JSONObject().put("action","counters"));}
  public void close()throws Exception{writer.println("{\"action\":\"close\"}");if(!child.waitFor(15,java.util.concurrent.TimeUnit.SECONDS))child.destroyForcibly();}
 }
 static JSONObject plan(JSONObject op,JSONArray deps)throws Exception{return new JSONObject().put("version",1).put("eligible",true).put("opId",op.getString("opId")).put("ownerKey",NativeMutationPlan.owner(op)).put("order",0).put("requiredFlags",NativeMutationPlan.flags(op)).put("dependencies",deps);}
 static void stage(TransferLedger l,JSONObject op,JSONArray deps)throws Exception{l.stagePlannedOperation(op.toString(),"1",plan(op,deps).toString());assertTrue(l.activate(op.getString("opId"),"1"));}
 static JSONObject row(Fixture f,String kind)throws Exception{for(int i=0;i<f.rows.length();i++){JSONObject op=f.rows.getJSONObject(i);if(kind.equals(op.getString("operationKind")))return new JSONObject(op.toString());}throw new AssertionError(kind);}
 static JSONObject job(TransferLedger l,String id)throws Exception{JSONArray jobs=l.jobs();for(int i=0;i<jobs.length();i++)if(id.equals(jobs.getJSONObject(i).getString("opId")))return jobs.getJSONObject(i);throw new AssertionError(id);}
 static void retained(TransferLedger l,JSONObject op)throws Exception{assertArrayEquals(op.toString().getBytes(StandardCharsets.UTF_8),l.operationBody(op.getString("opId")));}
 // Parent append dependency is established by real Worker execution with a contract-mocked receipt.
 static JSONArray prerequisites(TransferLedger l,Fixture f,JSONObject op)throws Exception{
  JSONArray deps=new JSONArray();if(op.getJSONObject("payload").has("parentCreateOpId")){
   JSONObject parent=row(f,"entry.create");parent.put("opId",op.getJSONObject("payload").getString("parentCreateOpId"));parent.put("entityUid",op.getString("entityUid"));stage(l,parent,new JSONArray());f.mode(new JSONObject());assertTrue(BackgroundTransferWorker.execute(l,f.pair,()->false));deps.put(parent.getString("opId"));
  }return deps;
 }
 @Test public void all23KindsEachRequiredFlagAbsentAndFalseRetainOriginalWithZeroMutations()throws Exception{
  Context c=RuntimeEnvironment.getApplication();try(Fixture f=new Fixture()){
   for(int i=0;i<f.rows.length();i++)for(int flagIndex=0;flagIndex<NativeMutationPlan.flags(f.rows.getJSONObject(i)).length();flagIndex++)for(boolean absent:new boolean[]{true,false}){
    JSONObject op=f.rows.getJSONObject(i);String name="flag-"+i+"-"+flagIndex+"-"+absent+".db";c.deleteDatabase(name);
    try(TransferLedger l=new TransferLedger(c,name)){
     JSONArray deps=prerequisites(l,f,op);String flag=NativeMutationPlan.flags(op).getString(flagIndex);f.mode(new JSONObject().put("flag",flag).put("absent",absent));stage(l,op,deps);
     assertTrue(BackgroundTransferWorker.execute(l,f.pair,()->false));assertEquals(op.getString("operationKind")+" / "+flag+" / absent="+absent,"held",job(l,op.getString("opId")).getString("phase"));retained(l,op);assertTrue(job(l,op.getString("opId")).isNull("replay"));assertEquals(0,f.counters().getJSONArray("mutations").length());
    }finally{c.deleteDatabase(name);}
   }
  }
 }
 @Test public void all23EnabledKindsSendExactOriginalAcceptContractReceiptButRetainRows()throws Exception{
  Context c=RuntimeEnvironment.getApplication();try(Fixture f=new Fixture()){
   for(int i=0;i<f.rows.length();i++){
    JSONObject op=f.rows.getJSONObject(i);String name="enabled-"+i+".db";c.deleteDatabase(name);
    try(TransferLedger l=new TransferLedger(c,name)){
     JSONArray deps=prerequisites(l,f,op);f.mode(new JSONObject());stage(l,op,deps);assertTrue(BackgroundTransferWorker.execute(l,f.pair,()->false));assertEquals(op.toString(),"completed",job(l,op.getString("opId")).getString("phase"));retained(l,op);
     JSONArray sent=f.counters().getJSONArray("mutations");assertEquals(1,sent.length());assertEquals(op.toString(),sent.getString(0));assertTrue(l.dependenciesApplied(op.getString("opId")));assertEquals(0,f.counters().getInt("receipts"));
    }finally{c.deleteDatabase(name);}
   }
  }
 }
 void authority(String action)throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="authority-"+action+".db";c.deleteDatabase(name);
  try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
   JSONObject op=row(f,"entry.create");stage(l,op,new JSONArray());byte[] bytes={1,2,3};String upload="77777777-7777-4777-8777-777777777777";
   JSONObject metadata=new JSONObject().put("libraryId",op.getString("libraryId")).put("syncEpoch",op.getString("syncEpoch")).put("entryUid",op.getString("entityUid")).put("byteLength",3).put("sha256",TransferLedger.sha256(bytes)).put("mimeType","image/png").put("kind","cover").put("ordinal",0).put("existingEntry",new JSONObject().put("expectedCoverRef",JSONObject.NULL).put("expectedPreviewRefs",new JSONArray()));
   l.stageStandaloneMedia(op.getString("clientId"),upload,metadata.toString(),"[]","1",bytes);l.activateStandaloneMedia(upload,"1");f.mode(new JSONObject());f.command(new JSONObject().put("action",action).put("deviceId",f.pair.deviceId));
   assertTrue(BackgroundTransferWorker.execute(l,f.pair,()->false));assertEquals("held",job(l,op.getString("opId")).getString("phase"));retained(l,op);assertArrayEquals(bytes,l.standaloneBytes(upload));assertEquals("held",l.standaloneMedia().getJSONObject(0).getString("phase"));assertEquals(0,f.counters().getJSONArray("mutations").length());assertEquals(0,f.counters().getInt("receipts"));
  }finally{c.deleteDatabase(name);}
 }
 @Test public void revokedActualSessionPreflightZeroWritesRetainsOperationAndBytes()throws Exception{authority("revoke");}
 @Test public void replacedActualCertificatePreflightZeroWritesRetainsOperationAndBytes()throws Exception{authority("pin");}
 @Test public void rotatedActualSqlEpochPreflightZeroWritesRetainsOperationAndBytes()throws Exception{authority("epoch");}
 void malformed(String bad)throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="receipt-"+bad+".db";c.deleteDatabase(name);
  try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
   JSONObject first=row(f,"producer.update"),successor=new JSONObject(first.toString()).put("opId",java.util.UUID.randomUUID().toString()),independent=new JSONObject(first.toString()).put("opId",java.util.UUID.randomUUID().toString()).put("entityUid",java.util.UUID.randomUUID().toString());
   stage(l,first,new JSONArray());stage(l,successor,new JSONArray().put(first.getString("opId")));stage(l,independent,new JSONArray());f.mode(new JSONObject().put("bad",bad).put("target",first.getString("opId")));
   assertTrue(BackgroundTransferWorker.execute(l,f.pair,()->false));retained(l,first);retained(l,successor);retained(l,independent);
   assertEquals("Independent owner must progress","completed",job(l,independent.getString("opId")).getString("phase"));
   assertFalse("Malformed "+bad+" receipt must not authorize dependency",l.dependenciesApplied(successor.getString("opId")));
   assertEquals("Malformed "+bad+" parent must be held","held",job(l,first.getString("opId")).getString("phase"));assertEquals("active",job(l,successor.getString("opId")).getString("phase"));assertEquals(2,f.counters().getJSONArray("mutations").length());assertEquals(0,f.counters().getInt("receipts"));
  }finally{c.deleteDatabase(name);}
 }
 @Test public void malformedOpIdHoldsDependentButIndependentOwnerExecutes()throws Exception{malformed("opId");}
 @Test public void malformedStatusHoldsDependentButIndependentOwnerExecutes()throws Exception{malformed("status");}
 @Test public void malformedLibraryHoldsDependentButIndependentOwnerExecutes()throws Exception{malformed("libraryId");}
 @Test public void malformedEpochHoldsDependentButIndependentOwnerExecutes()throws Exception{malformed("syncEpoch");}
 @Test public void malformedResourceKindHoldsDependentButIndependentOwnerExecutes()throws Exception{malformed("resourceKind");}
 @Test public void capabilityHeldOwnerDoesNotBlockIndependentOwner()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="independent-cap.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
   JSONObject first=row(f,"producer.update"),second=row(f,"entry.update"),successor=new JSONObject(first.toString()).put("opId",java.util.UUID.randomUUID().toString());stage(l,first,new JSONArray());stage(l,successor,new JSONArray().put(first.getString("opId")));stage(l,second,new JSONArray());
   f.mode(new JSONObject().put("flag",NativeMutationPlan.flags(first).getString(NativeMutationPlan.flags(first).length()-1)).put("absent",true));assertTrue(BackgroundTransferWorker.execute(l,f.pair,()->false));assertEquals("held",job(l,first.getString("opId")).getString("phase"));assertEquals("active",job(l,successor.getString("opId")).getString("phase"));assertEquals("completed",job(l,second.getString("opId")).getString("phase"));assertEquals(1,f.counters().getJSONArray("mutations").length());retained(l,first);retained(l,successor);retained(l,second);
  }finally{c.deleteDatabase(name);}
 }
 @Test public void cachedCompletedInvalidReceiptsNeverGrantDependencies()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="cached-receipts.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
   JSONObject first=row(f,"producer.update"),next=new JSONObject(first.toString()).put("opId",java.util.UUID.randomUUID().toString());
   stage(l,first,new JSONArray());stage(l,next,new JSONArray().put(first.getString("opId")));
   JSONObject valid=new JSONObject().put("opId",first.getString("opId")).put("status","applied").put("resourceVersion",1).put("serverSeq",0);
   java.util.List<JSONObject> invalid=new java.util.ArrayList<>();
   for(String extra:new String[]{"libraryId","syncEpoch","resourceKind"})invalid.add(new JSONObject(valid.toString()).put(extra,"foreign"));
   for(Object value:new Object[]{"1",1.5,0,9007199254740992L,JSONObject.NULL})invalid.add(new JSONObject(valid.toString()).put("resourceVersion",value));
   invalid.add(new JSONObject(valid.toString()).put("serverSeq","0"));invalid.add(new JSONObject(valid.toString()).put("entityId",0));
   for(JSONObject receipt:invalid){android.content.ContentValues v=new android.content.ContentValues();v.put("phase","completed");v.put("replay",receipt.toString().getBytes(StandardCharsets.UTF_8));l.getWritableDatabase().update("background_jobs",v,"op_id=?",new String[]{first.getString("opId")});assertFalse(receipt.toString(),l.dependenciesApplied(next.getString("opId")));}
   android.content.ContentValues v=new android.content.ContentValues();v.put("replay",valid.toString().getBytes(StandardCharsets.UTF_8));l.getWritableDatabase().update("background_jobs",v,"op_id=?",new String[]{first.getString("opId")});assertTrue(l.dependenciesApplied(next.getString("opId")));retained(l,first);retained(l,next);
  }finally{c.deleteDatabase(name);}
 }
}
