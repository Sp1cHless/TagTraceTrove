package com.speechless666.t3.spike;

import android.content.Context;
import android.database.Cursor;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

/** Author02 only: real production Worker, native SQLite, pinned TLS. Business replay receipts are contract mocks. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=28) @SQLiteMode(SQLiteMode.Mode.NATIVE)
public class NativeAuthorDeleteTimelineJvmTest {
 static class Fixture implements AutoCloseable {
  final Process child;final java.io.BufferedReader reader;final java.io.PrintWriter writer;final PairingState pair;
  Fixture() throws Exception {
   String repo=System.getenv("T3_TEST_REPO");assertNotNull(repo);
   child=new ProcessBuilder("node",java.nio.file.Path.of(repo,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repo,"apps/server/tests/fixtures/native-author-delete-timeline.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
   reader=new java.io.BufferedReader(new java.io.InputStreamReader(child.getInputStream(),StandardCharsets.UTF_8));writer=new java.io.PrintWriter(child.getOutputStream(),true,StandardCharsets.UTF_8);
   String offer=reader.readLine();assertNotNull("TLS fixture must start",offer);pair=PairingState.claim(offer);
  }
  JSONObject command(JSONObject c)throws Exception{writer.println(c);String line=reader.readLine();assertNotNull("Fixture terminated for "+c,line);return new JSONObject(line);}
  void mode(JSONObject value)throws Exception{command(value.put("action","mode"));}
  JSONArray sent()throws Exception{return command(new JSONObject().put("action","counters")).getJSONArray("mutations");}
  public void close()throws Exception{writer.println("{\"action\":\"close\"}");if(!child.waitFor(15,java.util.concurrent.TimeUnit.SECONDS))child.destroyForcibly();}
 }
 static JSONObject op(JSONObject packet)throws Exception{return new JSONObject(packet.getString("body"));}
 static String id(JSONObject packet)throws Exception{return op(packet).getString("opId");}
 static JSONObject job(TransferLedger l,JSONObject packet)throws Exception{
  JSONArray rows=l.jobs();for(int i=0;i<rows.length();i++)if(id(packet).equals(rows.getJSONObject(i).getString("opId")))return rows.getJSONObject(i);throw new AssertionError(id(packet));
 }
 static void stage(TransferLedger l,JSONObject packet)throws Exception{
  l.stagePlannedOperation(packet.getString("body"),"1",packet.getJSONObject("plan").toString());assertTrue(l.activate(id(packet),"1"));
 }
 static void retained(TransferLedger l,JSONObject packet)throws Exception{
  byte[] bytes=packet.getString("body").getBytes(StandardCharsets.UTF_8);assertArrayEquals(bytes,l.operationBody(id(packet)));
  assertEquals(packet.getJSONObject("plan").toString(),l.plan(id(packet)).toString());
  try(Cursor c=l.getReadableDatabase().rawQuery("SELECT body_hash,client_id,library_id,epoch FROM operations WHERE op_id=?",new String[]{id(packet)})){
   assertTrue(c.moveToFirst());assertEquals(TransferLedger.sha256(bytes),c.getString(0));assertEquals(op(packet).getString("clientId"),c.getString(1));assertEquals(op(packet).getString("libraryId"),c.getString(2));assertEquals(op(packet).getString("syncEpoch"),c.getString(3));
  }
 }
 static void phase(TransferLedger l,JSONObject packet,String expected)throws Exception{assertEquals(packet.getString("body"),expected,job(l,packet).getString("phase"));retained(l,packet);}
 @Test public void profileEditDeleteColdRetention()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="author-profile-timeline.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture()){
   JSONArray packets=f.command(new JSONObject().put("action","timeline").put("kind","profile")).getJSONArray("packets");JSONObject first=packets.getJSONObject(0),deletion=packets.getJSONObject(1);
   assertEquals(op(first).getString("entityUid"),op(deletion).getString("entityUid"));assertTrue(op(deletion).getInt("baseVersion")>op(first).getInt("baseVersion"));
   try(TransferLedger l=new TransferLedger(c,name)){
    stage(l,first);stage(l,deletion);assertFalse(l.dependenciesApplied(id(deletion)));f.mode(new JSONObject());assertTrue(BackgroundTransferWorker.execute(l,f.pair,()->false));
    phase(l,first,"completed");phase(l,deletion,"completed");assertTrue(l.dependenciesApplied(id(deletion)));JSONArray sent=f.sent();assertEquals(2,sent.length());assertEquals(first.getString("body"),sent.getString(0));assertEquals(deletion.getString("body"),sent.getString(1));
   }
   try(TransferLedger cold=new TransferLedger(c,name)){
    phase(cold,first,"completed");phase(cold,deletion,"completed");String receipt=job(cold,deletion).getString("replay");assertTrue(AppliedReceipt.valid(new JSONObject(receipt),id(deletion)));
    assertFalse("Completed receipt is retained, not reactivated or cleaned",cold.resumeOperation(deletion.getString("body"),"1",deletion.getJSONObject("plan").toString()));f.mode(new JSONObject());assertTrue(BackgroundTransferWorker.execute(cold,f.pair,()->false));assertEquals(0,f.sent().length());assertEquals(receipt,job(cold,deletion).getString("replay"));assertEquals(2,cold.jobs().length());retained(cold,deletion);
   }
  }finally{c.deleteDatabase(name);}
 }
 void relatedHeldTimeline(String kind,boolean absent)throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="author-"+kind+"-timeline.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture()){
   JSONObject timeline=f.command(new JSONObject().put("action","timeline").put("kind",kind));JSONArray packets=timeline.getJSONArray("packets");JSONObject first=packets.getJSONObject(0),deletion=packets.getJSONObject(1),independent=packets.getJSONObject(2);
   assertNotEquals(first.getJSONObject("plan").getString("ownerKey"),deletion.getJSONObject("plan").getString("ownerKey"));assertEquals(id(first),deletion.getJSONObject("plan").getJSONArray("dependencies").getString(0));
   if(kind.equals("directory"))assertEquals(deletion.getJSONObject("plan").getString("ownerKey"),timeline.getJSONObject("directoryOwners").getString(id(first)));
   else assertEquals(op(deletion).getString("entityUid"),op(first).getJSONObject("payload").getString("producerUid"));
   try(TransferLedger l=new TransferLedger(c,name)){
    stage(l,first);stage(l,deletion);stage(l,independent);String flag=NativeMutationPlan.flags(op(first)).getString(1);f.mode(new JSONObject().put("flag",flag).put("absent",absent));assertTrue(BackgroundTransferWorker.execute(l,f.pair,()->false));
    phase(l,first,"held");assertTrue(job(l,first).isNull("replay"));assertTrue(job(l,first).getString("error").contains("capability"));phase(l,deletion,"active");assertFalse(l.dependenciesApplied(id(deletion)));phase(l,independent,"completed");JSONArray sent=f.sent();assertEquals(1,sent.length());assertEquals(independent.getString("body"),sent.getString(0));
   }
   try(TransferLedger cold=new TransferLedger(c,name)){
    phase(cold,first,"held");phase(cold,deletion,"active");phase(cold,independent,"completed");f.mode(new JSONObject().put("lose",id(deletion)));
    assertTrue("Explicit production resume of same original",cold.resumeOperation(first.getString("body"),"1",first.getJSONObject("plan").toString()));assertFalse("Lost HTTP response requires retry",BackgroundTransferWorker.execute(cold,f.pair,()->false));
    phase(cold,first,"completed");assertTrue(liveReceipt(cold,first));assertTrue(cold.dependenciesApplied(id(deletion)));phase(cold,deletion,"active");assertTrue(job(cold,deletion).getString("error").contains("exact original retry"));JSONArray sent=f.sent();assertEquals(2,sent.length());assertEquals(first.getString("body"),sent.getString(0));assertEquals(deletion.getString("body"),sent.getString(1));
   }
   try(TransferLedger retry=new TransferLedger(c,name)){
    phase(retry,first,"completed");phase(retry,deletion,"active");assertTrue(BackgroundTransferWorker.execute(retry,f.pair,()->false));phase(retry,deletion,"completed");assertTrue(liveReceipt(retry,deletion));JSONArray sent=f.sent();assertEquals(3,sent.length());assertEquals(deletion.getString("body"),sent.getString(2));assertEquals(sent.getString(1),sent.getString(2));assertEquals(3,retry.jobs().length());retained(retry,first);retained(retry,independent);
    assertEquals("Business SQL intentionally mocked",0,f.command(new JSONObject().put("action","counters")).getInt("sqlReceipts"));
   }
  }finally{c.deleteDatabase(name);}
 }
 static boolean liveReceipt(TransferLedger l,JSONObject p)throws Exception{return AppliedReceipt.valid(new JSONObject(job(l,p).getString("replay")),id(p));}
 @Test public void directoryHoldEntryProgressColdExactRetry()throws Exception{relatedHeldTimeline("directory",false);}
 @Test public void collectionHoldEntryProgressColdExactRetry()throws Exception{relatedHeldTimeline("collection",true);}
}
