package com.speechless666.t3.spike;

import android.content.Context;
import android.webkit.WebView;
import com.getcapacitor.*;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import java.io.File;
import java.util.concurrent.*;
import static org.junit.Assert.*;

/** Real plugin actions, private captures and native SQLite. Only bridge/authority are test fixtures. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=28, instrumentedPackages={"com.getcapacitor","com.speechless666.t3.spike"}, shadows={NativeStagingInterleavingsJvmTest.PluginShadow.class,
 NativeStagingInterleavingsJvmTest.BridgeShadow.class,NativeStagingInterleavingsJvmTest.VaultShadow.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class NativeStagingInterleavingsJvmTest {
 static Context context;static Bridge bridge;static WebView web;static PairingState pair;
 static final String OP="11111111-1111-4111-8111-111111111111", UP="55555555-5555-4555-8555-555555555555";
 static final String LIB="33333333-3333-4333-8333-333333333333", UID="44444444-4444-4444-8444-444444444444";
 final byte[] bytes={1,2,3};BackgroundTransferPlugin plugin;String body,metadata;
 @Implements(Plugin.class) public static class PluginShadow {
  @Implementation public Context getContext(){return context;}
  @Implementation public Bridge getBridge(){return bridge;}
 }
 @Implements(Bridge.class) public static class BridgeShadow {
  @Implementation public WebView getWebView(){return web;}
  @Implementation public Context getContext(){return context;}
  @Implementation public String getAppUrl(){return "https://localhost/";}
 }
 @Implements(PairingVault.class) public static class VaultShadow {
  @Implementation public PairingState load(){return pair;}
 }
 static class Call extends PluginCall {
  final CountDownLatch done=new CountDownLatch(1);JSObject result;String error;
  Call(JSObject data){super(null,"T3BackgroundTransfer","test","test",data);}
  @Override public void resolve(JSObject value){result=value;done.countDown();}
  @Override public void reject(String message,String code){error=code;done.countDown();}
  void await() throws Exception {assertTrue("Plugin action timed out",done.await(10,TimeUnit.SECONDS));}
 }
 @Before public void setup() throws Exception {
  context=RuntimeEnvironment.getApplication();context.deleteDatabase(BackgroundTransferWorker.DATABASE);
  File dir=new File(context.getFilesDir(),"transfer-staging");if(dir.exists())for(File f:dir.listFiles())f.delete();
  bridge=org.robolectric.shadow.api.Shadow.newInstanceOf(Bridge.class);
  web=new WebView(context);web.loadUrl("https://localhost/");
  pair=PairingState.parse(new JSONObject().put("version",1).put("endpoint","https://192.168.1.2:443").put("certificateSha256","a".repeat(64)).put("libraryId",LIB).put("deviceId",UID).put("token","a".repeat(43)).toString());
  plugin=new BackgroundTransferPlugin();
  body=new JSONObject().put("opId",OP).put("clientId","22222222-2222-4222-8222-222222222222").put("libraryId",LIB).put("syncEpoch","epoch").put("entityKind","entry").put("entityUid",UID).put("operationKind","entry.create").put("payload",new JSONObject().put("title","Original")).toString();
  metadata=new JSONObject().put("libraryId",LIB).put("syncEpoch","epoch").put("entryUid",UID).put("byteLength",3).put("sha256",TransferLedger.sha256(bytes)).put("mimeType","image/png").put("ordinal",0).put("kind","cover").toString();
 }
 @After public void cleanup() throws Exception {
  java.lang.reflect.Field f=BackgroundTransferPlugin.class.getDeclaredField("executor");f.setAccessible(true);((ExecutorService)f.get(plugin)).shutdownNow();
  context.deleteDatabase(BackgroundTransferWorker.DATABASE);
 }
 Call invoke(String method,JSObject data) throws Exception {Call c=new Call(data);BackgroundTransferPlugin.class.getMethod(method,PluginCall.class).invoke(plugin,c);c.await();return c;}
 JSObject data(String... values){JSObject d=new JSObject();for(int i=0;i<values.length;i+=2)d.put(values[i],values[i+1]);return d;}
 String stage(String revision) throws Exception {Call c=invoke("stage",data("body",body,"metadata",metadata,"uploadId",UP,"revision",revision));assertNull(c.error);return c.result.getString("stageId");}
 void chunk(String stage) throws Exception {JSObject d=data("stageId",stage,"body",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP));d.put("offset",0);assertNull(invoke("chunk",d).error);}
 void pause() throws Exception {JSObject d=new JSObject();d.put("opIds",new JSArray().put(OP));assertNull(invoke("pause",d).error);}
 @Test public void cancelBeforeLateChunkAndSealRejectsBothAndNeverResurrects() throws Exception {
  String s=stage("1");pause();JSObject d=data("stageId",s,"body","AQID");d.put("offset",0);
  assertEquals("TRANSFER_PAUSED",invoke("chunk",d).error);assertEquals("TRANSFER_PAUSED",invoke("seal",data("stageId",s)).error);
  assertFalse(new File(context.getFilesDir(),"transfer-staging/"+s+".part").exists());
  try(TransferLedger l=new TransferLedger(context,BackgroundTransferWorker.DATABASE)){assertEquals(0,l.jobs().length());try{l.requireLiveCapture(OP,UP);fail("Missing cancellation tombstone");}catch(SecurityException expected){}}
 }
 @Test public void chunkBeforeCancelThenLateSealCannotPublishCapturedOriginal() throws Exception {
  String s=stage("1");chunk(s);pause();assertEquals("TRANSFER_PAUSED",invoke("seal",data("stageId",s)).error);
  try(TransferLedger l=new TransferLedger(context,BackgroundTransferWorker.DATABASE)){assertEquals(0,l.jobs().length());}
 }
 @Test public void newGenerationSealAndActivationSurviveLateOldSeal() throws Exception {
  String old=stage("1");chunk(old);String current=stage("2");chunk(current);
  assertNull(invoke("seal",data("stageId",current)).error);
  // Initialize actual WorkManager without executing network-constrained work.
  androidx.work.testing.WorkManagerTestInitHelper.initializeTestWorkManager(context,new androidx.work.Configuration.Builder().setExecutor(new androidx.work.testing.SynchronousExecutor()).build());
  assertNull(invoke("activate",data("opId",OP,"revision","2")).error);
  assertEquals("TRANSFER_PAUSED",invoke("seal",data("stageId",old)).error);
  try(TransferLedger l=new TransferLedger(context,BackgroundTransferWorker.DATABASE)){
   try(android.database.Cursor row=l.getReadableDatabase().rawQuery("SELECT revision FROM background_jobs WHERE op_id=?",new String[]{OP})){assertTrue(row.moveToFirst());assertEquals("2",row.getString(0));}
   assertEquals("active",l.jobs().getJSONObject(0).getString("phase"));
   assertArrayEquals(body.getBytes(java.nio.charset.StandardCharsets.UTF_8),l.operationBody(OP));assertArrayEquals(bytes,l.mediaBytes(UP));
  }
 }
}
