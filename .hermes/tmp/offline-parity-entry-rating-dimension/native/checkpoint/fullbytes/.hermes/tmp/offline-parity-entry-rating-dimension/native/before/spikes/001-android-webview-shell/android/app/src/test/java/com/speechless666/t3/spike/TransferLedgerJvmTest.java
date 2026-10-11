package com.speechless666.t3.spike;

import android.content.Context;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Device SQLite proof; compilation is not execution or process-death proof. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class TransferLedgerJvmTest {
    @Test public void previewCancelAuthority() throws Exception {
        Context context=RuntimeEnvironment.getApplication();String name="cancel.db";context.deleteDatabase(name);
        String id=java.util.UUID.randomUUID().toString();byte[] bytes=new byte[]{1,2,3};
        org.json.JSONObject metadata=new org.json.JSONObject().put("libraryId",java.util.UUID.randomUUID().toString()).put("syncEpoch","epoch").put("entryUid",java.util.UUID.randomUUID().toString()).put("kind","preview").put("ordinal",0).put("mimeType","image/png").put("byteLength",bytes.length).put("sha256",TransferLedger.sha256(bytes)).put("existingEntry",new org.json.JSONObject().put("expectedCoverRef",org.json.JSONObject.NULL).put("expectedPreviewRefs",new org.json.JSONArray()));
        org.json.JSONArray uploads=new org.json.JSONArray().put(new org.json.JSONObject().put("uploadId",id).put("metadata",metadata.toString()));
        try {
            try(TransferLedger ledger=new TransferLedger(context,name)) {
                id=ledger.allocateUploadId();uploads=new org.json.JSONArray().put(new org.json.JSONObject().put("uploadId",id).put("metadata",metadata.toString()));
                ledger.stageStandaloneMedia("client",id,metadata.toString(),"[]","1",bytes);ledger.activateStandaloneMedia(id,"1");
                // Absence alone does not prove history (e.g. a restored pre-attempt export).
                org.json.JSONArray unknown=new org.json.JSONArray().put(new org.json.JSONObject().put("uploadId",java.util.UUID.randomUUID().toString()).put("metadata",metadata.toString()));
                assertFalse(ledger.previewNeverAttempted(unknown));
                assertTrue(ledger.previewNeverAttempted(uploads));
                java.io.File directory=new java.io.File(context.getFilesDir(),"captures");directory.mkdirs();
                java.io.File capture=new java.io.File(directory,"fresh.json"),part=new java.io.File(directory,"fresh.part");
                try(java.io.FileOutputStream out=new java.io.FileOutputStream(capture)){out.write(new org.json.JSONObject().put("uploadId",id).put("metadata",metadata.toString()).toString().getBytes());}
                try(java.io.FileOutputStream out=new java.io.FileOutputStream(part)){out.write(bytes);}
                BackgroundTransferPlugin.authorizePreviewCancel(ledger,directory,uploads,new org.json.JSONArray(),new org.json.JSONArray().put(id));
                assertFalse(capture.exists());assertFalse(part.exists());
                assertFalse(ledger.claimStandalone(id,"worker",1));
            }
            try(TransferLedger cold=new TransferLedger(context,name)) {
                assertEquals(id,cold.foregroundOnlyUploads().getString(0));assertNull(cold.standaloneBytes(id));
                try {cold.stageStandaloneMedia("client",id,metadata.toString(),"[]","2",bytes);fail("released capture cannot resurrect");}catch(SecurityException expected){}
                String attempted=cold.allocateUploadId();uploads=new org.json.JSONArray().put(new org.json.JSONObject().put("uploadId",attempted).put("metadata",metadata.toString()));
                cold.stageStandaloneMedia("client",attempted,metadata.toString(),"[]","2",bytes);cold.activateStandaloneMedia(attempted,"2");assertTrue(cold.previewNeverAttempted(uploads));assertTrue(cold.claimStandalone(attempted,"worker",100));assertFalse(cold.previewNeverAttempted(uploads));
                assertTrue(cold.finishStandalone(attempted,"worker",metadata.toString(),"held",null,"uncertain",101));
            }
            try(TransferLedger cold=new TransferLedger(context,name)) {
                assertFalse(cold.previewNeverAttempted(uploads));try{cold.releaseNeverAttemptedPreviews(uploads);fail("held attempt must retain original");}catch(SecurityException expected){}
                assertArrayEquals(bytes,cold.standaloneBytes(uploads.getJSONObject(0).getString("uploadId")));
                String applied=java.util.UUID.randomUUID().toString();cold.stageStandaloneMedia("client",applied,metadata.toString(),"[]","3",bytes);cold.activateStandaloneMedia(applied,"3");assertTrue(cold.claimStandalone(applied,"worker",200));
                assertTrue(cold.finishStandalone(applied,"worker",metadata.toString(),"completed","applied".getBytes(),null,201));
                cold.pauseStandaloneMedia(new org.json.JSONArray().put(applied));
                org.json.JSONArray rows=cold.standaloneMedia();for(int i=0;i<rows.length();i++)if(applied.equals(rows.getJSONObject(i).getString("uploadId")))assertEquals("completed",rows.getJSONObject(i).getString("phase"));
            }
        }finally{context.deleteDatabase(name);}
    }

    @Test public void populatedLegacyVersionsUpgradeWithoutChangingBodiesBlobsLeasesOrResults() throws Exception {
        Context context=RuntimeEnvironment.getApplication();
        for(int version=1;version<=5;version++) {
            String name="legacy-transfer-"+version+".db";context.deleteDatabase(name);
            android.database.sqlite.SQLiteOpenHelper legacy=new android.database.sqlite.SQLiteOpenHelper(context,name,null,version) {
                public void onCreate(android.database.sqlite.SQLiteDatabase db) {
                    db.execSQL("CREATE TABLE operations (op_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, library_id TEXT NOT NULL, epoch TEXT NOT NULL, body BLOB NOT NULL, body_hash TEXT NOT NULL, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, result BLOB)");
                    db.execSQL("CREATE TABLE media (upload_id TEXT PRIMARY KEY, op_id TEXT NOT NULL REFERENCES operations(op_id), bytes BLOB NOT NULL, hash TEXT NOT NULL, mime TEXT NOT NULL)");
                }
                public void onUpgrade(android.database.sqlite.SQLiteDatabase db,int old,int next) {throw new AssertionError();}
            };
            try {
                android.database.sqlite.SQLiteDatabase db=legacy.getWritableDatabase();
                db.execSQL("INSERT INTO operations VALUES ('op','client','library','epoch',X'007FFF','original-hash','old-owner',123456,X'FE01')");
                db.execSQL("INSERT INTO media VALUES ('upload','op',X'FF0001','image-hash','image/png')");
                if(version>=2) {
                    db.execSQL("CREATE TABLE background_jobs (op_id TEXT PRIMARY KEY REFERENCES operations(op_id), upload_id TEXT REFERENCES media(upload_id), metadata TEXT, flags TEXT NOT NULL, revision TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'staged', owner TEXT, expires INTEGER NOT NULL DEFAULT 0, replay BLOB, media_result BLOB, error TEXT)");
                    db.execSQL("INSERT INTO background_jobs VALUES ('op','upload','{}','[]','revision','held','old-job-owner',7890,X'AB',X'CD','retained')");
                }
                if(version>=4) {
                    db.execSQL("CREATE TABLE background_uploads (upload_id TEXT PRIMARY KEY REFERENCES media(upload_id), op_id TEXT NOT NULL REFERENCES operations(op_id), metadata TEXT NOT NULL, flags TEXT NOT NULL)");
                    db.execSQL("INSERT INTO media VALUES ('second','op',X'01','hash','image/png')");
                    db.execSQL("INSERT INTO background_uploads VALUES ('second','op','{\"original\":true}','[\"offlineMediaUpload\"]')");
                }
                if(version>=5) {
                    db.execSQL("CREATE TABLE standalone_media (upload_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, metadata TEXT NOT NULL, flags TEXT NOT NULL, revision TEXT NOT NULL, bytes BLOB NOT NULL, phase TEXT NOT NULL DEFAULT 'staged', owner TEXT, expires INTEGER NOT NULL DEFAULT 0, result BLOB, error TEXT)");
                    db.execSQL("CREATE TABLE upload_progress (upload_id TEXT PRIMARY KEY, result BLOB NOT NULL)");
                    db.execSQL("CREATE TABLE transfer_tombstones (id TEXT PRIMARY KEY)");
                    db.execSQL("INSERT INTO standalone_media VALUES ('solo','client','{}','[]','original-revision',X'00FF','active','solo-owner',321,X'ABCD','original-error')");
                    db.execSQL("INSERT INTO upload_progress VALUES ('upload',X'FE00')");
                    db.execSQL("INSERT INTO transfer_tombstones VALUES ('discarded')");
                    db.execSQL("INSERT INTO operations VALUES ('pending','pending-client','pending-library','pending-epoch',X'FF00','pending-hash',NULL,0,NULL)");
                    db.execSQL("INSERT INTO background_jobs VALUES ('pending',NULL,NULL,'[]','pending-revision','active',NULL,0,NULL,NULL,NULL)");
                }
                legacy.close();
                try(TransferLedger upgraded=new TransferLedger(context,name)) {
                    assertEquals(7,upgraded.getReadableDatabase().getVersion());
                    if(version>=5) {
                        try(android.database.Cursor row=upgraded.getReadableDatabase().rawQuery("SELECT * FROM standalone_media",null)) {
                            assertTrue(row.moveToFirst());assertEquals("solo",row.getString(0));assertEquals("client",row.getString(1));assertEquals("{}",row.getString(2));assertEquals("[]",row.getString(3));assertEquals("original-revision",row.getString(4));assertArrayEquals(new byte[]{0,-1},row.getBlob(5));assertEquals("active",row.getString(6));assertEquals("solo-owner",row.getString(7));assertEquals(321,row.getLong(8));assertArrayEquals(new byte[]{-85,-51},row.getBlob(9));assertEquals("original-error",row.getString(10));
                        }
                        assertArrayEquals(new byte[]{-2,0},upgraded.uploadResult("upload"));assertArrayEquals(new byte[]{-1,0},upgraded.operationBody("pending"));assertNull(upgraded.operationResult("pending"));
                        try(android.database.Cursor row=upgraded.getReadableDatabase().rawQuery("SELECT id FROM transfer_tombstones",null)){assertTrue(row.moveToFirst());assertEquals("discarded",row.getString(0));}
                        try(android.database.Cursor row=upgraded.getReadableDatabase().rawQuery("SELECT phase,revision,owner,replay FROM background_jobs WHERE op_id='pending'",null)){assertTrue(row.moveToFirst());assertEquals("active",row.getString(0));assertEquals("pending-revision",row.getString(1));assertTrue(row.isNull(2));assertTrue(row.isNull(3));}
                    }
                    if(version>=4)assertEquals(2,upgraded.images("op").length());
                    assertArrayEquals(new byte[]{0,127,-1},upgraded.operationBody("op"));assertArrayEquals(new byte[]{-1,0,1},upgraded.mediaBytes("upload"));assertArrayEquals(new byte[]{-2,1},upgraded.operationResult("op"));
                    try(android.database.Cursor c=upgraded.getReadableDatabase().rawQuery("SELECT lease_owner,lease_until FROM operations",null)){assertTrue(c.moveToFirst());assertEquals("old-owner",c.getString(0));assertEquals(123456,c.getLong(1));}
                    if(version>=2) {assertEquals("held",upgraded.jobs().getJSONObject(0).getString("phase"));try(android.database.Cursor c=upgraded.getReadableDatabase().rawQuery("SELECT owner,expires,replay,media_result,error FROM background_jobs",null)){assertTrue(c.moveToFirst());assertEquals("old-job-owner",c.getString(0));assertEquals(7890,c.getLong(1));assertArrayEquals(new byte[]{-85},c.getBlob(2));assertArrayEquals(new byte[]{-51},c.getBlob(3));assertEquals("retained",c.getString(4));}}
                }
            } finally {legacy.close();context.deleteDatabase(name);}
        }
    }
    @Test public void independentHandlesClaimOnceAndColdResultsRemainUntilReconciled() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        String name = "transfer-test-" + java.util.UUID.randomUUID() + ".db";
        byte[] blob = new byte[]{1, 2};
        byte[] body = new byte[]{3};
        try {
            try (TransferLedger first = new TransferLedger(context,name);
                 TransferLedger second = new TransferLedger(context,name)) {
                first.mirror("client","library","epoch","op",body,"upload",blob,
                    TransferLedger.sha256(blob),"image/png");
                assertTrue(first.claim("op","worker-one",100,1000));
                assertFalse(second.claim("op","worker-two",101,1000));
                assertFalse(second.claim("op","worker-two",1099,1000));
                assertTrue(second.claim("op","worker-two",1100,1000));
                assertFalse(first.recordResult("op","worker-one",body,new byte[]{4}));
                assertTrue((Boolean)TransferLedger.class.getMethod("recordResult",String.class,String.class,byte[].class,byte[].class,long.class).invoke(second,"op","worker-two",body,new byte[]{5},1101L));
            }
            try (TransferLedger reopened = new TransferLedger(context,name)) {
                assertArrayEquals(body,reopened.operationBody("op"));
                assertArrayEquals(blob,reopened.mediaBytes("upload"));
                assertArrayEquals(new byte[]{5},reopened.operationResult("op"));
                assertFalse(reopened.claim("op","worker-three",100000,1000));
            }
        } finally { context.deleteDatabase(name); }
    }
    @Test public void coldOpenPreservesExactBodyAndBinaryAndRejectsCollision() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        String name = "transfer-test-" + java.util.UUID.randomUUID() + ".db";
        byte[] body = "{\"original\":  true}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] blob = new byte[]{0, 1, -1, 7};
        try {
            try (TransferLedger ledger = new TransferLedger(context, name)) {
                ledger.mirror("client", "library", "epoch", "op", body, "upload", blob,
                    TransferLedger.sha256(blob), "image/png");
            }
            try (TransferLedger ledger = new TransferLedger(context, name)) {
                assertArrayEquals(body, ledger.operationBody("op"));
                assertArrayEquals(blob, ledger.mediaBytes("upload"));
                try {
                    ledger.mirror("client", "library", "epoch", "op", new byte[]{9},
                        "other-upload", blob, TransferLedger.sha256(blob), "image/png");
                    fail("immutable operation collision must reject whole transaction");
                } catch (IllegalArgumentException expected) { }
                assertNull(ledger.mediaBytes("other-upload"));
                assertArrayEquals(body, ledger.operationBody("op"));
            }
        } finally { context.deleteDatabase(name); }
    }
    @Test public void standaloneFiniteLeaseCancelTombstoneAndExplicitResumeKeepExactOriginal() throws Exception {
        Context context=RuntimeEnvironment.getApplication();String name="standalone-guards.db",id="11111111-1111-4111-8111-111111111111";byte[] bytes={1};
        String metadata=new org.json.JSONObject().put("libraryId",id).put("entryUid",id).put("syncEpoch","epoch").put("kind","preview").put("ordinal",0).put("mimeType","image/png").put("byteLength",1).put("sha256",TransferLedger.sha256(bytes)).put("existingEntry",new org.json.JSONObject().put("expectedCoverRef",org.json.JSONObject.NULL).put("expectedPreviewRefs",new org.json.JSONArray())).toString();
        try(TransferLedger first=new TransferLedger(context,name);TransferLedger peer=new TransferLedger(context,name)) {
            first.stageStandaloneMedia("client",id,metadata,"[]","revision",bytes);assertTrue(first.activateStandaloneMedia(id,"revision"));assertTrue(first.claimStandalone(id,"old",100));
            try{peer.pause(null);fail("Global pause must include media-only in-flight work");}catch(IllegalStateException expected){}
            assertFalse(first.finishStandalone(id,"old",metadata,"completed",new byte[]{1},null,120100));assertTrue(peer.claimStandalone(id,"new",120100));
            assertFalse(first.finishStandalone(id,"old",metadata,"completed",new byte[]{1},null,120101));assertTrue(peer.finishStandalone(id,"new",metadata,"held",null,"unsupported",120101));
            java.lang.reflect.Method resume=TransferLedger.class.getMethod("resumeStandaloneMedia",String.class,String.class,String.class);
            assertEquals(true,resume.invoke(peer,id,metadata,"revision"));assertTrue(peer.claimStandalone(id,"valid",120102));assertTrue(peer.renewStandalone(id,"valid",120103));assertTrue(peer.finishStandalone(id,"valid",metadata,"completed",new byte[]{2},null,120104));
            peer.pause(null);assertFalse(first.activateStandaloneMedia(id,"revision"));peer.pruneStandalone(new org.json.JSONArray().put(id));assertArrayEquals(bytes,peer.standaloneBytes(id));peer.pruneStandalone(new org.json.JSONArray());
            try{first.stageStandaloneMedia("client",id,metadata,"[]","revision",bytes);fail("Late seal cannot resurrect canceled UUID");}catch(SecurityException expected){}
        }finally{context.deleteDatabase(name);}
    }
    @Test public void expiredOriginalOperationLeaseCannotRecordRawResult() throws Exception {
        Context context=RuntimeEnvironment.getApplication();String name="expired-original.db";
        try(TransferLedger ledger=new TransferLedger(context,name)) {
            ledger.mirror("client","library","epoch","op",new byte[]{1},"upload",new byte[]{2},TransferLedger.sha256(new byte[]{2}),"image/png");
            assertTrue(ledger.claim("op","old",System.currentTimeMillis()-2000,1000));assertFalse(ledger.recordResult("op","old",new byte[]{1},new byte[]{3}));assertNull(ledger.operationResult("op"));
        }finally{context.deleteDatabase(name);}
    }
}
