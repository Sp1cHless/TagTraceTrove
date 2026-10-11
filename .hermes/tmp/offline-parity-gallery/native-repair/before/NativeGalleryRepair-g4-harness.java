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

/** Gallery04 finite: real production Worker, native SQLite, pinned TLS. Business replay receipts are canonical SQL. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=28) @SQLiteMode(SQLiteMode.Mode.NATIVE)
public class NativeGalleryRepairJvmTest {
 static class Fixture implements AutoCloseable {
  final Process child;final java.io.BufferedReader reader;final java.io.PrintWriter writer;final PairingState pair;
  Fixture() throws Exception {
   String repo=System.getenv("T3_TEST_REPO");assertNotNull(repo);
   child=new ProcessBuilder("C:/Users/hzy/AppData/Local/hermes/node/node.exe",java.nio.file.Path.of(repo,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repo,"apps/server/tests/fixtures/native-gallery-repair.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
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

 @Test public void g2()throws Exception{
  try(Fixture f=new Fixture()){
   JSONArray packets=f.command(new JSONObject().put("action","chain")).getJSONArray("packets");JSONObject target=packets.getJSONObject(1);
   JSONObject bad=new JSONObject(target.getJSONObject("plan").toString()).put("dependencies",new JSONArray());
   boolean rejected=false;try{NativeMutationPlan.validate(op(target),bad);}catch(SecurityException expected){rejected=true;}
   assertTrue("Origin's original UUID dependency must not be omitted from sealed plan",rejected);
   NativeMutationPlan.validate(op(target),target.getJSONObject("plan"));
  }
 }
 @Test public void g4()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="g4.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
   JSONObject creator=f.command(new JSONObject().put("action","chain")).getJSONArray("packets").getJSONObject(0);
   assertTrue(op(creator).getJSONObject("payload").has("partitionScopeUid"));
   assertFalse(creator.getJSONObject("plan").getJSONArray("requiredFlags").toString().contains("offlineEntryNewType"));
   stage(l,creator);
   for(boolean absent:new boolean[]{false,true}){
    f.mode(new JSONObject().put("flag","offlineEntryNewType").put("absent",absent));
    BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,creator,"held");assertEquals(0,f.sent().length());
    assertTrue(l.activate(id(creator),"1"));
   }
   f.mode(new JSONObject());BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,creator,"completed");assertEquals(1,f.sent().length());
  }finally{c.deleteDatabase(name);}
 }

}
