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
public class DurationAuthorPlanJvmTest {
 private JSONObject op(String kind,String entity,JSONObject payload)throws Exception{return new JSONObject().put("opId","11111111-1111-4111-8111-111111111111").put("clientId","phone").put("libraryId","33333333-3333-4333-8333-333333333333").put("syncEpoch","epoch").put("entityKind",entity).put("entityUid","44444444-4444-4444-8444-444444444444").put("operationKind",kind).put("baseVersion",1).put("baseValues",new JSONObject()).put("payload",payload).put("clientCreatedAt","2026-10-08");}
 private JSONObject plan(JSONObject op)throws Exception{return new JSONObject().put("version",1).put("eligible",true).put("opId",op.getString("opId")).put("ownerKey",NativeMutationPlan.owner(op)).put("order",0).put("requiredFlags",NativeMutationPlan.flags(op)).put("dependencies",new JSONArray());}
 @Test public void dynamicFlagsMatchForegroundOrderAndLegacyAbsence()throws Exception{
  JSONObject duration=op("entry.create","entry",new JSONObject().put("durationSeconds",0).put("contents",new JSONArray()).put("ratings",new JSONArray().put(new JSONObject().put("slotUid","uid"))));
  assertEquals("[\"offlineMutations\",\"offlineEntryCreate\",\"offlineEntryDuration\",\"offlineEntryInitialContents\",\"offlineRatingSlotLayout\"]",NativeMutationPlan.flags(duration).toString());
  JSONObject self=op("producer.rating.set","producer",new JSONObject().put("subjectKind","author_self"));assertTrue(NativeMutationPlan.flags(self).toString().contains("offlineAuthorSelfRatings"));
  self.getJSONObject("payload").remove("subjectKind");assertFalse(NativeMutationPlan.flags(self).toString().contains("offlineAuthorSelfRatings"));
  JSONObject layout=op("rating-layout.slots.set","rating_layout",new JSONObject().put("subjectKind","author_self").put("deletedSlotUids",new JSONArray()));assertEquals("[\"offlineMutations\",\"offlineRatingSlotLayout\",\"offlineAuthorSelfRatings\",\"offlineRatingSlotDelete\"]",NativeMutationPlan.flags(layout).toString());
 }
 @Test public void extensionCreateCannotUseLegacyUnplannedBypass()throws Exception{
  JSONObject duration=op("entry.create","entry",new JSONObject().put("durationSeconds",JSONObject.NULL));
  try{NativeMutationPlan.validate(duration,null);fail("New field needs immutable current plan");}catch(SecurityException expected){}
  duration.getJSONObject("payload").remove("durationSeconds");assertNull(NativeMutationPlan.validate(duration,null));
 }
 @Test public void coldLedgerRetainsExactOriginalAndRejectsCapabilityStrippedPlan()throws Exception{
  Context c=RuntimeEnvironment.getApplication();String name="duration-author-plan.db";c.deleteDatabase(name);
  JSONObject duration=op("entry.update","entry",new JSONObject().put("durationSeconds",0));String body=duration.toString();JSONObject packet=plan(duration);
  try{
   try(TransferLedger ledger=new TransferLedger(c,name)){JSONObject stripped=new JSONObject(packet.toString());stripped.put("requiredFlags",new JSONArray().put("offlineMutations").put("offlineEntryUpdate"));try{ledger.stagePlannedOperation(body,"1",stripped.toString());fail("Capability stripping must fail");}catch(SecurityException expected){}ledger.stagePlannedOperation(body,"1",packet.toString());}
   try(TransferLedger ledger=new TransferLedger(c,name)){assertArrayEquals(body.getBytes(java.nio.charset.StandardCharsets.UTF_8),ledger.operationBody(duration.getString("opId")));ledger.stagePlannedOperation(body,"2",packet.toString());assertArrayEquals(body.getBytes(java.nio.charset.StandardCharsets.UTF_8),ledger.operationBody(duration.getString("opId")));}
  }finally{c.deleteDatabase(name);}
 }
}
