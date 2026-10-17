package com.speechless666.t3.spike;

import org.junit.Test;
import static org.junit.Assert.*;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** One focused diagnostic check family: actual pinned HTTPS plus durable, redacted stage records. */
public class PairingDiagnosticsTest {
    private JSONObject last() throws Exception { JSONArray rows = PairingDiagnostics.snapshot().getJSONArray("attempts"); return rows.getJSONObject(rows.length()-1); }
    private String rejectionCode(String payload, PairingDiagnostics.Trace trace) throws Exception {
        try { PairingState.claim(payload, trace); fail("Expected rejected pairing"); return ""; }
        catch (Exception error) { return trace.fail(error); }
    }
    @Test public void durableJournalIsBoundedAndDoesNotCopyPayloadsOrExceptionMessages() throws Exception {
        AtomicReference<String> saved = new AtomicReference<>();
        PairingDiagnostics.initialize(null, saved::set);
        PairingDiagnostics.Trace trace = PairingDiagnostics.start("camera");
        trace.stage("vault_save");
        assertEquals("PAIRING_STORAGE_FAILED", trace.fail(new SecurityException("secret-token-and-qr-must-not-appear")));
        assertFalse(saved.get().contains("secret-token-and-qr"));
        assertEquals("failed", last().getString("status"));
        String id = trace.id(); PairingDiagnostics.initialize(saved.get(), saved::set);
        assertEquals(id, last().getString("attemptId"));
        PairingDiagnostics.start("paste").stage("claim_connect");
        PairingDiagnostics.initialize(saved.get(), saved::set);
        assertEquals("interrupted", last().getString("status"));
        for (int i=0; i<12; i++) {
            PairingDiagnostics.Trace next = PairingDiagnostics.start("paste");
            for (int j=0; j<60; j++) next.stage("scan");
            next.finish("cancelled");
        }
        assertEquals(8, PairingDiagnostics.snapshot().getJSONArray("attempts").length());
        assertEquals(40, last().getJSONArray("events").length());
        PairingDiagnostics.initialize(null, value -> { throw new IllegalStateException("disk unavailable"); });
        PairingDiagnostics.start("paste");
        assertTrue(PairingDiagnostics.snapshot().getBoolean("persistenceFailed"));
    }
    @Test public void failuresDistinguishQrExpiryProtocolTlsAndNetwork() throws Exception {
        PairingDiagnostics.initialize(null, value -> {});
        JSONObject qr = new JSONObject().put("version",1).put("endpoint","https://192.168.1.2:8766")
            .put("libraryId","fixture").put("protocolMin",1).put("protocolMax",1)
            .put("code","s".repeat(43)).put("expiresAt",System.currentTimeMillis()-1).put("certificateSha256","a".repeat(64));
        assertEquals("QR_EXPIRED", rejectionCode(qr.toString(), PairingDiagnostics.start("paste")));
        assertEquals("qr_expiry", last().getString("stage")); assertTrue(last().has("phoneTime")); assertTrue(last().has("qrExpiresAt"));
        qr.put("expiresAt",System.currentTimeMillis()+120000).put("protocolMin",2);
        assertEquals("QR_INCOMPATIBLE", rejectionCode(qr.toString(), PairingDiagnostics.start("camera")));
        assertEquals("INVALID_QR", rejectionCode("{secret payload broken", PairingDiagnostics.start("paste")));
        assertEquals("TLS_VALIDATION_FAILED", PairingDiagnostics.classify(new javax.net.ssl.SSLHandshakeException("secret"), "claim_tls"));
        javax.net.ssl.SSLHandshakeException expired = new javax.net.ssl.SSLHandshakeException("opaque");
        expired.initCause(new java.security.cert.CertificateExpiredException());
        assertEquals("TLS_CERTIFICATE_EXPIRED", PairingDiagnostics.classify(expired, "claim_tls"));
        assertEquals("NETWORK_TIMEOUT", PairingDiagnostics.classify(new java.net.SocketTimeoutException(), "claim_connect"));
        assertEquals("CONNECTION_FAILED", PairingDiagnostics.classify(new java.net.ConnectException(), "claim_connect"));
        assertEquals("NETWORK_IO_FAILED", PairingDiagnostics.classify(new java.io.IOException(), "claim_send"));
        assertFalse(PairingDiagnostics.snapshot().toString().contains("secret payload"));
    }
    @Test public void actualPinnedTlsRecordsSuccessRejectionTlsAndVerificationFailuresWithMatchingDesktopIds() throws Exception {
        PairingDiagnostics.initialize(null, value -> {});
        String repository = System.getenv("T3_TEST_REPO"); assertNotNull(repository);
        Process child = new ProcessBuilder("node", Path.of(repository,"apps/server/node_modules/tsx/dist/cli.mjs").toString(),
            Path.of(repository,"apps/server/tests/fixtures/pairing-diagnostics-native.mts").toString())
            .redirectError(ProcessBuilder.Redirect.INHERIT).start();
        BufferedReader reader = new BufferedReader(new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8));
        PrintWriter writer = new PrintWriter(child.getOutputStream(), true, StandardCharsets.UTF_8);
        try {
            String qr = reader.readLine(); assertNotNull(qr);
            PairingDiagnostics.Trace trace = PairingDiagnostics.start("camera");
            PairingState paired = PairingState.claim(qr, trace); trace.finish("success");
            assertEquals(201, last().getInt("claimHttpStatus")); assertEquals(200, last().getInt("verifyHttpStatus"));
            assertTrue(last().has("serverDate")); assertEquals("success",last().getString("status"));
            PairingState.parse(paired.serialize().toString()).verify(); // Default/no-trace transport remains valid.
            for (String reason : new String[]{"CLAIM_INVALID_REQUEST", "CLAIM_LIBRARY_MISMATCH"}) {
                JSONObject body = reason.equals("CLAIM_INVALID_REQUEST") ? new JSONObject().put("secret", "never log this body")
                    : new JSONObject().put("code", new JSONObject(qr).getString("code")).put("libraryId", "foreign-library").put("protocolVersion",1).put("deviceName","fixture");
                PairingDiagnostics.Trace request = PairingDiagnostics.start("paste"); request.stage("claim_request");
                PinnedLanTransport.Result result = paired.transport.request("/api/pairing/claim", "POST", "application/json", body.toString().getBytes(StandardCharsets.UTF_8), null, request, "claim");
                assertEquals(401,result.status);
                assertEquals(reason,new JSONObject(new String(result.bytes,StandardCharsets.UTF_8)).getJSONObject("error").getString("pairingReason"));
                request.fail(new PairingDiagnostics.Failure(reason));
            }
            PairingDiagnostics.Trace reused = PairingDiagnostics.start("paste");
            assertEquals("CLAIM_CODE_UNAVAILABLE", rejectionCode(qr, reused));
            assertEquals(401,last().getInt("claimHttpStatus"));
            JSONObject badPin = new JSONObject(qr).put("certificateSha256","0".repeat(64));
            assertEquals("TLS_VALIDATION_FAILED",rejectionCode(badPin.toString(),PairingDiagnostics.start("paste")));
            assertEquals("claim_tls",last().getString("stage"));
            String[] modes = {"reject","invalid-response","wrong-library"};
            String[] reasons = {"VERIFY_HTTP_REJECTED","INVALID_SERVER_RESPONSE","LIBRARY_CHANGED"};
            for (int i=0; i<modes.length; i++) {
                writer.println(new JSONObject().put("action","mode").put("mode",modes[i])); reader.readLine();
                writer.println("{\"action\":\"offer\"}"); String fresh = reader.readLine();
                assertEquals(reasons[i],rejectionCode(fresh,PairingDiagnostics.start("paste")));
                assertEquals(201,last().getInt("claimHttpStatus"));
                assertEquals("failed",last().getString("status"));
            }
            writer.println("{\"action\":\"logs\"}"); String logs = reader.readLine();
            assertTrue(logs.contains(trace.id())); assertTrue(logs.contains(reused.id()));
            for (String expected : new String[]{"claim_received","claim_accepted","verify_received","verify_response","CLAIM_CODE_UNAVAILABLE"}) assertTrue(expected,logs.contains(expected));
            String combined = logs + PairingDiagnostics.snapshot();
            assertFalse(combined.contains(paired.token)); assertFalse(combined.contains(new JSONObject(qr).getString("code")));
            assertFalse(combined.contains("certificateSha256")); assertFalse(combined.contains("tokenHash"));
            assertFalse(combined.contains("never log this body"));
            writer.println(new JSONObject().put("action","bridge").put("payload",PairingDiagnostics.snapshot()));
            JSONObject bridge = new JSONObject(reader.readLine());
            assertTrue(bridge.isNull("desktop"));
            assertEquals(PairingDiagnostics.snapshot().toString(),bridge.getJSONObject("diagnostic").toString());
            assertEquals("NATIVE_DIAGNOSTICS_UNAVAILABLE",bridge.getJSONObject("unavailable").getString("reason"));
            assertEquals("NATIVE_DIAGNOSTICS_TIMEOUT",bridge.getJSONObject("timeout").getString("reason"));
        } finally {
            writer.println("{\"action\":\"close\"}");
            if (!child.waitFor(15,TimeUnit.SECONDS)) child.destroyForcibly();
        }
    }
}
