package com.speechless666.t3.spike;

import java.net.URI;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.Locale;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/** Instance-scoped leaf pin. Never installs a global trust manager or follows off-origin redirects. */
public final class PinnedLanTransport {
    public final String endpoint;
    public final String pin;
    public PinnedLanTransport(String endpoint, String pin) {
        URI uri = URI.create(endpoint);
        if (!"https".equals(uri.getScheme()) || uri.getRawUserInfo() != null || uri.getRawQuery() != null
            || uri.getRawFragment() != null || !("".equals(uri.getRawPath()) || "/".equals(uri.getRawPath()))) throw new IllegalArgumentException("Private HTTPS origin required");
        TrustedLanPairing.validate("http://" + uri.getRawAuthority(), "validate");
        if (pin == null || !pin.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("SHA256 certificate pin required");
        this.endpoint = "https://" + uri.getRawAuthority(); this.pin = pin;
    }
    public static final class Result {
        public final int status; public final byte[] bytes; public final String contentType, path;
        Result(int status, byte[] bytes, String contentType, String path) { this.status = status; this.bytes = bytes; this.contentType = contentType; this.path = path; }
    }
    /**
     * The pinned context and the HTTP clients are kept for the life of this transport,
     * which is the life of one pairing. Building both per request meant a fresh TLS
     * handshake, a fresh thread pool and a fresh dispatcher for every thumbnail — on the
     * phone that was one of the costs that starved the page behind the media download.
     * OkHttp pools connections, so repeated requests to the same host now reuse one.
     */
    private volatile SSLContext pinnedContext;
    private volatile X509TrustManager pinnedTrust;
    private volatile okhttp3.OkHttpClient readClient;
    private volatile okhttp3.OkHttpClient healthProbeClient;
    private volatile okhttp3.OkHttpClient mutationClient;
    private X509TrustManager trust() {
        X509TrustManager existing = pinnedTrust;
        if (existing != null) return existing;
        synchronized (this) {
            if (pinnedTrust == null) pinnedTrust = new X509TrustManager() {
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                public void checkClientTrusted(X509Certificate[] chain, String type) throws java.security.cert.CertificateException { throw new java.security.cert.CertificateException("Server only"); }
                public void checkServerTrusted(X509Certificate[] chain, String type) throws java.security.cert.CertificateException {
                    try {
                        if (chain == null || chain.length == 0) throw new java.security.cert.CertificateException("Missing certificate");
                        chain[0].checkValidity();
                        byte[] digest = MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded());
                        StringBuilder hex = new StringBuilder(); for (byte value : digest) hex.append(String.format(Locale.ROOT, "%02x", value & 255));
                        if (!MessageDigest.isEqual(hex.toString().getBytes(java.nio.charset.StandardCharsets.US_ASCII), pin.getBytes(java.nio.charset.StandardCharsets.US_ASCII))) throw new java.security.cert.CertificateException("Certificate pin changed");
                    } catch (java.security.cert.CertificateException e) { throw e; } catch (Exception e) { throw new java.security.cert.CertificateException("Pin verification failed", e); }
                }
            };
            return pinnedTrust;
        }
    }
    private SSLContext context() throws Exception {
        SSLContext existing = pinnedContext;
        if (existing != null) return existing;
        synchronized (this) {
            if (pinnedContext == null) {
                SSLContext context = SSLContext.getInstance("TLS");
                context.init(null,new TrustManager[] { trust() },null);
                pinnedContext = context;
            }
            return pinnedContext;
        }
    }
    /**
     * Reads pool their connections and may transparently retry one that the server has
     * already closed — a freshness check alone cannot rule out that race, and a spurious
     * failure here reaches the page as a broken read. Writes keep the strict behaviour
     * they had: a connection of their own, no retry, and therefore a pin that is checked
     * against the certificate the server presents right now.
     */
    private okhttp3.OkHttpClient clientFor(String path, String method) throws Exception {
        boolean read = "GET".equals(method) || "HEAD".equals(method);
        boolean healthProbe = path.startsWith("/api/sync/capabilities");
        okhttp3.OkHttpClient existing = !read ? mutationClient : (healthProbe ? healthProbeClient : readClient);
        if (existing != null) return existing;
        synchronized (this) {
            okhttp3.OkHttpClient built = !read ? mutationClient : (healthProbe ? healthProbeClient : readClient);
            if (built == null) {
                okhttp3.OkHttpClient.Builder builder = new okhttp3.OkHttpClient.Builder().sslSocketFactory(context().getSocketFactory(),trust())
                    .followRedirects(false).followSslRedirects(false)
                    .callTimeout(45,java.util.concurrent.TimeUnit.SECONDS).writeTimeout(15,java.util.concurrent.TimeUnit.SECONDS)
                    // The capability endpoint doubles as the connection health probe: the page
                    // asks it every few seconds and must notice a server that has gone away
                    // promptly, so it gets a 2s connect timeout instead of the full 8s.
                    .connectTimeout(healthProbe ? 2 : 8,java.util.concurrent.TimeUnit.SECONDS).readTimeout(15,java.util.concurrent.TimeUnit.SECONDS);
                if (read) {
                    built = builder.retryOnConnectionFailure(true).build();
                    if (healthProbe) healthProbeClient = built; else readClient = built;
                } else {
                    built = builder.retryOnConnectionFailure(false)
                        .connectionPool(new okhttp3.ConnectionPool(0,1,java.util.concurrent.TimeUnit.MILLISECONDS)).build();
                    mutationClient = built;
                }
            }
            return built;
        }
    }
    /**
     * An authority check owns its connection: pooling would let a request ride a tunnel
     * that was pinned before the server's certificate changed, so the pin could not be
     * re-checked. Only pairing and write confirmations use this.
     */
    public Result requestFreshConnection(String path, String method, String contentType, byte[] body, String token) throws Exception {
        return requestFreshConnection(path, method, contentType, body, token, null, null);
    }
    public Result requestFreshConnection(String path, String method, String contentType, byte[] body, String token, PairingDiagnostics.Trace trace, String phase) throws Exception {
        synchronized (this) {
            if (readClient != null) readClient.connectionPool().evictAll();
            if (healthProbeClient != null) healthProbeClient.connectionPool().evictAll();
        }
        return request(path,method,contentType,body,token,trace,phase);
    }
    /** Package-private test seam: how many read connections are held open right now. */
    int pooledReadConnections() {
        okhttp3.OkHttpClient read = readClient, health = healthProbeClient;
        return (read == null ? 0 : read.connectionPool().connectionCount())
            + (health == null ? 0 : health.connectionPool().connectionCount());
    }
    public Result request(String path, String method, String contentType, byte[] body, String token) throws Exception {
        return request(path, method, contentType, body, token, null, null);
    }
    public Result request(String path, String method, String contentType, byte[] body, String token, PairingDiagnostics.Trace trace, String phase) throws Exception {
        if (!path.startsWith("/api/") || path.contains("\\") || path.contains("#") || path.contains("\r") || path.contains("\n")) throw new SecurityException("API path required");
        URI target = URI.create(endpoint).resolve(path);
        if (!target.toString().startsWith(endpoint + "/api/") || !target.getRawAuthority().equals(URI.create(endpoint).getRawAuthority())) throw new SecurityException("Off-origin request");
        if (!method.matches("GET|POST|PUT|PATCH|DELETE|HEAD")) throw new SecurityException("Method rejected");
        if (token != null && !token.matches("[A-Za-z0-9_-]{43}")) throw new SecurityException("Invalid authorization");
        okhttp3.OkHttpClient client = clientFor(path,method);
        if (trace != null) client = client.newBuilder().eventListener(new okhttp3.EventListener() {
            @Override public void connectStart(okhttp3.Call call, java.net.InetSocketAddress address, java.net.Proxy proxy) { trace.stage(phase + "_connect"); }
            @Override public void secureConnectStart(okhttp3.Call call) { trace.stage(phase + "_tls"); }
            @Override public void secureConnectEnd(okhttp3.Call call, okhttp3.Handshake handshake) { trace.passed(phase + "_tls"); }
            @Override public void requestHeadersStart(okhttp3.Call call) { trace.stage(phase + "_send"); }
            @Override public void responseHeadersEnd(okhttp3.Call call, okhttp3.Response response) { trace.http(phase, response.code(), response.header("Date")); }
        }).build();
        for (int redirect = 0; redirect < 5; redirect++) {
            okhttp3.Request.Builder builder = new okhttp3.Request.Builder().url(target.toString());
            if (trace != null) builder.header("X-T3-Pairing-Attempt", trace.id());
            if (token != null) builder.header("Authorization","Bearer " + token);
            okhttp3.RequestBody requestBody = body == null && !("POST".equals(method) || "PUT".equals(method) || "PATCH".equals(method)) ? null
                : okhttp3.RequestBody.create(body == null ? new byte[0] : body,contentType == null ? null : okhttp3.MediaType.parse(contentType));
            builder.method(method,requestBody);
            try (okhttp3.Response response = client.newCall(builder.build()).execute()) {
                int status = response.code();
                if (status >= 300 && status < 400) {
                    if (!"GET".equals(method)) throw new SecurityException("Mutation redirect rejected");
                    String location = response.header("Location");
                    if (location == null) throw new SecurityException("Missing redirect destination");
                    URI next = target.resolve(location);
                    if (!"https".equals(next.getScheme()) || next.getRawUserInfo() != null || !target.getRawAuthority().equals(next.getRawAuthority()) || !next.getRawPath().startsWith("/api/")) throw new SecurityException("Off-origin redirect rejected");
                    target = next; continue;
                }
                InputStream stream = response.body() == null ? null : response.body().byteStream();
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                if (stream != null) try (InputStream in = stream) { byte[] buffer = new byte[8192]; int count; while ((count = in.read(buffer)) != -1) { if (bytes.size() + count > 96 * 1024 * 1024) throw new SecurityException("Response too large"); bytes.write(buffer, 0, count); } }
                return new Result(status,bytes.toByteArray(),response.header("Content-Type"),target.getRawPath() + (target.getRawQuery() == null ? "" : "?" + target.getRawQuery()));
            }
        }
        throw new SecurityException("Redirect limit exceeded");
    }
}
