package com.speechless666.t3.spike;

import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Device SQLite proof; compilation is not execution or process-death proof. */
@RunWith(AndroidJUnit4.class)
public class TransferLedgerTest {
    @Test public void coldOpenPreservesExactBodyAndBinaryAndRejectsCollision() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
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
}
