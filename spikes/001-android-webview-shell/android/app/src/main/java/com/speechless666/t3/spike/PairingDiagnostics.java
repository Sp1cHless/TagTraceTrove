package com.speechless666.t3.spike;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.UUID;
import java.util.function.Consumer;

/** Bounded, app-private journal. Only typed fields enter it, never payloads or exception messages. */
public final class PairingDiagnostics {
    private static JSONArray attempts = new JSONArray();
    private static Consumer<String> persist = value -> {};
    private static boolean persistenceFailed;
    private static JSONObject environment = new JSONObject();
    public static synchronized void environment(String version, int androidApi, String model) {
        put(environment, "appVersion", version); put(environment, "androidApi", androidApi); put(environment, "model", model); save();
    }
    public static synchronized void initialize(String saved, Consumer<String> sink) {
        persist = sink;
        persistenceFailed = false;
        try { attempts = new JSONObject(saved == null ? "{}" : saved).optJSONArray("attempts"); }
        catch (Exception ignored) { attempts = null; }
        if (attempts == null) attempts = new JSONArray();
        while (attempts.length() > 8) attempts.remove(0);
        // A process may have died while connecting or saving. Preserve that fact on cold start.
        for (int i = 0; i < attempts.length(); i++) {
            JSONObject row = attempts.optJSONObject(i);
            if (row != null && "running".equals(row.optString("status"))) put(row, "status", "interrupted");
        }
        save();
    }
    private static void put(JSONObject object, String key, Object value) {
        try { object.put(key, value); } catch (Exception ignored) { }
    }
    private static void save() {
        try { persist.accept(snapshot().toString()); } catch (Exception ignored) { persistenceFailed = true; }
    }
    public static synchronized JSONObject snapshot() {
        JSONObject result = new JSONObject();
        put(result, "version", 1); put(result, "persistenceFailed", persistenceFailed);
        put(result, "device", environment);
        // Return a copy so a bridge caller cannot mutate the journal.
        try { put(result, "attempts", new JSONArray(attempts.toString())); } catch (Exception ignored) { }
        return result;
    }
    public static synchronized Trace start(String source) {
        JSONObject row = new JSONObject();
        put(row, "attemptId", UUID.randomUUID().toString()); put(row, "startedAt", System.currentTimeMillis());
        put(row, "source", "camera".equals(source) ? "camera" : "paste");
        put(row, "status", "running"); put(row, "events", new JSONArray());
        attempts.put(row); while (attempts.length() > 8) attempts.remove(0);
        Trace trace = new Trace(row); trace.stage("payload_received"); return trace;
    }
    public static final class Failure extends SecurityException {
        public final String code;
        public Failure(String code) { super(code); this.code = code; }
    }
    public static String classify(Throwable error, String stage) {
        java.util.List<Throwable> causes = new java.util.ArrayList<>();
        for (Throwable e = error; e != null && causes.size() < 8 && !causes.contains(e); e = e.getCause()) causes.add(e);
        // SSLException extends IOException: inspect the whole cause chain before generic I/O.
        for (Throwable e : causes) {
            if (e instanceof Failure) return ((Failure)e).code;
            if (e instanceof java.security.cert.CertificateExpiredException) return "TLS_CERTIFICATE_EXPIRED";
            if (e instanceof java.security.cert.CertificateNotYetValidException) return "TLS_CERTIFICATE_NOT_YET_VALID";
        }
        for (Throwable e : causes) {
            if (e instanceof javax.net.ssl.SSLException || e instanceof java.security.cert.CertificateException) return "TLS_VALIDATION_FAILED";
        }
        if (stage.startsWith("vault_")) return "PAIRING_STORAGE_FAILED";
        for (Throwable e : causes) {
            if (e instanceof java.net.SocketTimeoutException) return "NETWORK_TIMEOUT";
            if (e instanceof java.net.ConnectException) return "CONNECTION_FAILED";
            if (e instanceof java.net.UnknownHostException) return "ADDRESS_UNRESOLVED";
            if (e instanceof java.io.IOException) return "NETWORK_IO_FAILED";
        }
        if (stage.startsWith("qr_") || stage.equals("replacement_check")) return "INVALID_QR";
        if (stage.endsWith("response")) return "INVALID_SERVER_RESPONSE";
        return "PAIRING_FAILED";
    }
    public static String explanation(String code) {
        switch (code) {
            case "QR_EXPIRED": return "二维码按手机当前时间已过期；请核对手机和电脑时间，再生成新二维码。";
            case "QR_INCOMPATIBLE": return "二维码协议与当前 APP 不兼容，请核对两端版本。";
            case "INVALID_QR": return "二维码内容或连接地址不符合配对格式。";
            case "DIFFERENT_LIBRARY": return "二维码属于另一个资料库，已保留当前配对。";
            case "TLS_CERTIFICATE_EXPIRED": case "TLS_CERTIFICATE_NOT_YET_VALID":
                return "电脑证书不在有效期内，请核对两端时间和电脑证书状态。";
            case "TLS_VALIDATION_FAILED": return "电脑证书校验失败；可能是指纹不符或 TLS 握手失败。";
            case "NETWORK_TIMEOUT": return "连接电脑或读取响应超时，请检查两端网络及电脑防火墙。";
            case "CONNECTION_FAILED": case "NETWORK_IO_FAILED": case "ADDRESS_UNRESOLVED":
                return "无法完成到二维码中电脑地址的连接，请检查地址、网络及电脑防火墙。";
            case "PAIRING_STORAGE_FAILED": return "手机无法读取或保存配对信息；离线资料仍保留。";
            case "CLAIM_CODE_UNAVAILABLE": return "电脑拒绝了配对码：可能已过期、已使用或已失效。请生成新二维码。";
            case "CLAIM_LIBRARY_MISMATCH": case "LIBRARY_CHANGED": return "电脑返回的资料库身份与二维码不一致。";
            case "CLAIM_INVALID_REQUEST": case "CLAIM_HTTP_REJECTED": return "电脑拒绝领取授权，请对照同一诊断编号的电脑日志。";
            case "VERIFY_HTTP_REJECTED": return "授权已领取，但电脑未通过后续授权验证。";
            case "INVALID_SERVER_RESPONSE": return "电脑返回的配对响应格式不符合协议。";
            default: return "配对过程失败，请复制诊断查看具体阶段。";
        }
    }
    public static final class Trace {
        private final JSONObject row;
        private final long startedNanos = System.nanoTime();
        private String stage = "payload_received";
        private Trace(JSONObject row) { this.row = row; }
        public String id() { return row.optString("attemptId"); }
        public void stage(String value) { event(value, "started", null); }
        public void passed(String value) { event(value, "passed", null); }
        public void warning(String value, Throwable error) { event(value, "warning", error.getClass().getSimpleName()); }
        public void timing(long expiresAt) {
            synchronized (PairingDiagnostics.class) {
                put(row, "phoneTime", System.currentTimeMillis()); put(row, "qrExpiresAt", expiresAt);
                put(row, "qrRemainingMs", expiresAt - System.currentTimeMillis()); save();
            }
        }
        public void endpoint(String endpoint) {
            synchronized (PairingDiagnostics.class) { put(row, "endpoint", endpoint); save(); }
        }
        public void http(String phase, int status, String serverDate) {
            synchronized (PairingDiagnostics.class) {
                put(row, phase + "HttpStatus", status);
                if (serverDate != null && serverDate.matches("[A-Za-z0-9,: +\\-]{1,64}")) put(row, "serverDate", serverDate);
                event(phase + "_response", "received", null);
            }
        }
        private void event(String value, String status, String exceptionClass) {
            synchronized (PairingDiagnostics.class) {
                if (!"running".equals(row.optString("status"))) return;
                stage = value; put(row, "stage", value);
                JSONObject event = new JSONObject(); put(event, "at", System.currentTimeMillis());
                put(event, "elapsedMs", (System.nanoTime() - startedNanos) / 1_000_000);
                put(event, "stage", value); put(event, "status", status);
                if (exceptionClass != null) put(event, "exceptionClass", exceptionClass);
                JSONArray events = row.optJSONArray("events"); events.put(event);
                while (events.length() > 40) events.remove(0); save();
            }
        }
        public String fail(Throwable error) {
            synchronized (PairingDiagnostics.class) {
                String code = classify(error, stage);
                event(stage, "failed", error.getClass().getSimpleName());
                put(row, "failureCode", code); finish("failed"); return code;
            }
        }
        public void finish(String status) {
            synchronized (PairingDiagnostics.class) { put(row, "status", status); put(row, "finishedAt", System.currentTimeMillis()); save(); }
        }
    }
}
