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
public class NativeEntryRatingDimensionJvmTest {
 static class Fixture implements AutoCloseable {
  final Process child;final java.io.BufferedReader reader;final java.io.PrintWriter writer;final PairingState pair;
  Fixture() throws Exception {
   String repo=System.getenv("T3_TEST_REPO");assertNotNull(repo);
   child=new ProcessBuilder("C:/Users/hzy/AppData/Local/hermes/node/node.exe",java.nio.file.Path.of(repo,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),java.nio.file.Path.of(repo,"apps/server/tests/fixtures/native-entry-rating-dimension.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
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

 @Test public void g1()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="e1.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
   JSONObject p=f.command(new JSONObject().put("action","packets")).getJSONArray("packets").getJSONObject(0);
   assertEquals(p.getJSONObject("plan").getJSONArray("requiredFlags").toString(),NativeMutationPlan.flags(op(p)).toString());
   NativeMutationPlan.validate(op(p),p.getJSONObject("plan"));stage(l,p);BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,p,"completed");
   assertEquals(p.getString("body"),f.sent().getString(0));JSONObject facts=f.command(new JSONObject().put("action","facts"));
   assertEquals(0,facts.getJSONObject("qualitySlots").getInt("n"));assertEquals(0,facts.getJSONObject("qualityValues").getInt("n"));assertEquals(1,facts.getJSONObject("journals").getInt("n"));
   assertEquals(3,facts.getDouble("filmStars"),0);assertEquals(3.5,facts.getDouble("summaryStars"),0);assertEquals(5,facts.getDouble("selfStars"),0);assertEquals(1,facts.getJSONArray("receipts").length());
   System.out.println("REAL_SQL shared Entry layout delete cascade2 Author2/Film preserved onejournal onereceipt exactbody; raw native retained NOT ACK authority");
  }finally{c.deleteDatabase(name);}
 }
 static void resume(TransferLedger l,JSONObject p)throws Exception{assertTrue(l.resumeOperation(p.getString("body"),"1",p.getJSONObject("plan").toString()));}
 @Test public void g2()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="e2.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
   JSONObject p=f.command(new JSONObject().put("action","packets").put("kind","legacy")).getJSONArray("packets").getJSONObject(0);
   assertFalse(op(p).getJSONObject("payload").has("deletedSlotUids"));assertFalse(op(p).getJSONObject("payload").has("subjectKind"));assertEquals(p.getJSONObject("plan").getJSONArray("requiredFlags").toString(),NativeMutationPlan.flags(op(p)).toString());
   stage(l,p);f.mode(new JSONObject().put("flag","offlineRatingSlotDelete"));BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,p,"completed");assertEquals(1,f.sent().length());
  }finally{c.deleteDatabase(name);}
  int cells=0;for(String flag:new String[]{"offlineMutations","offlineRatingSlotLayout","offlineRatingSlotDelete"})for(boolean absent:new boolean[]{false,true}){
   name="e2-"+(cells++)+".db";c.deleteDatabase(name);
   try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
    JSONObject p=f.command(new JSONObject().put("action","packets")).getJSONArray("packets").getJSONObject(0);stage(l,p);assertEquals(p.getJSONObject("plan").getJSONArray("requiredFlags").toString(),NativeMutationPlan.flags(op(p)).toString());
    f.mode(new JSONObject().put("flag",flag).put("absent",absent));BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,p,"held");assertEquals(0,f.sent().length());
    f.mode(new JSONObject());resume(l,p);BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,p,"completed");assertEquals(p.getString("body"),f.sent().getString(0));
   }finally{c.deleteDatabase(name);}
  }System.out.println("CAP_CELLS 6 absent/false zeroPOST original retained recovery actualSQL; legacy optionalabsence NOT enriched and deletecap NOT universal");
 }
 @Test public void g3()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="e3.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture()){
   JSONObject p=f.command(new JSONObject().put("action","packets")).getJSONArray("packets").getJSONObject(0);String immutable=null;
   try(TransferLedger l=new TransferLedger(c,name)){stage(l,p);f.mode(new JSONObject().put("loss",true));assertFalse(BackgroundTransferWorker.execute(l,f.pair,()->false));phase(l,p,"active");assertEquals(p.getString("body"),f.sent().getString(0));assertEquals(1,f.command(new JSONObject().put("action","counters")).getInt("sqlReceipts"));immutable=f.command(new JSONObject().put("action","facts")).getJSONArray("receipts").toString();}
   try(TransferLedger l=new TransferLedger(c,name)){
    retained(l,p);for(boolean absent:new boolean[]{false,true}){f.mode(new JSONObject().put("flag","offlineRatingSlotDelete").put("absent",absent));BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,p,"held");assertEquals(0,f.sent().length());resume(l,p);}
    f.mode(new JSONObject());BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,p,"completed");assertEquals(p.getString("body"),f.sent().getString(0));JSONObject facts=f.command(new JSONObject().put("action","facts"));assertEquals(1,facts.getJSONArray("receipts").length());assertEquals(1,facts.getJSONObject("journals").getInt("n"));assertEquals(immutable,facts.getJSONArray("receipts").toString());
   }
  }finally{c.deleteDatabase(name);}
  System.out.println("REAL_SQL commit then unusable-response MOCK loss; cold exact UUID/body/hash/client/libepoch/plan; receipts/journal dedup1 NOT socket/OS termination");
 }
 @Test public void g4()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="e4.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
   JSONArray rows=f.command(new JSONObject().put("action","packets").put("kind","chain")).getJSONArray("packets");for(int i=0;i<rows.length();i++)stage(l,rows.getJSONObject(i));
   assertFalse(op(rows.getJSONObject(0)).getJSONObject("payload").has("deletedSlotUids"));for(int i=1;i<3;i++)assertEquals(op(rows.getJSONObject(i-1)).getInt("baseVersion")+1,op(rows.getJSONObject(i)).getInt("baseVersion"));
   f.mode(new JSONObject().put("flag","offlineMutations"));BackgroundTransferWorker.execute(l,f.pair,()->false);assertEquals(0,f.sent().length());for(int i=0;i<rows.length();i++)assertFalse("completed".equals(job(l,rows.getJSONObject(i)).getString("phase")));
   for(int i=0;i<rows.length();i++)if(job(l,rows.getJSONObject(i)).getString("phase").equals("held"))resume(l,rows.getJSONObject(i));
   f.mode(new JSONObject());BackgroundTransferWorker.execute(l,f.pair,()->false);for(int i=0;i<rows.length();i++)phase(l,rows.getJSONObject(i),"completed");
   JSONArray sent=f.sent();assertEquals(4,sent.length());int last=-1;for(int i=0;i<3;i++){int found=-1;for(int j=0;j<sent.length();j++)if(rows.getJSONObject(i).getString("body").equals(sent.getString(j)))found=j;assertTrue(found>last);last=found;}
   assertEquals(3,f.command(new JSONObject().put("action","facts")).getJSONObject("journals").getInt("n"));assertEquals(4,f.command(new JSONObject().put("action","counters")).getInt("sqlReceipts"));
  }finally{c.deleteDatabase(name);}
  name="e4-h.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
   JSONArray rows=f.command(new JSONObject().put("action","packets").put("kind","held")).getJSONArray("packets");for(int i=0;i<rows.length();i++)stage(l,rows.getJSONObject(i));
   f.mode(new JSONObject().put("flag","offlineRatingSlotDelete"));BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,rows.getJSONObject(0),"held");assertFalse(l.dependenciesApplied(id(rows.getJSONObject(1))));phase(l,rows.getJSONObject(2),"completed");assertEquals(1,f.sent().length());
   f.mode(new JSONObject());resume(l,rows.getJSONObject(0));BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,rows.getJSONObject(0),"completed");phase(l,rows.getJSONObject(1),"completed");assertEquals(2,f.sent().length());
  }finally{c.deleteDatabase(name);}
  System.out.println("REAL_SQL pendingdimensioncreate->delete1->delete2 causal bases independentFilm; globaloff allhold; held layout childrefused independentEntry progresses");
 }
 @Test public void g5()throws Exception{
  Context c=RuntimeEnvironment.getApplication();int cell=0;for(String invalid:new String[]{"missing","foreign","invalid"}){
   String name="e5-"+(cell++)+".db";c.deleteDatabase(name);
   try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
    JSONArray rows=f.command(new JSONObject().put("action","packets")).getJSONArray("packets");for(int i=0;i<rows.length();i++)stage(l,rows.getJSONObject(i));
    f.mode(new JSONObject().put("invalid",invalid));BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,rows.getJSONObject(0),"held");assertFalse(l.dependenciesApplied(id(rows.getJSONObject(1))));phase(l,rows.getJSONObject(2),"completed");assertEquals(2,f.sent().length());assertEquals(2,f.command(new JSONObject().put("action","counters")).getInt("sqlReceipts"));
    f.mode(new JSONObject());resume(l,rows.getJSONObject(0));BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,rows.getJSONObject(0),"completed");phase(l,rows.getJSONObject(1),"completed");assertEquals(3,f.command(new JSONObject().put("action","counters")).getInt("sqlReceipts"));
   }finally{c.deleteDatabase(name);}
  }System.out.println("MOCK_INVALID_RESPONSE 3 canonicalSQL valid receipt before fault strict settlement AND dependency rejected independentFilm advances retry recovered dedup");
 }

 @Test public void g6()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="e6.db";c.deleteDatabase(name);
  try(Fixture f=new Fixture();TransferLedger l=new TransferLedger(c,name)){
   JSONArray rows=f.command(new JSONObject().put("action","packets")).getJSONArray("packets");for(int i=0;i<rows.length();i++)stage(l,rows.getJSONObject(i));
   f.mode(new JSONObject().put("conflict",true));BackgroundTransferWorker.execute(l,f.pair,()->false);phase(l,rows.getJSONObject(0),"held");assertFalse(l.dependenciesApplied(id(rows.getJSONObject(1))));phase(l,rows.getJSONObject(2),"completed");assertEquals(2,f.sent().length());assertEquals(2,f.command(new JSONObject().put("action","counters")).getInt("sqlReceipts"));
   JSONObject facts=f.command(new JSONObject().put("action","facts"));assertEquals(1,facts.getJSONObject("qualitySlots").getInt("n"));assertEquals(2,facts.getJSONObject("qualityValues").getInt("n"));boolean conflict=false;JSONArray receipts=facts.getJSONArray("receipts");for(int i=0;i<receipts.length();i++){JSONObject row=receipts.getJSONObject(i);if(id(rows.getJSONObject(0)).equals(row.getString("op_id")))conflict="conflict".equals(new JSONObject(row.getString("result_json")).getString("status"));}assertTrue(conflict);
  }finally{c.deleteDatabase(name);}
  System.out.println("REAL_SQL actual stale-layout conflict held blocks same-owner delete2 independentFilm advances originalbytes retained no mocked valid receipt");
 }

}
