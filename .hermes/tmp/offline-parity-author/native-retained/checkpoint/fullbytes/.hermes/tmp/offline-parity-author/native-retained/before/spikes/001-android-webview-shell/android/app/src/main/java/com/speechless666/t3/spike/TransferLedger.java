package com.speechless666.t3.spike;

import android.content.Context;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteOpenHelper;
import android.database.sqlite.SQLiteDatabase;
import java.util.Arrays;

/** App-private transfer mirror, never an authority for deleting IndexedDB work.
 * Entry + one original image jobs are wired through bounded handoff and WorkManager.
 * Canonical user data and cleanup authority remain in the existing foreground flow.
 */
public final class TransferLedger extends SQLiteOpenHelper {
    private static final int MAX_BODY = 1024 * 1024;
    private static final int MAX_MEDIA = 32 * 1024 * 1024;
    public TransferLedger(Context context, String name) { super(context, name, null, 7); }
    @Override public void onConfigure(SQLiteDatabase db) { db.setForeignKeyConstraintsEnabled(true); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE operations (op_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, library_id TEXT NOT NULL, epoch TEXT NOT NULL, body BLOB NOT NULL, body_hash TEXT NOT NULL, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, result BLOB)");
        db.execSQL("CREATE TABLE media (upload_id TEXT PRIMARY KEY, op_id TEXT NOT NULL REFERENCES operations(op_id), bytes BLOB NOT NULL, hash TEXT NOT NULL, mime TEXT NOT NULL)");
        createJobs(db); createUploads(db); createStandalone(db); createPlans(db); createAttemptSeals(db);
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion == 1) { createJobs(db); oldVersion = 3; }
        if (oldVersion == 2) {
            db.execSQL("ALTER TABLE background_jobs RENAME TO background_jobs_v2");
            createJobs(db);
            db.execSQL("INSERT INTO background_jobs SELECT * FROM background_jobs_v2 ORDER BY rowid");
            db.execSQL("DROP TABLE background_jobs_v2");
            oldVersion = 3;
        }
        if (oldVersion == 3) { createUploads(db);oldVersion=4; }
        if (oldVersion == 4) { createStandalone(db); oldVersion=5; }
        if (oldVersion == 5) { createPlans(db);oldVersion=6; }
        if (oldVersion == 6) {
            createAttemptSeals(db);
            // Old mirrors have no durable claim history, including previously pruned IDs.
            db.execSQL("INSERT OR IGNORE INTO upload_attempt_seals SELECT upload_id FROM standalone_media");
            db.execSQL("INSERT OR IGNORE INTO upload_attempt_seals SELECT upload_id FROM media");
            db.execSQL("INSERT OR IGNORE INTO upload_attempt_seals SELECT id FROM transfer_tombstones");
            oldVersion=7;
        }
        if (oldVersion == newVersion) return;
        throw new IllegalStateException("Unsupported transfer ledger version; retain work");
    }
    public void mirror(String client, String library, String epoch, String opId, byte[] body,
        String uploadId, byte[] bytes, String hash, String mime) {
        requireText(client); requireText(library); requireText(epoch); requireText(opId); requireText(uploadId);
        if (body == null || body.length == 0 || body.length > MAX_BODY || bytes == null || bytes.length == 0
            || bytes.length > MAX_MEDIA || !digest(bytes).equals(hash)
            || mime == null || !mime.matches("image/(avif|gif|jpeg|png|webp)"))
            throw new IllegalArgumentException("Transfer payload invalid; canonical work unchanged");
        // Clone before transaction so callers cannot mutate captured bytes during validation/write.
        byte[] capturedBody = body.clone(), capturedMedia = bytes.clone();
        if (!digest(capturedMedia).equals(hash)) throw new IllegalArgumentException("Media changed during capture");
        SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
        try {
            try (Cursor row = db.rawQuery("SELECT client_id,library_id,epoch,body FROM operations WHERE op_id=?", new String[]{opId})) {
                if (row.moveToFirst()) {
                    if (!client.equals(row.getString(0)) || !library.equals(row.getString(1)) || !epoch.equals(row.getString(2))
                        || !Arrays.equals(capturedBody, row.getBlob(3))) throw new IllegalArgumentException("Immutable operation collision");
                } else {
                    rejectTombstone(db,opId);
                    ContentValues values = new ContentValues(); values.put("op_id",opId); values.put("client_id",client);
                    values.put("library_id",library); values.put("epoch",epoch); values.put("body",capturedBody);
                    values.put("body_hash",digest(capturedBody)); db.insertOrThrow("operations",null,values);
                }
            }
            try (Cursor row = db.rawQuery("SELECT op_id,bytes,hash,mime FROM media WHERE upload_id=?",new String[]{uploadId})) {
                if (row.moveToFirst()) {
                    if (!opId.equals(row.getString(0)) || !Arrays.equals(capturedMedia,row.getBlob(1))
                        || !hash.equals(row.getString(2)) || !mime.equals(row.getString(3))) throw new IllegalArgumentException("Immutable upload collision");
                } else {
                    ContentValues values = new ContentValues(); values.put("upload_id",uploadId); values.put("op_id",opId);
                    values.put("bytes",capturedMedia); values.put("hash",hash); values.put("mime",mime); db.insertOrThrow("media",null,values);
                }
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }
    /** A single SQL conditional update serializes separate handles/processes. */
    public boolean claim(String opId, String workerId, long now, long leaseMillis) {
        requireText(workerId);
        if (now < 0 || leaseMillis <= 0 || leaseMillis > 600000 || now > Long.MAX_VALUE - leaseMillis)
            throw new IllegalArgumentException("Invalid finite lease");
        ContentValues values = new ContentValues(); values.put("lease_owner",workerId); values.put("lease_until",now+leaseMillis);
        return getWritableDatabase().update("operations",values,
            "op_id=? AND result IS NULL AND lease_until<=?",new String[]{opId,Long.toString(now)}) == 1;
    }
    /** Raw response retained for typed foreground validation. This is NOT a cleanup or ACK. */
    public boolean recordResult(String opId, String workerId, byte[] originalBody, byte[] result) {
        return recordResult(opId,workerId,originalBody,result,System.currentTimeMillis());
    }
    public boolean recordResult(String opId,String workerId,byte[] originalBody,byte[] result,long now) {
        requireText(workerId);
        if (originalBody == null || result == null || result.length == 0 || result.length > MAX_BODY)
            throw new IllegalArgumentException("Invalid transfer result");
        ContentValues values = new ContentValues(); values.put("result",result.clone());
        values.putNull("lease_owner"); values.put("lease_until",0);
        return getWritableDatabase().update("operations",values,
            "op_id=? AND lease_owner=? AND body_hash=? AND result IS NULL AND lease_until>?",
            new String[]{opId,workerId,digest(originalBody),Long.toString(now)}) == 1;
    }
    public byte[] operationResult(String opId) { return readBytes("operations","result","op_id",opId); }
    private static void createPlans(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE mutation_plans (op_id TEXT PRIMARY KEY REFERENCES operations(op_id), plan TEXT NOT NULL)");
    }
    public void attachPlan(String body,String serialized) throws Exception {
        org.json.JSONObject op=new org.json.JSONObject(body),plan=new org.json.JSONObject(serialized);NativeMutationPlan.validate(op,plan);
        String id=op.getString("opId");SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            if(!Arrays.equals(body.getBytes(java.nio.charset.StandardCharsets.UTF_8),operationBody(id)))throw new SecurityException("Plan body collision");
            try(Cursor c=db.rawQuery("SELECT plan FROM mutation_plans WHERE op_id=?",new String[]{id})) {
                if(c.moveToFirst()){if(!serialized.equals(c.getString(0)))throw new SecurityException("Immutable scheduling plan collision");}
                else{ContentValues v=new ContentValues();v.put("op_id",id);v.put("plan",serialized);db.insertOrThrow("mutation_plans",null,v);}
            }db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    public org.json.JSONObject plan(String id) throws Exception {
        try(Cursor c=getReadableDatabase().rawQuery("SELECT plan FROM mutation_plans WHERE op_id=?",new String[]{id})){return c.moveToFirst()?new org.json.JSONObject(c.getString(0)):null;}
    }
    public boolean dependenciesApplied(String id) throws Exception {
        org.json.JSONObject plan=plan(id);if(plan==null)return true;
        org.json.JSONArray deps=plan.getJSONArray("dependencies");
        for(int n=0;n<deps.length();n++)try(Cursor c=getReadableDatabase().rawQuery("SELECT phase,replay FROM background_jobs WHERE op_id=?",new String[]{deps.getString(n)})) {
            if(!c.moveToFirst() || !"completed".equals(c.getString(0)) || c.isNull(1))return false;
            try {
                org.json.JSONObject receipt=new org.json.JSONObject(new String(c.getBlob(1),java.nio.charset.StandardCharsets.UTF_8));
                if(!AppliedReceipt.valid(receipt,deps.getString(n)))return false;
            } catch(org.json.JSONException invalid){return false;}
        }return true;
    }
    private static void createUploads(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE background_uploads (upload_id TEXT PRIMARY KEY REFERENCES media(upload_id), op_id TEXT NOT NULL REFERENCES operations(op_id), metadata TEXT NOT NULL, flags TEXT NOT NULL)");
    }
    public org.json.JSONArray images(String id) throws Exception {
        org.json.JSONArray result=new org.json.JSONArray();
        try(Cursor c=getReadableDatabase().rawQuery("SELECT upload_id,metadata,flags FROM background_jobs WHERE op_id=? AND upload_id IS NOT NULL UNION ALL SELECT upload_id,metadata,flags FROM background_uploads WHERE op_id=?",new String[]{id,id})) {
            while(c.moveToNext())result.put(new org.json.JSONObject().put("uploadId",c.getString(0)).put("metadata",new org.json.JSONObject(c.getString(1))).put("flags",new org.json.JSONArray(c.getString(2))));
        }
        java.util.List<org.json.JSONObject> sorted=new java.util.ArrayList<>();
        for(int i=0;i<result.length();i++)sorted.add(result.getJSONObject(i));
        sorted.sort((a,b)-> {
            org.json.JSONObject left=a.optJSONObject("metadata"),right=b.optJSONObject("metadata");
            int kind=Boolean.compare(!"cover".equals(left.optString("kind")),!"cover".equals(right.optString("kind")));
            return kind!=0?kind:Integer.compare(left.optInt("ordinal"),right.optInt("ordinal"));
        });
        return new org.json.JSONArray(sorted);
    }
    private static void createJobs(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE background_jobs (op_id TEXT PRIMARY KEY REFERENCES operations(op_id), upload_id TEXT REFERENCES media(upload_id), metadata TEXT, flags TEXT NOT NULL, revision TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'staged', owner TEXT, expires INTEGER NOT NULL DEFAULT 0, replay BLOB, media_result BLOB, error TEXT)");
    }
    public void stage(String body, String uploadId, String metadata, String flags, String revision, byte[] bytes) throws Exception {
        if (uploadId == null && metadata == null) { stageOperation(body,flags,revision,bytes); return; }
        org.json.JSONObject op = new org.json.JSONObject(body), image = new org.json.JSONObject(metadata);
        String id = op.getString("opId");
        if (!"entry.create".equals(op.getString("operationKind")) || !"entry".equals(op.getString("entityKind"))
            || !op.getString("entityUid").equalsIgnoreCase(image.getString("entryUid"))
            || !op.getString("libraryId").equals(image.getString("libraryId")) || !op.getString("syncEpoch").equals(image.getString("syncEpoch"))
            || bytes.length != image.getInt("byteLength")) throw new SecurityException("Unsupported or foreign transfer shape");
        SQLiteDatabase db=getWritableDatabase(); db.beginTransaction();
        try {
            mirror(op.getString("clientId"),op.getString("libraryId"),op.getString("syncEpoch"),id,body.getBytes(java.nio.charset.StandardCharsets.UTF_8),uploadId,bytes,image.getString("sha256"),image.getString("mimeType"));
            try(Cursor row=db.rawQuery("SELECT upload_id,metadata,flags,revision,phase FROM background_jobs WHERE op_id=?",new String[]{id})) {
                if(row.moveToFirst()) {
                    restageRevision(db,id,revision);
                    if(uploadId.equals(row.getString(0))) {
                        if(!metadata.equals(row.getString(1)) || !flags.equals(row.getString(2)))throw new SecurityException("Immutable job collision");
                    } else {
                        try(Cursor imageRow=db.rawQuery("SELECT op_id,metadata,flags FROM background_uploads WHERE upload_id=?",new String[]{uploadId})) {
                            if(imageRow.moveToFirst()) {if(!id.equals(imageRow.getString(0)) || !metadata.equals(imageRow.getString(1)) || !flags.equals(imageRow.getString(2)))throw new SecurityException("Immutable upload metadata collision");}
                            else {
                                if(!"staged".equals(row.getString(4)))throw new SecurityException("Active job cannot acquire new media");
                                ContentValues v=new ContentValues();v.put("upload_id",uploadId);v.put("op_id",id);v.put("metadata",metadata);v.put("flags",flags);db.insertOrThrow("background_uploads",null,v);
                            }
                        }
                    }
                } else {
                    ContentValues v=new ContentValues(); v.put("op_id",id);v.put("upload_id",uploadId);v.put("metadata",metadata);v.put("flags",flags);v.put("revision",revision); db.insertOrThrow("background_jobs",null,v);
                }
            }
            db.setTransactionSuccessful();
        } finally {db.endTransaction();}
    }
    private void stageOperation(String body,String flags,String revision,byte[] bytes) throws Exception {
        org.json.JSONObject op=new org.json.JSONObject(body);
        String id=op.getString("opId");byte[] original=body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        NativeMutationPlan.flags(op);
        if (original.length==0 || original.length>MAX_BODY || bytes==null || bytes.length!=0)
            throw new SecurityException("Unsupported operation-only transfer");
        requireText(id); requireText(op.getString("clientId"));requireText(op.getString("libraryId"));requireText(op.getString("syncEpoch"));requireText(revision);
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            try(Cursor c=db.rawQuery("SELECT body FROM operations WHERE op_id=?",new String[]{id})) {
                if(c.moveToFirst()) {if(!Arrays.equals(original,c.getBlob(0)))throw new SecurityException("Immutable operation collision");}
                else {rejectTombstone(db,id);ContentValues v=new ContentValues();v.put("op_id",id);v.put("client_id",op.getString("clientId"));v.put("library_id",op.getString("libraryId"));v.put("epoch",op.getString("syncEpoch"));v.put("body",original);v.put("body_hash",digest(original));db.insertOrThrow("operations",null,v);}
            }
            try(Cursor c=db.rawQuery("SELECT upload_id,flags,revision FROM background_jobs WHERE op_id=?",new String[]{id})) {
                if(c.moveToFirst()) {if(!c.isNull(0) || !flags.equals(c.getString(1)))throw new SecurityException("Immutable job collision");restageRevision(db,id,revision);}
                else {ContentValues v=new ContentValues();v.put("op_id",id);v.put("flags",flags);v.put("revision",revision);db.insertOrThrow("background_jobs",null,v);}
            }
            db.setTransactionSuccessful();
        } finally {db.endTransaction();}
    }
    public void stagePlannedOperation(String body,String revision,String serialized) throws Exception {
        org.json.JSONObject op=new org.json.JSONObject(body),plan=new org.json.JSONObject(serialized);NativeMutationPlan.validate(op,plan);
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try{stageOperation(body,NativeMutationPlan.flags(op).toString(),revision,new byte[0]);attachPlan(body,serialized);db.setTransactionSuccessful();}finally{db.endTransaction();}
    }
    private static void rejectTombstone(SQLiteDatabase db,String id) {
        try(Cursor c=db.rawQuery("SELECT id FROM transfer_tombstones WHERE id=?",new String[]{id})){if(c.moveToFirst())throw new SecurityException("Discarded original cannot be restaged");}
    }
    private static void restageRevision(SQLiteDatabase db,String id,String revision) {
        requireText(revision);
        try(Cursor c=db.rawQuery("SELECT revision,owner FROM background_jobs WHERE op_id=?",new String[]{id})){
            if(c.moveToFirst() && !revision.equals(c.getString(0))){
                if(!c.isNull(1))throw new SecurityException("In-flight generation cannot be restaged");
                if(revision.matches("[0-9]+") && c.getString(0).matches("[0-9]+") && new java.math.BigInteger(revision).compareTo(new java.math.BigInteger(c.getString(0)))<0)throw new SecurityException("Stale canonical generation");
                ContentValues v=new ContentValues();v.put("revision",revision);db.update("background_jobs",v,"op_id=? AND owner IS NULL",new String[]{id});
            }
        }
    }
    public void requireLiveCapture(String operationId,String uploadId) {
        SQLiteDatabase db=getReadableDatabase();
        if(operationId!=null && operationBody(operationId)==null)rejectTombstone(db,operationId);
        if(uploadId!=null && mediaBytes(uploadId)==null && standaloneBytes(uploadId)==null)rejectTombstone(db,uploadId);
    }
    public boolean resumeOperation(String body,String revision,String serialized) throws Exception {
        org.json.JSONObject op=new org.json.JSONObject(body);NativeMutationPlan.validate(op,new org.json.JSONObject(serialized));
        String id=op.getString("opId");
        if(!Arrays.equals(body.getBytes(java.nio.charset.StandardCharsets.UTF_8),operationBody(id)))return false;
        try(Cursor c=getReadableDatabase().rawQuery("SELECT replay FROM background_jobs WHERE op_id=?",new String[]{id})) {
            if(c.moveToFirst() && !c.isNull(0))try{if(!"applied".equals(new org.json.JSONObject(new String(c.getBlob(0),java.nio.charset.StandardCharsets.UTF_8)).optString("status")))return false;}catch(org.json.JSONException invalid){return false;}
        }
        org.json.JSONObject original=plan(id);if(original==null || !original.toString().equals(new org.json.JSONObject(serialized).toString()))return false;
        ContentValues v=new ContentValues();v.put("phase","active");v.putNull("error");
        return getWritableDatabase().update("background_jobs",v,"op_id=? AND revision=? AND owner IS NULL AND phase IN ('held','cancelled')",new String[]{id,revision})==1;
    }
    public boolean activate(String id,String revision) {
        ContentValues v=new ContentValues();v.put("phase","active");
        return getWritableDatabase().update("background_jobs",v,"op_id=? AND revision=? AND phase='staged'",new String[]{id,revision})==1;
    }
    public org.json.JSONArray jobs() throws Exception {
        org.json.JSONArray result=new org.json.JSONArray();
        try(Cursor c=getReadableDatabase().rawQuery("SELECT op_id,upload_id,metadata,flags,phase,replay,media_result,error FROM background_jobs ORDER BY rowid",null)) {
            while(c.moveToNext()) result.put(new org.json.JSONObject().put("opId",c.getString(0)).put("uploadId",c.isNull(1)?org.json.JSONObject.NULL:c.getString(1)).put("metadata",c.isNull(2)?org.json.JSONObject.NULL:new org.json.JSONObject(c.getString(2))).put("flags",new org.json.JSONArray(c.getString(3))).put("phase",c.getString(4)).put("replay",c.isNull(5)?org.json.JSONObject.NULL:new String(c.getBlob(5),java.nio.charset.StandardCharsets.UTF_8)).put("mediaResult",c.isNull(6)?org.json.JSONObject.NULL:new String(c.getBlob(6),java.nio.charset.StandardCharsets.UTF_8)).put("error",c.isNull(7)?org.json.JSONObject.NULL:c.getString(7)));
        } return result;
    }
    public boolean claimJob(String id,String owner,long now) {
        ContentValues v=new ContentValues();v.put("owner",owner);v.put("expires",now+120000);
        return getWritableDatabase().update("background_jobs",v,"op_id=? AND phase='active' AND expires<=?",new String[]{id,Long.toString(now)})==1;
    }
    public boolean renewJob(String id,String owner,long now) {
        ContentValues v=new ContentValues();v.put("expires",now+120000);
        return getWritableDatabase().update("background_jobs",v,"op_id=? AND owner=? AND expires>? AND phase='active'",new String[]{id,owner,Long.toString(now)})==1;
    }
    public boolean finishJob(String id,String owner,byte[] body,String phase,byte[] replay,byte[] media,String error,long now) {
        ContentValues v=new ContentValues();v.put("phase",phase);v.put("replay",replay);v.put("media_result",media);v.put("error",error);v.putNull("owner");v.put("expires",0);
        return getWritableDatabase().update("background_jobs",v,"op_id=? AND owner=? AND expires>? AND EXISTS (SELECT 1 FROM operations WHERE operations.op_id=background_jobs.op_id AND body_hash=?)",new String[]{id,owner,Long.toString(now),digest(body)})==1;
    }
    /** Cancel BEFORE canonical discard/foreground replay; refuse an in-flight request even after lease expiry. */
    public void pause(org.json.JSONArray ids) throws Exception {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            for(int i=0;i<jobs().length();i++) {
                org.json.JSONObject job=jobs().getJSONObject(i);String id=job.getString("opId");
                boolean selected=ids==null;
                if(ids!=null) for(int n=0;n<ids.length();n++) if(id.equals(ids.getString(n))) selected=true;
                if(!selected) continue;
                try(Cursor c=db.rawQuery("SELECT owner FROM background_jobs WHERE op_id=?",new String[]{id})) {if(c.moveToFirst() && !c.isNull(0)) throw new IllegalStateException("Native transfer in flight; wait for receipt and sync before discarding");}
                ContentValues v=new ContentValues();v.put("phase","cancelled");db.update("background_jobs",v,"op_id=? AND phase != 'completed'",new String[]{id});
            }
            if(ids!=null)for(int n=0;n<ids.length();n++) {
                String id=ids.getString(n);requireText(id);
                try(Cursor c=db.rawQuery("SELECT op_id FROM background_jobs WHERE op_id=?",new String[]{id})) {
                    if(!c.moveToFirst()){ContentValues v=new ContentValues();v.put("id",id);db.insertWithOnConflict("transfer_tombstones",null,v,SQLiteDatabase.CONFLICT_IGNORE);}
                }
            }
            pauseStandaloneMedia(null);
            db.setTransactionSuccessful();
        } finally {db.endTransaction();}
    }
    /** Only foreground, after existing typed receipt/snapshot/ACK cleanup, supplies absent source IDs. */
    public void pruneCancelled(org.json.JSONArray live,org.json.JSONArray uploads) throws Exception {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            org.json.JSONArray jobs=jobs();
            for(int i=0;i<jobs.length();i++) {
                org.json.JSONObject job=jobs.getJSONObject(i);String id=job.getString("opId");boolean exists=false;
                for(int n=0;n<live.length();n++)if(id.equals(live.getString(n)))exists=true;
                if(uploads!=null)for(int n=0;n<uploads.length();n++)if(job.optString("uploadId").equals(uploads.getString(n)))exists=true;
                org.json.JSONArray images=images(id);
                if(uploads!=null)for(int n=0;n<uploads.length();n++)for(int k=0;k<images.length();k++)if(images.getJSONObject(k).getString("uploadId").equals(uploads.getString(n)))exists=true;
                if(exists || !("cancelled".equals(job.getString("phase")) || "completed".equals(job.getString("phase"))))continue;
                if(db.delete("background_jobs","op_id=? AND owner IS NULL AND phase IN ('cancelled','completed')",new String[]{id})==1){
                    ContentValues tombstone=new ContentValues();tombstone.put("id",id);db.insertWithOnConflict("transfer_tombstones",null,tombstone,SQLiteDatabase.CONFLICT_IGNORE);
                    for(int n=0;n<images.length();n++)db.delete("upload_progress","upload_id=?",new String[]{images.getJSONObject(n).getString("uploadId")});
                    db.delete("mutation_plans","op_id=?",new String[]{id});
                    db.delete("background_uploads","op_id=?",new String[]{id});db.delete("media","op_id=?",new String[]{id});db.delete("operations","op_id=?",new String[]{id});
                }
            }
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    private static void createAttemptSeals(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE upload_attempt_seals (upload_id TEXT PRIMARY KEY)");
        db.execSQL("CREATE TABLE foreground_only_uploads (upload_id TEXT PRIMARY KEY)");
        db.execSQL("CREATE TABLE native_fresh_uploads (upload_id TEXT PRIMARY KEY)");
    }
    /** Mint at the real enqueue caller, not at restore/handoff. Never prune issuance or seals. */
    public String allocateUploadId() {
        String id=java.util.UUID.randomUUID().toString();ContentValues row=new ContentValues();row.put("upload_id",id);
        getWritableDatabase().insertOrThrow("native_fresh_uploads",null,row);return id;
    }
    public org.json.JSONArray foregroundOnlyUploads() {
        org.json.JSONArray ids=new org.json.JSONArray();
        try(Cursor c=getReadableDatabase().rawQuery("SELECT upload_id FROM foreground_only_uploads",null)){while(c.moveToNext())ids.put(c.getString(0));}return ids;
    }
    /** Eligibility only; cancellation rechecks under the same write transaction as tombstoning. */
    public boolean previewNeverAttempted(org.json.JSONArray uploads) throws Exception {
        if(uploads==null || uploads.length()==0 || uploads.length()>32)return false;
        SQLiteDatabase db=getReadableDatabase();
        for(int i=0;i<uploads.length();i++) {
            org.json.JSONObject row=uploads.getJSONObject(i);String id=row.getString("uploadId"),original=row.getString("metadata");
            org.json.JSONObject image=new org.json.JSONObject(original);
            try(Cursor issued=db.rawQuery("SELECT upload_id FROM native_fresh_uploads WHERE upload_id=?",new String[]{id})){if(!issued.moveToFirst())return false;}
            if(!id.matches("[a-fA-F0-9-]{36}") || !"preview".equals(image.getString("kind")) || !image.has("existingEntry"))return false;
            try(Cursor c=db.rawQuery("SELECT upload_id FROM upload_attempt_seals WHERE upload_id=? UNION SELECT upload_id FROM media WHERE upload_id=?",new String[]{id,id})){if(c.moveToFirst())return false;}
            try(Cursor c=db.rawQuery("SELECT metadata,owner,result FROM standalone_media WHERE upload_id=?",new String[]{id})) {
                if(c.moveToFirst() && (!original.equals(c.getString(0)) || !c.isNull(1) || !c.isNull(2)))return false;
            }
        }return true;
    }
    /** Release ONLY unclaimed mirrors. All survivors now use foreground verification/replay.
     * Durable tombstones forbid stale captures/resume, including after IDB commit failure. */
    public void releaseNeverAttemptedPreviews(org.json.JSONArray uploads) throws Exception {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try {
            if(!previewNeverAttempted(uploads))throw new SecurityException("Native upload attempted or uncertain; retain exact original");
            for(int i=0;i<uploads.length();i++) {
                String id=uploads.getJSONObject(i).getString("uploadId");
                ContentValues tombstone=new ContentValues();tombstone.put("id",id);db.insertWithOnConflict("transfer_tombstones",null,tombstone,SQLiteDatabase.CONFLICT_IGNORE);
                ContentValues release=new ContentValues();release.put("upload_id",id);db.insertWithOnConflict("foreground_only_uploads",null,release,SQLiteDatabase.CONFLICT_IGNORE);
                db.delete("standalone_media","upload_id=? AND owner IS NULL",new String[]{id});
            }
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    private static void createStandalone(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE standalone_media (upload_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, metadata TEXT NOT NULL, flags TEXT NOT NULL, revision TEXT NOT NULL, bytes BLOB NOT NULL, phase TEXT NOT NULL DEFAULT 'staged', owner TEXT, expires INTEGER NOT NULL DEFAULT 0, result BLOB, error TEXT)");
        db.execSQL("CREATE TABLE upload_progress (upload_id TEXT PRIMARY KEY, result BLOB NOT NULL)");
        db.execSQL("CREATE TABLE transfer_tombstones (id TEXT PRIMARY KEY)");
    }
    public void stageStandaloneMedia(String client,String upload,String metadata,String flags,String revision,byte[] bytes) throws Exception {
        requireText(client);requireText(upload);requireText(revision);
        org.json.JSONObject image=new org.json.JSONObject(metadata);
        org.json.JSONObject expected=image.getJSONObject("existingEntry");
        if(!upload.matches("[a-fA-F0-9-]{36}") || !image.getString("entryUid").matches("[a-fA-F0-9-]{36}")
            || !image.getString("libraryId").matches("[a-fA-F0-9-]{36}") || image.getString("syncEpoch").isEmpty()
            || !expected.has("expectedCoverRef") || expected.getJSONArray("expectedPreviewRefs").length()>32
            || !("cover".equals(image.getString("kind")) || "preview".equals(image.getString("kind")))
            || image.getInt("ordinal")<0 || image.getInt("ordinal")>31
            || bytes==null || bytes.length==0 || bytes.length>20*1024*1024 || bytes.length!=image.getInt("byteLength")
            || !digest(bytes).equals(image.getString("sha256")) || !image.getString("mimeType").matches("image/(avif|gif|jpeg|png|webp)"))throw new SecurityException("Invalid existing Entry original");
        byte[] original=bytes.clone();SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            try(Cursor c=db.rawQuery("SELECT client_id,metadata,flags,revision,bytes,owner FROM standalone_media WHERE upload_id=?",new String[]{upload})) {
                if(c.moveToFirst()) {
                    if(!client.equals(c.getString(0)) || !metadata.equals(c.getString(1)) || !flags.equals(c.getString(2)) || !Arrays.equals(original,c.getBlob(4)))throw new SecurityException("Immutable standalone collision");
                    if(!revision.equals(c.getString(3))) {
                        if(!c.isNull(5) || !revision.matches("[0-9]+") || !c.getString(3).matches("[0-9]+") || new java.math.BigInteger(revision).compareTo(new java.math.BigInteger(c.getString(3)))<0)throw new SecurityException("Stale or in-flight standalone generation");
                        ContentValues v=new ContentValues();v.put("revision",revision);db.update("standalone_media",v,"upload_id=? AND owner IS NULL",new String[]{upload});
                    }
                } else {
                    try(Cursor cancelled=db.rawQuery("SELECT id FROM transfer_tombstones WHERE id=?",new String[]{upload})) {if(cancelled.moveToFirst())throw new SecurityException("Cancelled generation cannot be restaged");}
                    ContentValues v=new ContentValues();v.put("upload_id",upload);v.put("client_id",client);v.put("metadata",metadata);v.put("flags",flags);v.put("revision",revision);v.put("bytes",original);db.insertOrThrow("standalone_media",null,v);
                }
            }
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    public boolean activateStandaloneMedia(String upload,String revision) {
        ContentValues v=new ContentValues();v.put("phase","active");
        return getWritableDatabase().update("standalone_media",v,"upload_id=? AND revision=? AND phase='staged'",new String[]{upload,revision})==1;
    }
    /** Explicit foreground resume only, after re-capturing the same canonical original. */
    public boolean resumeStandaloneMedia(String upload,String metadata,String revision) {
        ContentValues v=new ContentValues();v.put("phase","active");v.putNull("error");
        return getWritableDatabase().update("standalone_media",v,"upload_id=? AND metadata=? AND revision=? AND owner IS NULL AND phase IN ('held','cancelled')",new String[]{upload,metadata,revision})==1;
    }
    public org.json.JSONArray standaloneMedia() throws Exception {
        org.json.JSONArray result=new org.json.JSONArray();
        try(Cursor c=getReadableDatabase().rawQuery("SELECT upload_id,client_id,metadata,flags,revision,phase,result,error FROM standalone_media ORDER BY rowid",null)) {
            while(c.moveToNext())result.put(new org.json.JSONObject().put("uploadId",c.getString(0)).put("clientId",c.getString(1)).put("metadata",new org.json.JSONObject(c.getString(2))).put("originalMetadata",c.getString(2)).put("flags",new org.json.JSONArray(c.getString(3))).put("revision",c.getString(4)).put("phase",c.getString(5)).put("result",c.isNull(6)?org.json.JSONObject.NULL:new String(c.getBlob(6),java.nio.charset.StandardCharsets.UTF_8)).put("error",c.isNull(7)?org.json.JSONObject.NULL:c.getString(7)));
        }return result;
    }
    public byte[] standaloneBytes(String id){return readBytes("standalone_media","bytes","upload_id",id);}
    public boolean claimStandalone(String id,String owner,long now) {
        requireText(owner);if(now<0 || now>Long.MAX_VALUE-120000)throw new IllegalArgumentException("Invalid finite lease");
        ContentValues v=new ContentValues();v.put("owner",owner);v.put("expires",now+120000);
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            if(db.update("standalone_media",v,"upload_id=? AND phase='active' AND expires<=?",new String[]{id,Long.toString(now)})!=1)return false;
            ContentValues seal=new ContentValues();seal.put("upload_id",id);db.insertWithOnConflict("upload_attempt_seals",null,seal,SQLiteDatabase.CONFLICT_IGNORE);
            db.setTransactionSuccessful();return true;
        }finally{db.endTransaction();}
    }
    public boolean renewStandalone(String id,String owner,long now) {
        ContentValues v=new ContentValues();v.put("expires",now+120000);
        return getWritableDatabase().update("standalone_media",v,"upload_id=? AND owner=? AND expires>? AND phase='active'",new String[]{id,owner,Long.toString(now)})==1;
    }
    public boolean finishStandalone(String id,String owner,String metadata,String phase,byte[] result,String error,long now) {
        ContentValues v=new ContentValues();v.put("phase",phase);v.put("result",result);v.put("error",error);v.putNull("owner");v.put("expires",0);
        return getWritableDatabase().update("standalone_media",v,"upload_id=? AND owner=? AND expires>? AND metadata=? AND phase='active'",new String[]{id,owner,Long.toString(now),metadata})==1;
    }
    public void pauseStandaloneMedia(org.json.JSONArray ids) throws Exception {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            if(ids!=null)for(int n=0;n<ids.length();n++){ContentValues v=new ContentValues();v.put("id",ids.getString(n));db.insertWithOnConflict("transfer_tombstones",null,v,SQLiteDatabase.CONFLICT_IGNORE);}
            org.json.JSONArray rows=standaloneMedia();
            for(int i=0;i<rows.length();i++) {
                String id=rows.getJSONObject(i).getString("uploadId");boolean selected=ids==null;
                if(ids!=null)for(int n=0;n<ids.length();n++)if(id.equals(ids.getString(n)))selected=true;
                if(!selected)continue;
                try(Cursor c=db.rawQuery("SELECT owner FROM standalone_media WHERE upload_id=?",new String[]{id})){if(c.moveToFirst() && !c.isNull(0))throw new IllegalStateException("Native media in flight; original must be retained");}
                ContentValues v=new ContentValues();v.put("phase","cancelled");db.update("standalone_media",v,"upload_id=? AND phase != 'completed'",new String[]{id});
                ContentValues tombstone=new ContentValues();tombstone.put("id",id);db.insertWithOnConflict("transfer_tombstones",null,tombstone,SQLiteDatabase.CONFLICT_IGNORE);
            }
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    public void pruneStandalone(org.json.JSONArray live) throws Exception {
        org.json.JSONArray rows=standaloneMedia();
        for(int i=0;i<rows.length();i++) {
            String id=rows.getJSONObject(i).getString("uploadId");boolean exists=false;
            for(int n=0;n<live.length();n++)if(id.equals(live.getString(n)))exists=true;
            if(!exists)getWritableDatabase().delete("standalone_media","upload_id=? AND phase IN ('cancelled','completed') AND owner IS NULL",new String[]{id});
        }
    }
    public byte[] uploadResult(String id){return readBytes("upload_progress","result","upload_id",id);}
    public boolean recordUpload(String id,String op,String owner,byte[] result,long now) {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            try(Cursor c=db.rawQuery("SELECT op_id FROM background_jobs WHERE op_id=? AND owner=? AND expires>? AND phase='active'",new String[]{op,owner,Long.toString(now)})){if(!c.moveToFirst())return false;}
            ContentValues v=new ContentValues();v.put("upload_id",id);v.put("result",result);db.insertWithOnConflict("upload_progress",null,v,SQLiteDatabase.CONFLICT_IGNORE);db.setTransactionSuccessful();return true;
        }finally{db.endTransaction();}
    }
    private static void requireText(String value) {
        if (value == null || value.isEmpty() || value.length() > 128) throw new IllegalArgumentException("Transfer identity required");
    }
    public byte[] operationBody(String opId) { return readBytes("operations","body","op_id",opId); }
    public byte[] mediaBytes(String uploadId) { return readBytes("media","bytes","upload_id",uploadId); }
    private byte[] readBytes(String table, String column, String key, String id) {
        try (Cursor row = getReadableDatabase().query(table,new String[]{column},key+"=?",new String[]{id},null,null,null)) {
            return row.moveToFirst() ? row.getBlob(0) : null;
        }
    }
    private static String digest(byte[] bytes) {
        try { return sha256(bytes); } catch (Exception e) { throw new IllegalStateException("SHA256 unavailable",e); }
    }
    public static String sha256(byte[] bytes) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte b : java.security.MessageDigest.getInstance("SHA-256").digest(bytes))
            result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }
}
