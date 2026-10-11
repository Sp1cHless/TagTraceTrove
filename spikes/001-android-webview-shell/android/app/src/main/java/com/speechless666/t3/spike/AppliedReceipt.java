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
 /** Actual-kind receipt proof, shared by settlement and retained dependency authority. */
 static boolean valid(JSONObject receipt,JSONObject operation) {
  try {
   String kind=operation.getString("operationKind");
   if(new JSONObject(NativeMutationContract.JSON).optJSONObject(kind)==null)return false;
   if("entry.authors.convert-to-multi".equals(kind))return validConversion(receipt,operation);
   if("entry.merge".equals(kind))return validMerge(receipt,operation);
   String proofKey="collection.delete".equals(kind)?"collectionDeleteJournal":"collection.common-tag.add".equals(kind)?"collectionCommonTag":null;
   if(proofKey==null)return valid(receipt,operation.getString("opId"));
   if(!"collection".equals(operation.opt("entityKind")))return false;
   java.util.Set<String> allowed=new java.util.HashSet<>(KEYS);allowed.add(proofKey);
   if(!keys(receipt,allowed))return false;
   JSONObject generic=new JSONObject(receipt.toString());generic.remove(proofKey);
   if(!valid(generic,operation.getString("opId")) || !integer(receipt.opt("entityId"),1) || !integer(operation.opt("baseVersion"),1)
     || receipt.getLong("resourceVersion")!=operation.getLong("baseVersion")+1)return false;
   java.util.Map<String,Long> expected=new java.util.HashMap<>();
   String root=operation.getString("entityUid").toLowerCase(java.util.Locale.ROOT);
   if(!uuid(root))return false;
   expected.put("collection:"+root,operation.getLong("baseVersion"));
   org.json.JSONArray journal;
   JSONObject base=operation.getJSONObject("baseValues");
   if("collection.delete".equals(kind)) {
    org.json.JSONArray children=base.getJSONArray("children");
    if(children.length()>200)return false;
    for(int i=0;i<children.length();i++)if(!owner(expected,"collection",children.getJSONObject(i)))return false;
    journal=receipt.getJSONArray(proofKey);
   }else {
    JSONObject proof=receipt.getJSONObject(proofKey);
    if(!exact(proof,"tagId","tagUid","entriesAffected","alreadyPresent","skipped","journal"))return false;
    org.json.JSONArray members=base.getJSONArray("members"),types=base.getJSONArray("types");
    if(members.length()>2000)return false;
    int affected=0,present=0,skipped=0;
    for(int i=0;i<members.length();i++) {
     JSONObject member=members.getJSONObject(i);Object has=member.opt("present");if(!(has instanceof Boolean))return false;
     boolean target=false;
     for(int n=0;n<types.length();n++) {
      JSONObject type=types.getJSONObject(n);
      if(member.getString("entryType").equals(type.getString("entryType")) && type.has("facetUid") && !type.isNull("facetUid"))target=true;
     }
     if((Boolean)has)present++;
     else if(target){affected++;if(!owner(expected,"entry",member))return false;}
     else skipped++;
    }
    for(String count:new String[]{"entriesAffected","alreadyPresent","skipped"})if(!integer(proof.opt(count),0))return false;
    if(proof.getLong("entriesAffected")!=affected || proof.getLong("alreadyPresent")!=present || proof.getLong("skipped")!=skipped)return false;
    boolean noTag=proof.isNull("tagId");
    if(noTag!=proof.isNull("tagUid") || affected>0 && noTag)return false;
    if(!noTag && (!integer(proof.opt("tagId"),1) || !uuid(proof.opt("tagUid")) || !proof.getString("tagUid").equalsIgnoreCase(operation.getJSONObject("payload").getString("tagUid"))))return false;
    journal=proof.getJSONArray("journal");
   }
   if(journal.length()!=expected.size() || journal.length()<1 || journal.length()>("collection.delete".equals(kind)?201:2001))return false;
   long maximum=0;boolean rootFound=false;java.util.Set<String> seen=new java.util.HashSet<>();
   for(int i=0;i<journal.length();i++) {
    JSONObject row=journal.getJSONObject(i);boolean deletion="collection.delete".equals(kind);
    if(!(deletion?exact(row,"id","syncUid","resourceVersion","serverSeq"):exact(row,"entityKind","id","syncUid","resourceVersion","serverSeq")))return false;
    String entity=deletion?"collection":row.getString("entityKind");
    if(!uuid(row.opt("syncUid")) || !integer(row.opt("id"),1) || !integer(row.opt("resourceVersion"),1) || !integer(row.opt("serverSeq"),1))return false;
    String uid=row.getString("syncUid").toLowerCase(java.util.Locale.ROOT),key=entity+":"+uid;
    Long version=expected.get(key);
    if(version==null || !seen.add(key) || row.getLong("resourceVersion")!=version+1)return false;
    if("collection".equals(entity) && root.equals(uid)) {
     if(row.getLong("id")!=receipt.getLong("entityId") || deletion && i!=0)return false;
     rootFound=true;
    }
    maximum=Math.max(maximum,row.getLong("serverSeq"));
   }
   return rootFound && maximum==receipt.getLong("serverSeq");
  }catch(org.json.JSONException invalid){return false;}
 }
 /** Actual-kind conversion receipt proof: frozen-author binding, target identity and exact own journal. */
 private static boolean validConversion(JSONObject receipt,JSONObject operation)throws org.json.JSONException {
  java.util.Set<String> allowed=new java.util.HashSet<>(KEYS);
  for(String extra:new String[]{"conversionAuthorIdentities","conversionTargetVersion","conversionJournal","conversion"})allowed.add(extra);
  if(!keys(receipt,allowed) || !integer(receipt.opt("entityId"),1) || !integer(operation.opt("baseVersion"),1))return false;
  JSONObject generic=new JSONObject(receipt.toString());
  for(String extra:new String[]{"conversionAuthorIdentities","conversionTargetVersion","conversionJournal","conversion"})generic.remove(extra);
  if(!valid(generic,operation.getString("opId")))return false;
  org.json.JSONArray authors=operation.getJSONObject("baseValues").getJSONArray("authors");
  Object frozenTarget=operation.getJSONObject("baseValues").opt("target");
  // JSON null parses as the JSONObject.NULL sentinel, never Java null.
  boolean frozen=(Object)frozenTarget!=null && frozenTarget!=JSONObject.NULL;
  String targetUid=operation.getJSONObject("payload").getString("targetUid").toLowerCase(java.util.Locale.ROOT);
  boolean noop=true;java.util.Set<String> authorUids=new java.util.HashSet<>();
  for(int i=0;i<authors.length();i++) {
   JSONObject author=authors.getJSONObject(i);
   if(!uuid(author.opt("producerUid")) || !integer(author.opt("version"),1))return false;
   if(!authorUids.add(author.getString("producerUid").toLowerCase(java.util.Locale.ROOT)))return false;
   if(!author.getString("producerUid").toLowerCase(java.util.Locale.ROOT).equals(targetUid))noop=false;
  }
  if(frozen && !uuid(((JSONObject)frozenTarget).opt("producerUid")))return false;
  org.json.JSONArray identities=receipt.getJSONArray("conversionAuthorIdentities");
  if(identities.length()!=authors.length())return false;
  java.util.Set<String> identityUids=new java.util.HashSet<>();
  for(int i=0;i<identities.length();i++) {
   JSONObject row=identities.getJSONObject(i);
   if(!exact(row,"producerUid","id") || !uuid(row.opt("producerUid")) || !integer(row.opt("id"),1))return false;
   if(!identityUids.add(row.getString("producerUid").toLowerCase(java.util.Locale.ROOT)))return false;
  }
  if(!identityUids.equals(authorUids))return false;
  if(!integer(receipt.opt("conversionTargetVersion"),1))return false;
  JSONObject dto=receipt.getJSONObject("conversion");
  if(dto.getLong("entryId")!=receipt.getLong("entityId") || !integer(dto.opt("multiAuthorId"),1)
    || !"multiple author".equals(dto.getString("multiAuthorName").toLowerCase(java.util.Locale.ROOT)))return false;
  int convertible=0;
  for(int i=0;i<authors.length();i++)if(!authors.getJSONObject(i).getString("producerUid").toLowerCase(java.util.Locale.ROOT).equals(targetUid))convertible++;
  org.json.JSONArray converted=dto.getJSONArray("convertedAuthors");
  if(converted.length()!=convertible)return false;
  for(int i=0;i<converted.length();i++) {
   JSONObject row=converted.getJSONObject(i);
   if(!exact(row,"id","name") || !integer(row.opt("id"),1))return false;
   Object name=row.opt("name");if(!(name instanceof String) || ((String)name).isEmpty())return false;
  }
  org.json.JSONArray journal=receipt.getJSONArray("conversionJournal");
  String entityUid=operation.getString("entityUid").toLowerCase(java.util.Locale.ROOT);
  if(noop) {
   if(journal.length()!=0 || receipt.getLong("resourceVersion")!=operation.getLong("baseVersion"))return false;
   return receipt.getLong("conversionTargetVersion")==(frozen?((JSONObject)frozenTarget).getLong("version"):-1);
  }
  if(journal.length()<1 || journal.length()>20000 || receipt.getLong("resourceVersion")<=operation.getLong("baseVersion"))return false;
  boolean entryUpdate=false;long maximum=0;long targetVersion=-1;
  for(int i=0;i<journal.length();i++) {
   JSONObject row=journal.getJSONObject(i);
   if(!exact(row,"seq","entityKind","entityUid","changeKind","resourceVersion","record"))return false;
   if(!uuid(row.opt("entityUid")) || !integer(row.opt("seq"),1) || !integer(row.opt("resourceVersion"),1))return false;
   String change=row.getString("changeKind");
   if(!"create".equals(change) && !"update".equals(change) && !"delete".equals(change))return false;
   Object record=row.opt("record");if(!((record==null || record==JSONObject.NULL) || record instanceof JSONObject))return false;
   if(i>0 && row.getLong("seq")<=journal.getJSONObject(i-1).getLong("seq"))return false;
   String uid=row.getString("entityUid").toLowerCase(java.util.Locale.ROOT);
   if("entry".equals(row.getString("entityKind")) && uid.equals(entityUid) && "update".equals(change) && row.getLong("resourceVersion")==receipt.getLong("resourceVersion"))entryUpdate=true;
   if("producer".equals(row.getString("entityKind")) && uid.equals(targetUid) && !"delete".equals(change))targetVersion=row.getLong("resourceVersion");
   maximum=Math.max(maximum,row.getLong("seq"));
  }
  if(!entryUpdate || maximum!=receipt.getLong("serverSeq") || targetVersion!=receipt.getLong("conversionTargetVersion"))return false;
  return true;
 }
 /** Actual-kind merge receipt proof: absorbed identity, copied proof and exact own journal. */
 private static boolean validMerge(JSONObject receipt,JSONObject operation)throws org.json.JSONException {
  java.util.Set<String> allowed=new java.util.HashSet<>(KEYS);
  for(String extra:new String[]{"merge","mergeJournal"})allowed.add(extra);
  if(!keys(receipt,allowed) || !integer(receipt.opt("entityId"),1) || !integer(operation.opt("baseVersion"),1))return false;
  JSONObject generic=new JSONObject(receipt.toString());
  for(String extra:new String[]{"merge","mergeJournal"})generic.remove(extra);
  if(!valid(generic,operation.getString("opId")))return false;
  String absorbUid=operation.getJSONObject("payload").getString("absorbUid").toLowerCase(java.util.Locale.ROOT);
  String keepUid=operation.getString("entityUid").toLowerCase(java.util.Locale.ROOT);
  if(!uuid(absorbUid) || absorbUid.equals(keepUid))return false;
  JSONObject merge=receipt.getJSONObject("merge");
  if(!exact(merge,"absorbedUid","copiedTagCount","copiedSourceCount","absorbedVersion"))return false;
  if(!uuid(merge.opt("absorbedUid")) || !merge.getString("absorbedUid").equalsIgnoreCase(operation.getJSONObject("payload").getString("absorbUid")))return false;
  for(String count:new String[]{"copiedTagCount","copiedSourceCount"})if(!integer(merge.opt(count),0))return false;
  if(!integer(merge.opt("absorbedVersion"),1))return false;
  org.json.JSONArray journal=receipt.getJSONArray("mergeJournal");
  if(journal.length()<1 || journal.length()>20000) return false;
  boolean rootUpdate=false;boolean tombstoneRow=false;long maximum=0;
  for(int i=0;i<journal.length();i++) {
   JSONObject row=journal.getJSONObject(i);
   if(!exact(row,"seq","entityKind","entityUid","changeKind","resourceVersion","record"))return false;
   if(!uuid(row.opt("entityUid")) || !integer(row.opt("seq"),1) || !integer(row.opt("resourceVersion"),1))return false;
   String change=row.getString("changeKind");
   if(!"create".equals(change) && !"update".equals(change) && !"delete".equals(change))return false;
   Object record=row.opt("record");if(!((record==null || record==JSONObject.NULL) || record instanceof JSONObject))return false;
   if(i>0 && row.getLong("seq")<=journal.getJSONObject(i-1).getLong("seq"))return false;
   String uid=row.getString("entityUid").toLowerCase(java.util.Locale.ROOT);
   if("entry".equals(row.getString("entityKind")) && uid.equals(keepUid) && "update".equals(change) && row.getLong("resourceVersion")==receipt.getLong("resourceVersion"))rootUpdate=true;
   if("entry".equals(row.getString("entityKind")) && uid.equals(absorbUid) && "delete".equals(change))tombstoneRow=true;
   maximum=Math.max(maximum,row.getLong("seq"));
  }
  return rootUpdate && tombstoneRow && maximum==receipt.getLong("serverSeq");
 }
 private static boolean owner(java.util.Map<String,Long> expected,String kind,JSONObject row)throws org.json.JSONException {
  if(!uuid(row.opt("syncUid")) || !integer(row.opt("syncVersion"),1))return false;
  return expected.put(kind+":"+row.getString("syncUid").toLowerCase(java.util.Locale.ROOT),row.getLong("syncVersion"))==null;
 }
 private static boolean keys(JSONObject object,java.util.Set<String> allowed) {
  java.util.Iterator<String> keys=object.keys();while(keys.hasNext())if(!allowed.contains(keys.next()))return false;return true;
 }
 private static boolean exact(JSONObject object,String... fields) {
  return object.length()==fields.length && keys(object,new java.util.HashSet<>(java.util.Arrays.asList(fields)));
 }
 private static boolean uuid(Object value) {
  return value instanceof String && ((String)value).matches("(?i)([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)");
 }
 private static boolean integer(Object value,long minimum) {
  if(!(value instanceof Number))return false;
  double number=((Number)value).doubleValue();
  return Double.isFinite(number) && number>=minimum && number<=9007199254740991L && number==Math.rint(number);
 }
 private AppliedReceipt(){}
}
