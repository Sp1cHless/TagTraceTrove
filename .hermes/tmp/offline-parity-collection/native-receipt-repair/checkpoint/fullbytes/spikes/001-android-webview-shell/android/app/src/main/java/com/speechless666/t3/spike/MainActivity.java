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
    /** The bundled page reports itself through the status plugin; a silence means a blank document. */
    private volatile boolean pageBooted;
    void markPageBooted() { pageBooted = true; }
    @Override public void onCreate(Bundle state) {
        registerPlugin(PairedTransportPlugin.class);
        registerPlugin(BackgroundTransferPlugin.class);
        scanner = registerForActivityResult(new ScanContract(), result -> { if (result.getContents() != null) claim(result.getContents()); });
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
            .setView(input).setPositiveButton("Scan QR",(dialog,which) -> scanner.launch(new ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setBeepEnabled(false).setPrompt("Scan desktop T3 pairing QR")))
            .setNeutralButton("Use pasted payload",(dialog,which) -> claim(input.getText().toString())).setNegativeButton("Cancel",null).show();
    }
    private void claim(String payload) {
        PairingState loaded;
        try { loaded = new PairingVault(this).load(); }
        catch (Exception stored) { loaded = null; }
        final PairingState previous = loaded;
        try {
            if (previous != null) {
                // Check foreign identity before showing any replacement action or sending a claim.
                PairingState.validateReplacement(payload, previous, true);
                new AlertDialog.Builder(this).setTitle("Confirm replacement pairing")
                    .setMessage("Trust only a new QR generated on your desktop for the same library. Replace the saved certificate and device authorization? Existing offline copy and queued edits stay intact; normal same-library reconnect can resume synchronization. If the library identity differs, keep this connection and export queued work first.")
                    .setPositiveButton("Replace pairing; keep offline work", (d,w) -> claimConfirmed(payload, previous))
                    .setNegativeButton("Keep current pairing", null).show(); return;
            }
            // An unreadable vault self-heals here: the fresh claim simply overwrites it.
            claimConfirmed(payload, null);
        } catch (Exception e) {
            boolean foreignLibrary = e instanceof SecurityException
                && String.valueOf(e.getMessage()).startsWith("Different library");
            AlertDialog.Builder builder = new AlertDialog.Builder(this).setTitle("Re-pair refused")
                .setMessage("Re-pair refused: different library or unreadable saved authorization. Keep your offline copy and queued edits; export queued work before choosing a separate library."
                    + (foreignLibrary ? "\n\nThe QR belongs to another library. You may explicitly forget this device's saved pairing and pair that library instead; what this device stored for the old library stays on disk but can never synchronize again."
                    : ""))
                .setPositiveButton("Keep current pairing", null);
            if (foreignLibrary) builder.setNegativeButton("Forget pairing; pair the new library", (d,w) -> { new PairingVault(this).clear(); claimConfirmed(payload, null); });
            builder.show();
        }
    }
    private void claimConfirmed(String payload, PairingState previous) {
        Executors.newSingleThreadExecutor().execute(() -> {
            try { PairingState.validateReplacement(payload, previous, true); PairingState paired = PairingState.claim(payload); new PairingVault(this).save(paired); runOnUiThread(() -> { new AlertDialog.Builder(this).setMessage("Encrypted connection paired. Offline work was kept.").setPositiveButton("OK",(d,w) -> bridge.getWebView().reload()).show(); }); }
            catch (Exception e) {
                // The generic verdict told the person nothing; name the actual cause.
                String reason;
                if (e instanceof java.io.IOException) reason = "the desktop could not be reached at the QR's address";
                else if (e instanceof javax.net.ssl.SSLException) reason = "the desktop certificate did not match the QR's fingerprint";
                else reason = e.getMessage() == null || e.getMessage().isEmpty() ? e.getClass().getSimpleName() : e.getMessage();
                runOnUiThread(() -> new AlertDialog.Builder(this).setMessage("Pairing failed — " + reason
                    + ".\n\nCreate a fresh QR on the desktop (Settings → Encrypted mobile connection); it expires in 2 minutes, so scan it right away. Offline work was kept.")
                    .setPositiveButton("OK",null).show());
            }
        });
    }
}
