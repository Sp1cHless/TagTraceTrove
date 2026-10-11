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

/** Entry07 finite: real production Worker, native SQLite, pinned TLS. Business replay receipts are canonical SQL. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=28) @SQLiteMode(SQLiteMode.Mode.NATIVE)
public class NativeEntryMergeJvmTest {
 static class Fixture implements AutoCloseable {
  final Process child;final java.io.BufferedReader reader;final java.io.PrintWriter writer;final PairingState pair;
  Fixture() throws Exception {
   String repo=System.getenv("T3_TEST_REPO");assertNotNull(repo);
   child=new ProcessBuilder("C:/Users/hzy/AppData/Local/hermes/node/node.exe",java.nio.file.Path.of(repo,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repo,"apps/server/tests/fixtures/native-entry-merge.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
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
 static void resume(TransferLedger l,JSONObject p)throws Exception{assertTrue(l.resumeOperation(p.getString("body"),"1",p.getJSONObject("plan").toString()));}

 @Test public void g1()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="n1.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
   JSONArray packets=f.command(new JSONObject().put("action","packets")).getJSONArray("packets");
   JSONObject merge=packets.getJSONObject(0),independent=packets.getJSONObject(1);
   assertEquals(merge.getJSONObject("plan").getJSONArray("requiredFlags").toString(),NativeMutationPlan.flags(op(merge)).toString());
   NativeMutationPlan.validate(op(merge),merge.getJSONObject("plan"));
   stage(l,merge);stage(l,independent);
   BackgroundTransferWorker.execute(l,f.pair,()->false);
   phase(l,merge,"completed");phase(l,independent,"completed");
   assertEquals(merge.getString("body"),f.sent().getString(0));assertEquals(independent.getString("body"),f.sent().getString(1));
   JSONObject facts=f.command(new JSONObject().put("action","facts"));
   assertEquals(0,facts.getJSONObject("absorbRows").getInt("n"));
   assertEquals("Merged title",facts.getString("keepTitle"));
   assertEquals("Film renamed",facts.getString("filmTitle"));
   assertEquals(1,facts.getJSONObject("copiedSources").getInt("n"));
   assertEquals(1,facts.getJSONObject("copiedTags").getInt("n"));
   assertEquals(2,facts.getJSONArray("receipts").length());
   System.out.println("REAL_SQL merge deletes absorbed copies tag+source exactbody independentEntry advances");
  }finally{c.deleteDatabase(name);}
 }
 @Test public void g2()throws Exception{
  Context c=RuntimeEnvironment.getApplication();int cell=0;
  for(String flag:new String[]{"offlineMutations","offlineEntryMerge"})for(boolean absent:new boolean[]{false,true}){
   String name="n2-"+(cell++)+".db";c.deleteDatabase(name);
   try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
    JSONObject p=f.command(new JSONObject().put("action","packets").put("kind","solo")).getJSONArray("packets").getJSONObject(0);
    assertEquals(p.getJSONObject("plan").getJSONArray("requiredFlags").toString(),NativeMutationPlan.flags(op(p)).toString());
    stage(l,p);f.mode(new JSONObject().put("flag",flag).put("absent",absent));
    BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,p,"held");assertEquals(0,f.sent().length());
    f.mode(new JSONObject());resume(l,p);BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,p,"completed");
    assertEquals(p.getString("body"),f.sent().getString(0));
   }finally{c.deleteDatabase(name);}
  }System.out.println("CAP_CELLS 4 absent/false zeroPOST original retained recovery actualSQL");
 }
}
