package com.speechless666.t3.spike;

import org.junit.Test;
import static org.junit.Assert.*;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

public class SecurePairingTest {
    @Test public void nativePinnedClaimApiMediaColdRestartAndRevocation() throws Exception {
        String repository = System.getenv("T3_TEST_REPO"); assertNotNull("T3_TEST_REPO must point to the isolated fixture repository",repository);
        Process child = new ProcessBuilder("node",Path.of(repository,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),Path.of(repository,"apps/server/tests/fixtures/secure-pairing-native.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
        BufferedReader reader = new BufferedReader(new InputStreamReader(child.getInputStream(),StandardCharsets.UTF_8));
        PrintWriter writer = new PrintWriter(child.getOutputStream(),true,StandardCharsets.UTF_8);
        try {
            String payload = reader.readLine(); assertNotNull("Fixture starts",payload);
            PairingState paired = PairingState.claim(payload);
            paired.verify();
            PairingState cold = PairingState.parse(paired.serialize().toString());
            JSONObject create = new JSONObject().put("title","Native pinned proof").put("type","comic");
            PinnedLanTransport.Result created = cold.transport.request("/api/entries","POST","application/json",create.toString().getBytes(StandardCharsets.UTF_8),cold.token);
            assertEquals(201,created.status);
            int id = new JSONObject(new String(created.bytes,StandardCharsets.UTF_8)).getInt("id");
            PinnedLanTransport.Result patched = cold.transport.request("/api/entries/"+id,"PATCH","application/json","{\"title\":\"Changed natively\"}".getBytes(StandardCharsets.UTF_8),cold.token);
            assertEquals(200,patched.status);
            PinnedLanTransport.Result media = cold.transport.request("/api/assets/entries/1/cover.webp","GET",null,null,cold.token);
            assertEquals(200,media.status); assertEquals("native-media-proof",new String(media.bytes,StandardCharsets.UTF_8));
            writer.println("{\"action\":\"restart\"}"); assertTrue(new JSONObject(reader.readLine()).getBoolean("ok")); cold.verify();
            try { new PinnedLanTransport(cold.transport.endpoint,"0".repeat(64)).request("/api/sync/capabilities","GET",null,null,cold.token); fail("Certificate changes reject"); } catch (javax.net.ssl.SSLException expected) { }
            writer.println(new JSONObject().put("action","revoke").put("deviceId",cold.deviceId).toString()); assertTrue(new JSONObject(reader.readLine()).getBoolean("ok"));
            try { cold.verify(); fail("Revoked authorization rejects"); } catch (SecurityException expected) { }
            try { PairingState.claim(payload); fail("Consumed code rejects"); } catch (SecurityException expected) { }
        } finally { writer.println("{\"action\":\"close\"}"); if (!child.waitFor(15,java.util.concurrent.TimeUnit.SECONDS)) child.destroyForcibly(); }
    }
    @Test public void actualCertificateReplacementRetainsOldCredentialUntilExplicitRepair() throws Exception {
        String repository = System.getenv("T3_TEST_REPO"); assertNotNull(repository);
        Process child = new ProcessBuilder("node",Path.of(repository,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),Path.of(repository,"apps/server/tests/fixtures/secure-pairing-native.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
        BufferedReader reader = new BufferedReader(new InputStreamReader(child.getInputStream(),StandardCharsets.UTF_8));
        PrintWriter writer = new PrintWriter(child.getOutputStream(),true,StandardCharsets.UTF_8);
        try {
            String originalQr = reader.readLine(); PairingState original = PairingState.claim(originalQr);
            String saved = original.serialize().toString();
            writer.println("{\"action\":\"replace-certificate\"}"); String newQr = reader.readLine();
            assertNotEquals(original.transport.pin, new JSONObject(newQr).getString("certificateSha256"));
            try { original.verify(); fail("Actual replaced certificate must reject original pin"); } catch (javax.net.ssl.SSLException expected) { }
            assertEquals(saved, original.serialize().toString()); // Failure never changes the stored credential.
            PinnedLanTransport replacement = new PinnedLanTransport(original.transport.endpoint,new JSONObject(newQr).getString("certificateSha256"));
            assertEquals(401,replacement.request("/api/sync/capabilities","GET",null,null,original.token).status);
            JSONObject stale = new JSONObject(originalQr).put("certificateSha256", replacement.pin);
            try { PairingState.claim(stale.toString()); fail("Old QR is invalid after replacement"); } catch (SecurityException expected) { }
            PairingState repaired = PairingState.claim(newQr); repaired.verify();
            assertEquals(original.libraryId,repaired.libraryId);
            writer.println("{\"action\":\"restart\"}"); assertTrue(new JSONObject(reader.readLine()).getBoolean("ok"));
            assertEquals(401,replacement.request("/api/sync/capabilities","GET",null,null,original.token).status);
        } finally { writer.println("{\"action\":\"close\"}"); if (!child.waitFor(15,java.util.concurrent.TimeUnit.SECONDS)) child.destroyForcibly(); }
    }
    @Test public void actualHttpsOffOriginAndHttpDowngradeNeverForwardApiOrMediaAuthorization() throws Exception {
        String repository = System.getenv("T3_TEST_REPO"); assertNotNull(repository);
        Process child = new ProcessBuilder("node",Path.of(repository,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),Path.of(repository,"apps/server/tests/fixtures/secure-pairing-native.mts").toString()).redirectError(ProcessBuilder.Redirect.INHERIT).start();
        BufferedReader reader = new BufferedReader(new InputStreamReader(child.getInputStream(),StandardCharsets.UTF_8));
        PrintWriter writer = new PrintWriter(child.getOutputStream(),true,StandardCharsets.UTF_8);
        try {
            PairingState paired = PairingState.claim(reader.readLine());
            writer.println("{\"action\":\"redirect-origin\"}"); JSONObject origin = new JSONObject(reader.readLine());
            PinnedLanTransport transport = new PinnedLanTransport(origin.getString("endpoint"),origin.getString("certificateSha256"));
            for (String path : new String[]{"/api/sync/capabilities", "/api/assets/entries/1/cover.webp", "/api/downgrade", "/api/assets/downgrade"}) {
                try { transport.request(path,"GET",null,null,paired.token); fail("Off-origin redirect admitted"); } catch (SecurityException expected) { }
            }
            writer.println("{\"action\":\"redirect-counters\"}"); JSONObject counters = new JSONObject(reader.readLine());
            assertEquals(4,counters.getInt("sourceAuthorization"));
            assertEquals(0,counters.getInt("targetRequests")); assertEquals(0,counters.getInt("targetAuthorization"));
            paired.verify();
        } finally { writer.println("{\"action\":\"close\"}"); if (!child.waitFor(15,java.util.concurrent.TimeUnit.SECONDS)) child.destroyForcibly(); }
    }
    @Test public void replacementRequiresConfirmationAndNeverSwitchesQueuedWorkToForeignLibrary() throws Exception {
        PairingState previous = PairingState.parse(new JSONObject().put("version",1).put("endpoint","https://192.168.1.2").put("certificateSha256","a".repeat(64)).put("libraryId","library").put("deviceId","12345678-1234-1234-1234-123456789abc").put("token","a".repeat(43)).toString());
        String qr = new JSONObject().put("libraryId","library").toString();
        try { PairingState.class.getMethod("validateReplacement",String.class,PairingState.class,boolean.class); } catch (NoSuchMethodException missing) { fail("Explicit replacement policy missing"); }
        java.lang.reflect.Method method = PairingState.class.getMethod("validateReplacement",String.class,PairingState.class,boolean.class);
        try { method.invoke(null,qr,previous,false); fail("Implicit replacement admitted"); } catch (java.lang.reflect.InvocationTargetException expected) { assertTrue(expected.getCause() instanceof SecurityException); }
        method.invoke(null,qr,previous,true);
        try { method.invoke(null,new JSONObject().put("libraryId","foreign").toString(),previous,true); fail("Foreign library admitted"); } catch (java.lang.reflect.InvocationTargetException expected) { assertTrue(expected.getCause() instanceof SecurityException); }
    }
    @Test public void strictPayloadAndPrivateOriginGate() throws Exception {
        for (String endpoint : new String[] {"http://192.168.1.2", "https://example.com", "https://192.168.01.2", "https://192.168.1.2@evil.test", "https://192.168.1.2/path", "https://127.0.0.1", "https://192.168.1.2?x=1"}) {
            try { new PinnedLanTransport(endpoint,"a".repeat(64)); fail("Unsafe endpoint admitted"); } catch (IllegalArgumentException expected) { }
        }
        for (String shape : new String[]{"{}","[]","null","{\"version\":1}"}) { try { PairingState.parse(shape); fail("Invalid stored shape admitted"); } catch (Exception expected) { } }
    }
}
