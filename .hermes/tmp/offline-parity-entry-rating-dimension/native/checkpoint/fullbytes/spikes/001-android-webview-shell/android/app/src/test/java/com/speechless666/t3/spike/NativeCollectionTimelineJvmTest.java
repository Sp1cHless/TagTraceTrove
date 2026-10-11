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

/** Collection03 only: real production Worker, native SQLite, pinned TLS. Business replay receipts are contract mocks. */
@RunWith(RobolectricTestRunner.class) @Config(sdk=28) @SQLiteMode(SQLiteMode.Mode.NATIVE)
public class NativeCollectionTimelineJvmTest {
 static class Fixture implements AutoCloseable {
  final Process child;final java.io.BufferedReader reader;final java.io.PrintWriter writer;final PairingState pair;
  Fixture() throws Exception {
   String repo=System.getenv("T3_TEST_REPO");assertNotNull(repo);
   child=new ProcessBuilder("node",java.nio.file.Path.of(repo,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repo,"apps/server/tests/fixtures/native-collection-timeline.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
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

 static JSONArray packets(Fixture f,String kind)throws Exception{return f.command(new JSONObject().put("action","timeline").put("kind",kind)).getJSONArray("packets");}
 static void sqlZero(Fixture f)throws Exception{assertEquals("CONTRACT MOCKED business SQL",0,f.command(new JSONObject().put("action","counters")).getInt("sqlReceipts"));}
 void capCell(String kind,String name)throws Exception{
  Context c=RuntimeEnvironment.getApplication();c.deleteDatabase(name);
  try(Fixture f=new Fixture()){
   JSONObject p=packets(f,kind).getJSONObject(0);JSONArray flags=NativeMutationPlan.flags(op(p));assertEquals(p.getJSONObject("plan").getJSONArray("requiredFlags").toString(),flags.toString());
   assertEquals(new JSONObject(NativeMutationContract.JSON).getJSONObject(op(p).getString("operationKind")).getJSONArray("flags").toString(),flags.toString());
   try(TransferLedger l=new TransferLedger(c,name)){stage(l,p);}
   for(int i=0;i<flags.length();i++)for(boolean absent:new boolean[]{true,false}){
    try(TransferLedger l=new TransferLedger(c,name)){
     if("held".equals(job(l,p).getString("phase")))assertTrue(l.resumeOperation(p.getString("body"),"1",p.getJSONObject("plan").toString()));else phase(l,p,"active");
     f.mode(new JSONObject().put("flag",flags.getString(i)).put("absent",absent));assertTrue(BackgroundTransferWorker.execute(l,f.pair,()->false));phase(l,p,"held");assertTrue(job(l,p).isNull("replay"));assertEquals(0,f.sent().length());System.out.println("CAP_HOLD "+kind+" "+flags.getString(i)+" absent="+absent);sqlZero(f);
    }
    try(TransferLedger cold=new TransferLedger(c,name)){phase(cold,p,"held");}
   }
   try(TransferLedger l=new TransferLedger(c,name)){
    assertTrue(l.resumeOperation(p.getString("body"),"1",p.getJSONObject("plan").toString()));f.mode(new JSONObject().put("lose",id(p)));assertFalse(BackgroundTransferWorker.execute(l,f.pair,()->false));phase(l,p,"active");assertEquals(p.getString("body"),f.sent().getString(0));
   }
   try(TransferLedger cold=new TransferLedger(c,name)){
    phase(cold,p,"active");assertTrue(BackgroundTransferWorker.execute(cold,f.pair,()->false));
    System.out.println("VALID_RETRY "+kind+" "+job(cold,p));sqlZero(f);assertEquals(p.getString("body"),f.sent().getString(1));phase(cold,p,"completed");
    assertFalse(cold.resumeOperation(p.getString("body"),"1",p.getJSONObject("plan").toString()));f.mode(new JSONObject());assertTrue(BackgroundTransferWorker.execute(cold,f.pair,()->false));assertEquals(0,f.sent().length());assertEquals(1,cold.jobs().length());
   }
  }finally{c.deleteDatabase(name);}
 }
 @Test public void c1()throws Exception{capCell("delete","c1.db");}
 @Test public void c2()throws Exception{capCell("bulk","c2.db");}
 @Test public void c3()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="c3.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture()){
   JSONArray ps=packets(f,"chain");JSONObject create=ps.getJSONObject(0),member=ps.getJSONObject(1),bulk=ps.getJSONObject(2),del=ps.getJSONObject(3),entry=ps.getJSONObject(4);
   assertTrue(bulk.getJSONObject("plan").getJSONArray("dependencies").toString().contains(id(member)));assertTrue(del.getJSONObject("plan").getJSONArray("dependencies").toString().contains(id(bulk)));
   String flag=NativeMutationPlan.flags(op(create)).getString(1);
   try(TransferLedger l=new TransferLedger(c,name)){
    for(int i=0;i<ps.length();i++)stage(l,ps.getJSONObject(i));f.mode(new JSONObject().put("flag",flag));assertTrue(BackgroundTransferWorker.execute(l,f.pair,()->false));phase(l,create,"held");phase(l,member,"active");phase(l,bulk,"active");phase(l,del,"active");phase(l,entry,"completed");assertEquals(1,f.sent().length());assertEquals(entry.getString("body"),f.sent().getString(0));assertFalse(l.dependenciesApplied(id(bulk)));
   }
   try(TransferLedger l=new TransferLedger(c,name)){
    assertTrue(l.resumeOperation(create.getString("body"),"1",create.getJSONObject("plan").toString()));f.mode(new JSONObject());assertTrue(BackgroundTransferWorker.execute(l,f.pair,()->false));phase(l,create,"completed");phase(l,member,"completed");System.out.println("CHAIN_BULK "+job(l,bulk));sqlZero(f);phase(l,bulk,"completed");phase(l,del,"completed");JSONArray sent=f.sent();assertEquals(4,sent.length());for(int i=0;i<4;i++)assertEquals(ps.getJSONObject(i).getString("body"),sent.getString(i));
   }
  }finally{c.deleteDatabase(name);}
 }
 @Test public void c4()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="c4.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture()){
   JSONArray ps=packets(f,"bulk");JSONObject bulk=ps.getJSONObject(0),del=ps.getJSONObject(1),entry=ps.getJSONObject(2);
   try(TransferLedger l=new TransferLedger(c,name)){for(int i=0;i<ps.length();i++)stage(l,ps.getJSONObject(i));}
   for(String variant:new String[]{"foreign","shape","owned"}){
    try(TransferLedger l=new TransferLedger(c,name)){
     if("held".equals(job(l,bulk).getString("phase")))assertTrue(l.resumeOperation(bulk.getString("body"),"1",bulk.getJSONObject("plan").toString()));else phase(l,bulk,"active");f.mode(new JSONObject().put("fault",id(bulk)).put("variant",variant));assertTrue(BackgroundTransferWorker.execute(l,f.pair,()->false));
     System.out.println("FAULT "+variant+" "+job(l,bulk));sqlZero(f);phase(l,bulk,"held");phase(l,del,"active");assertFalse(l.dependenciesApplied(id(del)));phase(l,entry,"completed");JSONArray sent=f.sent();assertEquals(variant.equals("foreign")?2:1,sent.length());assertEquals(bulk.getString("body"),sent.getString(0));
    }
   }
   try(TransferLedger l=new TransferLedger(c,name)){
    assertTrue(l.resumeOperation(bulk.getString("body"),"1",bulk.getJSONObject("plan").toString()));f.mode(new JSONObject());assertTrue(BackgroundTransferWorker.execute(l,f.pair,()->false));System.out.println("RESTORED_VALID "+job(l,bulk));sqlZero(f);phase(l,bulk,"completed");phase(l,del,"completed");assertEquals(2,f.sent().length());assertEquals(bulk.getString("body"),f.sent().getString(0));assertEquals(del.getString("body"),f.sent().getString(1));
   }
  }finally{c.deleteDatabase(name);}
 }
}
