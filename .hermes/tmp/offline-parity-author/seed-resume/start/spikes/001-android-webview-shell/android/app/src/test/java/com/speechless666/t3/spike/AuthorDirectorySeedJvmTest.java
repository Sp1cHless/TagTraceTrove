package com.speechless666.t3.spike;
import android.content.Context;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=28) @SQLiteMode(SQLiteMode.Mode.NATIVE)
public class AuthorDirectorySeedJvmTest {
 @Test public void seedFieldPresenceFlagsLegacyBytesAndGeneratedContract() throws Exception {
  try(NativeWorkerAuthorityAcceptanceJvmTest.Fixture f=new NativeWorkerAuthorityAcceptanceJvmTest.Fixture()) {
   JSONObject legacy=NativeWorkerAuthorityAcceptanceJvmTest.row(f,"producer.create");String before=legacy.toString();
   assertFalse(NativeMutationPlan.flags(legacy).toString().contains("offlineStandaloneAuthorDirectorySeed"));
   JSONObject seed=new JSONObject(before);seed.getJSONObject("payload").put("directorySetUid","22222222-2222-4222-8222-222222222222");
   assertTrue(NativeMutationPlan.flags(seed).toString().contains("offlineStandaloneAuthorDirectorySeed"));
   assertEquals("offlineStandaloneAuthorDirectorySeed",new JSONObject(NativeMutationContract.JSON).getJSONObject("producer.create").getJSONObject("fieldFlags").getString("directorySetUid"));
   assertEquals(before,legacy.toString());seed.getJSONObject("payload").put("directorySetUid",JSONObject.NULL);assertTrue(NativeMutationPlan.flags(seed).toString().contains("offlineStandaloneAuthorDirectorySeed"));
  }
 }
 @Test public void productionWorkerSeedFlagAbsentFalseAndEnabledRetainsExactBytes() throws Exception {
  Context c=RuntimeEnvironment.getApplication();try(NativeWorkerAuthorityAcceptanceJvmTest.Fixture f=new NativeWorkerAuthorityAcceptanceJvmTest.Fixture()) {
   for(int variant=0;variant<3;variant++) {
    String name="author-directory-seed-"+variant+".db";c.deleteDatabase(name);
    JSONObject seed=NativeWorkerAuthorityAcceptanceJvmTest.row(f,"producer.create");seed.getJSONObject("payload").put("directorySetUid","22222222-2222-4222-8222-222222222222");
    try(TransferLedger l=new TransferLedger(c,name)) {
     f.mode(variant==2?new JSONObject():new JSONObject().put("flag","offlineStandaloneAuthorDirectorySeed").put("absent",variant==0));NativeWorkerAuthorityAcceptanceJvmTest.stage(l,seed,new JSONArray());assertTrue(BackgroundTransferWorker.execute(l,f.pair,()->false));
     assertEquals(variant==2?"completed":"held",NativeWorkerAuthorityAcceptanceJvmTest.job(l,seed.getString("opId")).getString("phase"));NativeWorkerAuthorityAcceptanceJvmTest.retained(l,seed);assertEquals(variant==2?1:0,f.counters().getJSONArray("mutations").length());
     if(variant==2) assertEquals(seed.toString(),f.counters().getJSONArray("mutations").getString(0));
    }finally{c.deleteDatabase(name);}
   }
  }
 }
}
