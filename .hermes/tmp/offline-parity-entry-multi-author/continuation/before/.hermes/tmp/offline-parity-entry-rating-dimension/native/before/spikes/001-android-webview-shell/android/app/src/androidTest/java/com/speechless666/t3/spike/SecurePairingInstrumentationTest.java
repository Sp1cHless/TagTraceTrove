package com.speechless666.t3.spike;

import android.content.Context;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Compile-only here. Requires an explicitly authorized Android test device to execute. */
@RunWith(AndroidJUnit4.class)
public class SecurePairingInstrumentationTest {
    @Test public void actualActivityOffersExplicitCameraAndPasteChoices() {
        try (androidx.test.core.app.ActivityScenario<MainActivity> scenario = androidx.test.core.app.ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(MainActivity::showPairingDialog);
            androidx.test.espresso.Espresso.onView(androidx.test.espresso.matcher.ViewMatchers.withText("Scan QR"))
                .check(androidx.test.espresso.assertion.ViewAssertions.matches(androidx.test.espresso.matcher.ViewMatchers.isDisplayed()));
            androidx.test.espresso.Espresso.onView(androidx.test.espresso.matcher.ViewMatchers.withText("Use pasted payload"))
                .check(androidx.test.espresso.assertion.ViewAssertions.matches(androidx.test.espresso.matcher.ViewMatchers.isDisplayed()));
            androidx.test.espresso.Espresso.onView(androidx.test.espresso.matcher.ViewMatchers.withText("Cancel"))
                .perform(androidx.test.espresso.action.ViewActions.click());
        }
    }
    @Test public void realWebViewMediaInterceptionFailsClosedWithoutPairing() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        org.junit.Assume.assumeTrue("Do not modify an existing device pairing",new PairingVault(context).load() == null);
        try (androidx.test.core.app.ActivityScenario<MainActivity> scenario = androidx.test.core.app.ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                android.webkit.WebView view = activity.getBridge().getWebView();
                android.webkit.WebResourceRequest request = new android.webkit.WebResourceRequest() {
                    public android.net.Uri getUrl() { return android.net.Uri.parse("https://localhost/api/assets/entries/1/cover.webp"); }
                    public boolean isForMainFrame() { return false; }
                    public boolean isRedirect() { return false; }
                    public boolean hasGesture() { return false; }
                    public String getMethod() { return "GET"; }
                    public java.util.Map<String,String> getRequestHeaders() { return java.util.Collections.emptyMap(); }
                };
                assertEquals(503,view.getWebViewClient().shouldInterceptRequest(view,request).getStatusCode());
            });
        }
    }
    @Test public void scannerUsesRealCaptureActivityAndDecodesSelectedResult() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        ScanContract scanner = new ScanContract();
        Intent launch = scanner.createIntent(context,new ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE));
        assertNotNull(launch.getComponent());
        assertTrue(launch.getComponent().getClassName().contains("CaptureActivity"));
        assertNull(scanner.parseResult(android.app.Activity.RESULT_CANCELED,null).getContents());
        Intent result = new Intent().putExtra("SCAN_RESULT","selected-desktop-qr").putExtra("SCAN_RESULT_FORMAT","QR_CODE");
        assertEquals("selected-desktop-qr",scanner.parseResult(android.app.Activity.RESULT_OK,result).getContents());
    }
    @Test public void keystoreCiphertextSurvivesNewVaultAndCorruptionFailsClosed() throws Exception {
        // These tests are intentionally test-package private, never use target user preferences.
        Context context = InstrumentationRegistry.getInstrumentation().getContext();
        android.content.SharedPreferences prefs = context.getSharedPreferences("t3-paired-transport",Context.MODE_PRIVATE);
        assertTrue(prefs.edit().clear().commit());
        PairingState state = PairingState.parse(new JSONObject().put("version",1).put("endpoint","https://192.168.1.2")
            .put("certificateSha256","a".repeat(64)).put("libraryId","isolated-test-library")
            .put("deviceId","12345678-1234-1234-1234-123456789abc").put("token","a".repeat(43)).toString());
        try {
            new PairingVault(context).save(state);
            assertFalse(prefs.getAll().toString().contains(state.token));
            assertEquals(state.serialize().toString(),new PairingVault(context).load().serialize().toString());
            assertTrue(prefs.edit().putString("ciphertext","corrupted").commit());
            try { new PairingVault(context).load(); fail("Damaged encryption admitted"); } catch (Exception expected) { }
        } finally { assertTrue(prefs.edit().clear().commit()); }
    }
}
