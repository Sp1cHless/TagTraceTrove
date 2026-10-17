package com.speechless666.t3.spike;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.JSObject;
import com.getcapacitor.annotation.CapacitorPlugin;
import android.util.Base64;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "T3PairedTransport")
public class PairedTransportPlugin extends Plugin {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    /**
     * Reads never share the ordered lane. The media download runs one picture after
     * another through the same transport the page uses, and behind a 45-second
     * call timeout a single queued media fetch delayed every Entry open — the page
     * showed Home and then filled in field by field while the requests waited.
     * Reads are independent and go wide; mutations keep the single lane so their
     * order is unchanged.
     */
    private final ExecutorService readExecutor = Executors.newFixedThreadPool(4);
    /**
     * Pairing state must not queue behind an API request. The page asks for its
     * own library identity through `status` on every offline read, while the
     * transport's connect timeout can hold the request worker for as long as
     * eight seconds when the paired host is unreachable — measured on device:
     * the same Entry open took 313 ms with no probe in flight and 7674 ms while
     * a capabilities probe was stalled (the read ended with the request).
     */
    private final ExecutorService pairingExecutor = Executors.newSingleThreadExecutor();
    @PluginMethod public void pair(PluginCall call) {
        getActivity().runOnUiThread(() -> ((MainActivity)getActivity()).showPairingDialog());
        call.resolve();
    }
    @PluginMethod public void copyText(PluginCall call) {
        String document = getBridge().getAppUrl();
        String text = call.getString("text");
        if (document == null || !(document.startsWith("https://localhost/") || document.equals("https://localhost")) || text == null) { call.reject("Untrusted clipboard request"); return; }
        getActivity().runOnUiThread(() -> {
            try {
                android.content.ClipboardManager clipboard = (android.content.ClipboardManager)getContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE);
                clipboard.setPrimaryClip(android.content.ClipData.newPlainText("T3", text));
                call.resolve();
            } catch (Exception e) { call.reject("Clipboard unavailable"); }
        });
    }
    @PluginMethod public void status(PluginCall call) {
        // The bundled page's very first call: proof the document rendered at all.
        if (getActivity() instanceof MainActivity) ((MainActivity)getActivity()).markPageBooted();
        pairingExecutor.execute(() -> { try { PairingState state = new PairingVault(getContext()).load(); JSObject result = new JSObject(); result.put("paired",state != null); if (state != null) result.put("libraryId",state.libraryId); call.resolve(result); } catch (Exception e) { call.reject("Pairing storage invalid; pair again without clearing offline work"); } });
    }
    @PluginMethod public void diagnostics(PluginCall call) {
        String document = getBridge().getAppUrl();
        if (document == null || !(document.startsWith("https://localhost/") || document.equals("https://localhost"))) { call.reject("Untrusted document"); return; }
        pairingExecutor.execute(() -> {
            try {
                JSObject result = new JSObject(PairingDiagnostics.snapshot().toString());
                try { result.put("paired", new PairingVault(getContext()).load() != null); result.put("storageReadable", true); }
                catch (Exception stored) { result.put("paired", false); result.put("storageReadable", false); result.put("storageErrorClass", stored.getClass().getSimpleName()); }
                call.resolve(result);
            } catch (Exception error) { call.reject("Pairing diagnostics unavailable"); }
        });
    }
    @PluginMethod public void request(PluginCall call) {
        // Plugins are callable only by the bundled local document; navigation outside it is external.
        // The bridge's app URL is a plain field readable from any thread; reading
        // WebView state here would be a fatal wrong-thread crash.
        String document = getBridge().getAppUrl();
        if (document == null || !(document.startsWith("https://localhost/") || document.equals("https://localhost"))) { call.reject("Untrusted document"); return; }
        String method = call.getString("method","GET");
        boolean read = "GET".equals(method) || "HEAD".equals(method);
        (read ? readExecutor : executor).execute(() -> {
            try {
                PairingState state = new PairingVault(getContext()).load(); if (state == null) throw new SecurityException("Pairing required");
                // A read already carries the token and the server is the authority, so it is
                // not given a second round-trip of its own; a write confirms identity first.
                if (!read) state.verify();
                String body = call.getString("body");
                PinnedLanTransport.Result response = state.transport.request(call.getString("path",""),method,call.getString("contentType"),body == null ? null : Base64.decode(body,Base64.NO_WRAP),state.token);
                JSObject result = new JSObject(); result.put("status",response.status); result.put("url","https://localhost" + response.path); result.put("contentType",response.contentType); result.put("body",Base64.encodeToString(response.bytes,Base64.NO_WRAP)); call.resolve(result);
            } catch (SecurityException | javax.net.ssl.SSLException e) { call.reject("Pairing authority rejected; offline work preserved", "PAIRING_REJECTED"); }
            catch (java.io.IOException e) { call.reject("Network unavailable; offline work preserved", "NETWORK_UNAVAILABLE"); }
            catch (Exception e) { call.reject("Pairing storage or request rejected; offline work preserved", "PAIRING_REJECTED"); }
        });
    }
}
