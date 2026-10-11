package com.speechless666.t3.spike;
import org.json.JSONObject;
import org.json.JSONArray;
/** Current contract is generated from the same source used by the foreground scheduler. */
final class NativeMutationPlan {
 static JSONArray flags(JSONObject op) throws Exception {
  JSONObject shape=new JSONObject(NativeMutationContract.JSON).optJSONObject(op.getString("operationKind"));
  if(shape==null || !shape.getString("entityKind").equals(op.getString("entityKind")))throw new SecurityException("Unknown current mutation retained");
  JSONArray result=new JSONArray(shape.getJSONArray("flags").toString());JSONObject p=op.getJSONObject("payload");String kind=op.getString("operationKind");boolean pending=p.has("parentCreateOpId");
  if(kind.equals("producer.create") && p.has("directorySetUid"))add(result,"offlineStandaloneAuthorDirectorySeed");
  if(kind.equals("author.directories.set") && p.has("producerCreates"))add(result,"offlineStandaloneAuthorDirectorySeed");
  if((kind.equals("entry.update") || kind.equals("entry.create")) && p.has("durationSeconds"))add(result,"offlineEntryDuration");
  if("author_self".equals(p.optString("subjectKind")) || p.has("galleryAnchor"))add(result,"offlineAuthorSelfRatings");
  if(p.has("deletedSlotUids"))add(result,"offlineRatingSlotDelete");
  if(kind.equals("entry.create")){if(p.has("contents"))add(result,"offlineEntryInitialContents");JSONArray rows=p.optJSONArray("ratings");if(rows!=null)for(int n=0;n<rows.length();n++)if(rows.getJSONObject(n).has("slotUid"))add(result,"offlineRatingSlotLayout");}
  if(pending){switch(kind){case "entry.update":add(result,"offlinePendingEntryMetadata");break;case "entry.contents.set":add(result,"offlinePendingEntryContents");break;case "entry.authors.set":add(result,"offlinePendingEntryAuthors");break;case "entry.author.create-and-link":add(result,"offlinePendingEntryAuthorCreate");break;case "entry.tags.set":add(result,"offlinePendingEntryTags");break;}}
  if(kind.equals("entry.authors.set") && nonempty(p,"producerCreates"))add(result,"offlineCrossEntryPendingAuthors");
  if(kind.equals("entry.tags.set")){if(nonempty(p,"tagCreates")){add(result,"offlineEntryTagVocabulary");if(pending)add(result,"offlinePendingEntryTagCreation");}if(nonempty(p,"facetCreates"))add(result,"offlineEntryFacetCreate");}
  return result;
 }
 static boolean nonempty(JSONObject object,String key){JSONArray a=object.optJSONArray(key);return a!=null && a.length()>0;}
 static void add(JSONArray flags,String flag){for(int n=0;n<flags.length();n++)if(flag.equals(flags.optString(n)))return;flags.put(flag);}
 static String owner(JSONObject op) throws Exception{return op.getString("entityKind")+":"+op.getString("entityUid").toLowerCase(java.util.Locale.ROOT);}
 static JSONObject validate(JSONObject op,JSONObject plan) throws Exception {
  JSONArray flags=flags(op);
  if(plan==null){if(!"entry.create".equals(op.getString("operationKind")) || op.getJSONObject("payload").has("durationSeconds"))throw new SecurityException("Current mutation needs current scheduling packet");return null;}
  if(plan.getInt("version")!=1 || !plan.getBoolean("eligible") || !plan.getString("opId").equals(op.getString("opId")) || !plan.getString("ownerKey").equals(owner(op)) || plan.getInt("order")<0 || !plan.getJSONArray("requiredFlags").toString().equals(flags.toString()))throw new SecurityException("Invalid immutable plan");
  JSONArray deps=plan.getJSONArray("dependencies");JSONObject p=op.getJSONObject("payload");
  if(p.has("parentCreateOpId"))require(deps,p.getString("parentCreateOpId"));
  for(String key:new String[]{"producerCreates","tagCreates","facetCreates"}){JSONArray rows=p.optJSONArray(key);if(rows!=null)for(int n=0;n<rows.length();n++)require(deps,rows.getJSONObject(n).getString("createOpId"));}
  return plan;
 }
 static void require(JSONArray deps,String id){for(int n=0;n<deps.length();n++)if(id.equalsIgnoreCase(deps.optString(n)))return;throw new SecurityException("Missing original dependency");}
}
