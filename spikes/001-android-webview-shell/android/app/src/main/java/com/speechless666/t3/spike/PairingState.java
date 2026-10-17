package com.speechless666.t3.spike;

import org.json.JSONObject;
import java.util.HashSet;
import java.util.Arrays;
import java.nio.charset.StandardCharsets;

public final class PairingState {
    public final PinnedLanTransport transport;
    public final String libraryId, deviceId, token;
    private PairingState(PinnedLanTransport transport, String libraryId, String deviceId, String token) { this.transport = transport; this.libraryId = libraryId; this.deviceId = deviceId; this.token = token; }
    private static void shape(JSONObject object, String... keys) {
        HashSet<String> actual = new HashSet<>(); object.keys().forEachRemaining(actual::add);
        if (!actual.equals(new HashSet<>(Arrays.asList(keys)))) throw new IllegalArgumentException("Invalid pairing shape");
    }
    private static long integer(JSONObject object, String key) throws Exception {
        Object value = object.get(key); if (!(value instanceof Integer || value instanceof Long)) throw new IllegalArgumentException("Invalid numeric field"); return ((Number) value).longValue();
    }
    private static String text(JSONObject object, String key) throws Exception { Object value = object.get(key); if (!(value instanceof String) || ((String)value).isEmpty()) throw new IllegalArgumentException("Invalid text field"); return (String)value; }
    public static PairingState parse(String json) throws Exception {
        JSONObject object = new JSONObject(json); shape(object, "version", "endpoint", "certificateSha256", "libraryId", "deviceId", "token");
        if (integer(object, "version") != 1) throw new IllegalArgumentException("Unsupported version");
        String token = text(object,"token"), device = text(object,"deviceId");
        if (!token.matches("[A-Za-z0-9_-]{43}") || !device.matches("[a-fA-F0-9-]{36}")) throw new IllegalArgumentException("Invalid credentials");
        return new PairingState(new PinnedLanTransport(text(object,"endpoint"),text(object,"certificateSha256")),text(object,"libraryId"),device,token);
    }
    public JSONObject serialize() throws Exception { return new JSONObject().put("version",1).put("endpoint",transport.endpoint).put("certificateSha256",transport.pin).put("libraryId",libraryId).put("deviceId",deviceId).put("token",token); }
    public static void validateReplacement(String payload, PairingState previous, boolean confirmed) throws Exception {
        if (previous == null) return;
        if (!previous.libraryId.equals(new JSONObject(payload).getString("libraryId"))) throw new SecurityException("Different library: keep current pairing. Export queued work before choosing a separate library; existing offline copy is not replaced.");
        if (!confirmed) throw new SecurityException("Explicit replacement confirmation required");
    }
    public static PairingState claim(String payload) throws Exception {
        return claim(payload, null);
    }
    public static PairingState claim(String payload, PairingDiagnostics.Trace trace) throws Exception {
        if (trace != null) trace.stage("qr_parse");
        JSONObject object = new JSONObject(payload); shape(object,"version","endpoint","libraryId","protocolMin","protocolMax","code","expiresAt","certificateSha256");
        if (trace != null) trace.stage("qr_protocol");
        if (integer(object,"version") != 1 || integer(object,"protocolMin") > 1 || integer(object,"protocolMax") < 1) throw new PairingDiagnostics.Failure("QR_INCOMPATIBLE");
        if (trace != null) { trace.stage("qr_expiry"); trace.timing(integer(object,"expiresAt")); }
        if (integer(object,"expiresAt") <= System.currentTimeMillis()) throw new PairingDiagnostics.Failure("QR_EXPIRED");
        if (trace != null) trace.stage("qr_endpoint");
        String code = text(object,"code"); if (!code.matches("[A-Za-z0-9_-]{43}")) throw new PairingDiagnostics.Failure("INVALID_QR");
        PinnedLanTransport transport = new PinnedLanTransport(text(object,"endpoint"),text(object,"certificateSha256"));
        if (trace != null) trace.endpoint(transport.endpoint);
        String libraryId = text(object,"libraryId");
        JSONObject body = new JSONObject().put("code",code).put("libraryId",libraryId).put("protocolVersion",1).put("deviceName","Android T3");
        if (trace != null) trace.stage("claim_request");
        PinnedLanTransport.Result result = transport.request("/api/pairing/claim","POST","application/json",body.toString().getBytes(StandardCharsets.UTF_8),null,trace,"claim");
        if (result.status != 201) {
            String reason = "CLAIM_HTTP_REJECTED";
            try {
                String reported = new JSONObject(new String(result.bytes,StandardCharsets.UTF_8)).getJSONObject("error").optString("pairingReason");
                if (Arrays.asList("CLAIM_CODE_UNAVAILABLE", "CLAIM_LIBRARY_MISMATCH", "CLAIM_INVALID_REQUEST").contains(reported)) reason = reported;
            } catch (Exception ignored) { }
            throw new PairingDiagnostics.Failure(reason);
        }
        if (trace != null) trace.stage("claim_response");
        JSONObject response = new JSONObject(new String(result.bytes,StandardCharsets.UTF_8)); shape(response,"version","libraryId","deviceId","token");
        if (integer(response,"version") != 1 || !libraryId.equals(text(response,"libraryId"))) throw new PairingDiagnostics.Failure("LIBRARY_CHANGED");
        PairingState state = parse(new JSONObject().put("version",1).put("endpoint",transport.endpoint).put("certificateSha256",transport.pin).put("libraryId",libraryId).put("deviceId",text(response,"deviceId")).put("token",text(response,"token")).toString());
        if (trace != null) trace.passed("claim_response");
        state.verify(trace); return state;
    }
    /**
     * Confirms authorization and exact library identity against the server on a fresh
     * connection, so a certificate that was replaced behind this pin is rejected here by
     * the handshake. It is deliberately not called before every read: the request itself
     * carries the token and the server is the authority, so paying for a second
     * round-trip per thumbnail only doubled the traffic on the one worker every request
     * shares (measured on the phone: one image cost two connections and two round-trips,
     * which starved the page behind the media download). Writes still confirm first, and
     * the page's own capability probe confirms identity every few seconds.
     */
    public void verify() throws Exception {
        verify(null);
    }
    private void verify(PairingDiagnostics.Trace trace) throws Exception {
        if (trace != null) trace.stage("verify_request");
        if (!token.matches("[A-Za-z0-9_-]{43}") || !deviceId.matches("[a-fA-F0-9-]{36}")) throw new SecurityException("Invalid authorization");
        PinnedLanTransport.Result result = transport.requestFreshConnection("/api/sync/capabilities","GET",null,null,token,trace,"verify");
        if (result.status != 200) throw new PairingDiagnostics.Failure("VERIFY_HTTP_REJECTED");
        if (trace != null) trace.stage("verify_response");
        if (!libraryId.equals(new JSONObject(new String(result.bytes,StandardCharsets.UTF_8)).getString("libraryId"))) throw new PairingDiagnostics.Failure("LIBRARY_CHANGED");
        if (trace != null) trace.passed("verify_response");
    }
}
