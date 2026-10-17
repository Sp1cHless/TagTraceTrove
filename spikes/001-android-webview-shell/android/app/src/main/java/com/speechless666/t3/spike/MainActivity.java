package com.speechless666.t3.spike;

import android.os.Bundle;
import android.content.Intent;
import android.app.AlertDialog;
import android.widget.EditText;
import android.webkit.WebView;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.net.Uri;
import androidx.activity.result.ActivityResultLauncher;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;
import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
    private ActivityResultLauncher<ScanOptions> scanner;
    private PairingDiagnostics.Trace scanTrace;
    private static boolean journalInitialized;
    /** The bundled page reports itself through the status plugin; a silence means a blank document. */
    private volatile boolean pageBooted;
    void markPageBooted() { pageBooted = true; }
    @Override public void onCreate(Bundle state) {
        if (!journalInitialized) {
            android.content.SharedPreferences journal = getSharedPreferences("t3-pairing-diagnostics-v1", MODE_PRIVATE);
            String saved;
            try { saved = journal.getString("journal", null); } catch (Exception unreadable) { saved = null; }
            PairingDiagnostics.initialize(saved, value -> {
                if (!journal.edit().putString("journal", value).commit()) throw new IllegalStateException("Diagnostic storage unavailable");
            });
            try { PairingDiagnostics.environment(getPackageManager().getPackageInfo(getPackageName(),0).versionName, android.os.Build.VERSION.SDK_INT, android.os.Build.MODEL); }
            catch (Exception unavailable) { /* Pairing itself must not depend on diagnostics. */ }
            journalInitialized = true;
        }
        registerPlugin(PairedTransportPlugin.class);
        registerPlugin(BackgroundTransferPlugin.class);
        scanner = registerForActivityResult(new ScanContract(), result -> {
            PairingDiagnostics.Trace trace = scanTrace == null ? PairingDiagnostics.start("camera") : scanTrace;
            scanTrace = null;
            if (result.getContents() != null) { trace.passed("scan"); claim(result.getContents(), trace); }
            else trace.finish("cancelled");
        });
        super.onCreate(state);
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if ("https".equals(url.getScheme()) && "localhost".equals(url.getHost()) && url.getPath() != null && url.getPath().startsWith("/api/")) {
                    try {
                        if (!"GET".equals(request.getMethod())) throw new SecurityException("Use native API bridge");
                        PairingState pair = new PairingVault(MainActivity.this).load(); if (pair == null) throw new SecurityException("Pairing required");
                        // No per-image authority round-trip: every picture already carries the
                        // token and a revoked device is refused by the server. Asking again here
                        // doubled the traffic behind each image the page renders or downloads.
                        PinnedLanTransport.Result result = pair.transport.request(url.getEncodedPath() + (url.getEncodedQuery() == null ? "" : "?" + url.getEncodedQuery()),"GET",null,null,pair.token);
                        String mime = result.contentType == null ? "application/octet-stream" : result.contentType.split(";")[0];
                        return new WebResourceResponse(mime,null,result.status,result.status < 400 ? "OK" : "Rejected",Collections.singletonMap("Cache-Control","no-store"),new ByteArrayInputStream(result.bytes));
                    } catch (Exception e) { return new WebResourceResponse("text/plain","UTF-8",503,"Pairing required",Collections.emptyMap(),new ByteArrayInputStream(new byte[0])); }
                }
                return super.shouldInterceptRequest(view,request);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if ("https".equals(url.getScheme()) && "localhost".equals(url.getHost())) return false;
                if ("https".equals(url.getScheme()) || "http".equals(url.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW,url)); } catch (Exception ignored) { }
                }
                return true;
            }
        });
    }
    @Override public void onResume() {
        super.onResume();
        pageBooted = false;
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            if (isFinishing() || isDestroyed() || pageBooted) return;
            // The bundled page never reported itself: a blank document or a boot
            // failure. Reload an empty view once, and while no pairing exists,
            // surface the pairing dialog natively — recovery must never depend
            // on a page that may not be rendering.
            WebView view = bridge == null ? null : bridge.getWebView();
            String url = view == null ? null : view.getUrl();
            if (view != null && (url == null || url.equals("about:blank"))) view.loadUrl("https://localhost/");
            try {
                if (new PairingVault(this).load() == null) showPairingDialog();
            } catch (Exception stored) { showPairingDialog(); }
        }, 8_000);
    }
    public void showPairingDialog() {
        EditText input = new EditText(this); input.setHint("Paste desktop pairing payload (fallback)"); input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        new AlertDialog.Builder(this).setTitle("Pair encrypted T3 connection").setMessage("Scan the desktop Settings QR. Camera is used only for this explicit scan. Re-pairing does not delete your offline copy or queued edits.")
            .setView(input).setPositiveButton("Scan QR",(dialog,which) -> {
                scanTrace = PairingDiagnostics.start("camera"); scanTrace.stage("scan");
                try { scanner.launch(new ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setBeepEnabled(false).setPrompt("Scan desktop T3 pairing QR")); }
                catch (Exception error) { showPairingFailure(scanTrace, scanTrace.fail(error)); scanTrace = null; }
            })
            .setNeutralButton("Use pasted payload",(dialog,which) -> claim(input.getText().toString())).setNegativeButton("Cancel",null).show();
    }
    private void claim(String payload) {
        claim(payload, PairingDiagnostics.start("paste"));
    }
    private void claim(String payload, PairingDiagnostics.Trace trace) {
        PairingState loaded;
        trace.stage("vault_read");
        try { loaded = new PairingVault(this).load(); trace.passed("vault_read"); }
        catch (Exception stored) { trace.warning("vault_read", stored); loaded = null; }
        final PairingState previous = loaded;
        try {
            trace.stage("replacement_check");
            if (previous != null) {
                // Check foreign identity before showing any replacement action or sending a claim.
                PairingState.validateReplacement(payload, previous, true);
                new AlertDialog.Builder(this).setTitle("Confirm replacement pairing")
                    .setMessage("Trust only a new QR generated on your desktop for the same library. Replace the saved certificate and device authorization? Existing offline copy and queued edits stay intact; normal same-library reconnect can resume synchronization. If the library identity differs, keep this connection and export queued work first.")
                    .setPositiveButton("Replace pairing; keep offline work", (d,w) -> claimConfirmed(payload, previous, trace))
                    .setNegativeButton("Keep current pairing", (d,w) -> trace.finish("cancelled"))
                    .setOnCancelListener(d -> trace.finish("cancelled")).show(); return;
            }
            // An unreadable vault self-heals here: the fresh claim simply overwrites it.
            claimConfirmed(payload, null, trace);
        } catch (Exception e) {
            boolean foreignLibrary = e instanceof SecurityException
                && String.valueOf(e.getMessage()).startsWith("Different library");
            String failureCode = trace.fail(foreignLibrary ? new PairingDiagnostics.Failure("DIFFERENT_LIBRARY") : e);
            if (!foreignLibrary) { showPairingFailure(trace, failureCode); return; }
            AlertDialog.Builder builder = new AlertDialog.Builder(this).setTitle("Re-pair refused")
                .setMessage("Re-pair refused: different library or unreadable saved authorization. Keep your offline copy and queued edits; export queued work before choosing a separate library."
                    + (foreignLibrary ? "\n\nThe QR belongs to another library. You may explicitly forget this device's saved pairing and pair that library instead; what this device stored for the old library stays on disk but can never synchronize again."
                    : ""))
                .setPositiveButton("Keep current pairing", null);
            if (foreignLibrary) builder.setNegativeButton("Forget pairing; pair the new library", (d,w) -> { new PairingVault(this).clear(); claimConfirmed(payload, null, PairingDiagnostics.start("paste")); });
            builder.show();
        }
    }
    private void claimConfirmed(String payload, PairingState previous, PairingDiagnostics.Trace trace) {
        Executors.newSingleThreadExecutor().execute(() -> {
            try {
                trace.stage("replacement_check"); PairingState.validateReplacement(payload, previous, true);
                PairingState paired = PairingState.claim(payload, trace);
                trace.stage("vault_save"); PairingVault vault = new PairingVault(this); vault.save(paired);
                trace.stage("vault_readback"); PairingState stored = vault.load();
                if (stored == null || !paired.libraryId.equals(stored.libraryId) || !paired.deviceId.equals(stored.deviceId) || !paired.token.equals(stored.token)) throw new SecurityException("Pairing readback failed");
                trace.passed("vault_readback"); trace.finish("success");
                runOnUiThread(() -> { new AlertDialog.Builder(this).setMessage("Encrypted connection paired. Offline work was kept.").setPositiveButton("OK",(d,w) -> bridge.getWebView().reload()).show(); });
            }
            catch (Exception e) {
                String code = trace.fail(e); runOnUiThread(() -> showPairingFailure(trace, code));
            }
        });
    }
    private void showPairingFailure(PairingDiagnostics.Trace trace, String code) {
        new AlertDialog.Builder(this).setTitle("配对失败 · " + code)
            .setMessage(PairingDiagnostics.explanation(code) + "\n\n诊断编号：" + trace.id() + "\n离线副本和待同步改动已保留。")
            .setNeutralButton("复制诊断", (dialog, which) -> {
                android.content.ClipboardManager clipboard = (android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE);
                clipboard.setPrimaryClip(android.content.ClipData.newPlainText("T3 pairing diagnostics", PairingDiagnostics.snapshot().toString()));
            }).setPositiveButton("确定", null).show();
    }
}
