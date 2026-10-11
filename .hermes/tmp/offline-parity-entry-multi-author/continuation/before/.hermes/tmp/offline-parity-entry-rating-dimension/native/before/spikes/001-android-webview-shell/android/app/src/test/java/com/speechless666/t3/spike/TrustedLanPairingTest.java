package com.speechless666.t3.spike;

import static org.junit.Assert.*;
import org.junit.Test;

public class TrustedLanPairingTest {
    @Test public void acceptsExplicitPrivateIpv4WithOptionalPort() {
        assertEquals("http://10.0.0.1:8765", TrustedLanPairing.validate("http://10.0.0.1:8765/", "library-1").endpoint);
        assertEquals("http://172.31.255.254", TrustedLanPairing.validate("http://172.31.255.254", "library-1").endpoint);
        assertEquals("http://192.168.1.2", TrustedLanPairing.validate("http://192.168.1.2", "library-1").endpoint);
    }

    @Test public void rejectsUnsafeOrAmbiguousEndpoints() {
        String[] invalid = {"http://127.0.0.1", "http://localhost", "http://169.254.1.1", "http://8.8.8.8", "http://172.32.0.1", "http://172.15.0.1", "http://192.169.1.1", "https://10.0.0.1", "http://user:pass@10.0.0.1", "http://10.0.0.1/api", "http://10.0.0.1/?x=1", "http://10.0.0.1/#a", "http://010.0.0.1", "http://0x0a.0.0.1", "http://10.0.0.1:0", "http://10.0.0.1:65536", "http://10.0.0.1\\@evil.test"};
        for (String endpoint : invalid) {
            try { TrustedLanPairing.validate(endpoint, "library-1"); fail(endpoint); }
            catch (IllegalArgumentException expected) { /* fail closed */ }
        }
    }

    @Test public void requiresNonemptyLibraryIdentity() {
        try { TrustedLanPairing.validate("http://10.0.0.1", " "); fail("missing identity"); }
        catch (IllegalArgumentException expected) { /* required */ }
    }
}
