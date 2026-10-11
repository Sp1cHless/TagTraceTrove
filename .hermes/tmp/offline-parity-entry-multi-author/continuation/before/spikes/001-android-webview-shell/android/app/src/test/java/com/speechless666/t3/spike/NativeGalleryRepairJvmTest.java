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
    assertTrue(l.resumeOperation(creator.getString("body"),"1",creator.getJSONObject("plan").toString()));
   }
   f.mode(new JSONObject());BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,creator,"completed");assertEquals(1,f.sent().length());
  }finally{c.deleteDatabase(name);}
 }

 static void resume(TransferLedger l,JSONObject p)throws Exception{assertTrue(l.resumeOperation(p.getString("body"),"1",p.getJSONObject("plan").toString()));}
 @Test public void g3()throws Exception{
  Context c=RuntimeEnvironment.getApplication();int cell=0;
  for(String kind:new String[]{"saved-global","saved-part","origin-create","origin-part"})for(boolean absent:new boolean[]{false,true}){
   String name="g3-"+(cell++)+".db";c.deleteDatabase(name);
   try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
    JSONArray rows=f.command(new JSONObject().put("action","chain")).getJSONArray("packets");
    JSONObject target=rows.getJSONObject(kind.startsWith("saved")?3:kind.equals("origin-create")?0:1);
    if(kind.equals("origin-part")){stage(l,rows.getJSONObject(0));BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,rows.getJSONObject(0),"completed");}
    String flag=kind.equals("saved-global")?"offlineMutations":kind.equals("saved-part")?"offlineGalleryPartition":"offlineGalleryPartitionOrigins";
    assertEquals(target.getJSONObject("plan").getJSONArray("requiredFlags").toString(),NativeMutationPlan.flags(op(target)).toString());stage(l,target);
    f.mode(new JSONObject().put("flag",flag).put("absent",absent));BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,target,"held");assertEquals(0,f.sent().length());
    f.mode(new JSONObject());resume(l,target);BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,target,"completed");assertEquals(target.getString("body"),f.sent().getString(0));
   }finally{c.deleteDatabase(name);}
  }
  System.out.println("CAP_CELLS "+cell+" false/absent zero businessPOST then actualSQL recovered");
 }
 @Test public void g5()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="g5.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
   JSONArray rows=f.command(new JSONObject().put("action","chain")).getJSONArray("packets");for(int i=0;i<rows.length();i++)stage(l,rows.getJSONObject(i));
   JSONObject independent=f.command(new JSONObject().put("action","timeline").put("kind","existing")).getJSONArray("packets").getJSONObject(0);stage(l,independent);
   f.mode(new JSONObject().put("flag","offlineMutations"));BackgroundTransferWorker.execute(l,f.pair,()->false);assertEquals(0,f.sent().length());phase(l,rows.getJSONObject(0),"held");phase(l,rows.getJSONObject(3),"held");phase(l,independent,"held");
   f.mode(new JSONObject().put("flag","offlineGalleryPartitionOrigins"));resume(l,rows.getJSONObject(0));resume(l,rows.getJSONObject(3));resume(l,independent);
   BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,rows.getJSONObject(0),"held");phase(l,rows.getJSONObject(1),"active");phase(l,rows.getJSONObject(2),"active");phase(l,rows.getJSONObject(3),"completed");phase(l,independent,"completed");assertEquals(2,f.sent().length());
   f.mode(new JSONObject());resume(l,rows.getJSONObject(0));BackgroundTransferWorker.execute(l,f.pair,()->false);
   for(int i=0;i<3;i++){phase(l,rows.getJSONObject(i),"completed");assertEquals(rows.getJSONObject(i).getString("body"),f.sent().getString(i));}phase(l,independent,"completed");
   assertEquals(5,f.command(new JSONObject().put("action","counters")).getInt("sqlReceipts"));
   System.out.println("REAL_SQL creator->partitiontrue->partitionfalse + independent partition/Entry; receipts=5");
  }finally{c.deleteDatabase(name);}
 }
 @Test public void g6()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="g6.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture()){
   JSONObject creator=f.command(new JSONObject().put("action","chain")).getJSONArray("packets").getJSONObject(0);
   try(TransferLedger l=new TransferLedger(c,name)){
    stage(l,creator);f.mode(new JSONObject().put("loss",true));assertFalse(BackgroundTransferWorker.execute(l,f.pair,()->false));phase(l,creator,"active");assertEquals(creator.getString("body"),f.sent().getString(0));assertEquals(1,f.command(new JSONObject().put("action","counters")).getInt("sqlReceipts"));
   }
   try(TransferLedger l=new TransferLedger(c,name)){
    retained(l,creator);
    for(boolean absent:new boolean[]{false,true}){f.mode(new JSONObject().put("flag","offlineGalleryPartitionOrigins").put("absent",absent));BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,creator,"held");assertEquals(0,f.sent().length());resume(l,creator);}
    f.mode(new JSONObject());BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,creator,"completed");assertEquals(creator.getString("body"),f.sent().getString(0));assertEquals(1,f.command(new JSONObject().put("action","counters")).getInt("sqlReceipts"));
   }
   System.out.println("REAL_SQL committed response-loss cold exact-original retry dedupe receipts=1; attempted conditional downgrade retained");
  }finally{c.deleteDatabase(name);}
  int cell=0;for(String invalid:new String[]{"missing","foreign","invalid"}){
   name="g6-n"+(cell++)+".db";c.deleteDatabase(name);
   try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
    JSONArray rows=f.command(new JSONObject().put("action","chain")).getJSONArray("packets");stage(l,rows.getJSONObject(0));stage(l,rows.getJSONObject(1));stage(l,rows.getJSONObject(3));
    f.mode(new JSONObject().put("invalid",invalid));BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,rows.getJSONObject(0),"held");phase(l,rows.getJSONObject(1),"active");phase(l,rows.getJSONObject(3),"completed");assertFalse(l.dependenciesApplied(id(rows.getJSONObject(1))));assertEquals(2,f.sent().length());
   }finally{c.deleteDatabase(name);}
  }
  System.out.println("MOCK_INVALID_RESPONSE cells=3 after valid canonicalSQL; strict parent rejection + child refused + independent partition completed");
 }

}
