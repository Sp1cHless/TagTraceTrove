package com.speechless666.t3.spike;
import org.json.JSONObject;
/** Applied branch of shared syncReplayResultSchema. Never coerces JSON types or scope extras. */
final class AppliedReceipt {
 private static final java.util.Set<String> KEYS=new java.util.HashSet<>(java.util.Arrays.asList("opId","status","resourceVersion","serverSeq","entityId"));
 static boolean valid(JSONObject receipt,String expected) {
  java.util.Iterator<String> keys=receipt.keys();while(keys.hasNext())if(!KEYS.contains(keys.next()))return false;
  Object id=receipt.opt("opId");
  if(!(id instanceof String) || !((String)id).matches("(?i)([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)") || !expected.equalsIgnoreCase((String)id) || !"applied".equals(receipt.opt("status")))return false;
  return integer(receipt.opt("resourceVersion"),1) && integer(receipt.opt("serverSeq"),0) && (!receipt.has("entityId") || integer(receipt.opt("entityId"),1));
 }
 private static boolean integer(Object value,long minimum) {
  if(!(value instanceof Number))return false;
  double number=((Number)value).doubleValue();
  return Double.isFinite(number) && number>=minimum && number<=9007199254740991L && number==Math.rint(number);
 }
 private AppliedReceipt(){}
}
