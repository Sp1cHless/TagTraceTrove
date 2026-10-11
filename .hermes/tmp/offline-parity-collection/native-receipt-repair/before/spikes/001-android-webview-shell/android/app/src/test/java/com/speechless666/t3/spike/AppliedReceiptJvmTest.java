package com.speechless666.t3.spike;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class) @Config(sdk=28)
public class AppliedReceiptJvmTest {
 private JSONObject receipt(String id)throws Exception{return new JSONObject().put("opId",id).put("status","applied").put("resourceVersion",1).put("serverSeq",0);}
 @Test public void uuidDomainMatchesSharedUuidIncludingNilAndMax()throws Exception{
  for(String id:new String[]{"11111111-1111-0111-1111-111111111111","11111111-1111-4111-7111-111111111111"})assertFalse(id,AppliedReceipt.valid(receipt(id),id));
  for(String id:new String[]{"11111111-1111-4111-8111-111111111111","00000000-0000-0000-0000-000000000000","ffffffff-ffff-ffff-ffff-ffffffffffff"})assertTrue(id,AppliedReceipt.valid(receipt(id),id));
 }
 @Test public void optionalApiIdIsGenericSafePositiveIntegerWithoutCoercion()throws Exception{
  String id="11111111-1111-4111-8111-111111111111";
  assertTrue(AppliedReceipt.valid(receipt(id),id.toUpperCase()));
  assertTrue(AppliedReceipt.valid(receipt(id).put("entityId",9007199254740991L),id));
  for(Object value:new Object[]{"1",0,-1,1.5,9007199254740992L,JSONObject.NULL})assertFalse(String.valueOf(value),AppliedReceipt.valid(receipt(id).put("entityId",value),id));
 }
}
