package com.speechless666.t3.spike;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Strict syntax gate for the trusted-LAN prototype. Not authentication or TLS. */
public final class TrustedLanPairing {
    private static final Pattern ENDPOINT = Pattern.compile(
        "^http://([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})(?::([0-9]{1,5}))?/?$"
    );
    public final String endpoint;
    public final String libraryId;

    private TrustedLanPairing(String endpoint, String libraryId) {
        this.endpoint = endpoint;
        this.libraryId = libraryId;
    }

    public static TrustedLanPairing validate(String input, String libraryId) {
        if (input == null || libraryId == null || libraryId.trim().isEmpty()) {
            throw new IllegalArgumentException("Endpoint and library identity are required");
        }
        Matcher matcher = ENDPOINT.matcher(input);
        if (!matcher.matches()) throw new IllegalArgumentException("Only a private IPv4 HTTP origin is allowed");
        int[] octets = new int[4];
        for (int i = 0; i < octets.length; i++) {
            String part = matcher.group(i + 1);
            if (part.length() > 1 && part.startsWith("0")) throw new IllegalArgumentException("Ambiguous IPv4 address");
            octets[i] = Integer.parseInt(part);
            if (octets[i] > 255) throw new IllegalArgumentException("Invalid IPv4 address");
        }
        boolean privateAddress = octets[0] == 10
            || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
            || (octets[0] == 192 && octets[1] == 168);
        if (!privateAddress) throw new IllegalArgumentException("Public, local and link-local endpoints are not allowed");
        String port = matcher.group(5);
        if (port != null && (Integer.parseInt(port) < 1 || Integer.parseInt(port) > 65535)) {
            throw new IllegalArgumentException("Invalid port");
        }
        String origin = "http://" + octets[0] + "." + octets[1] + "." + octets[2] + "." + octets[3]
            + (port == null ? "" : ":" + port);
        return new TrustedLanPairing(origin, libraryId.trim());
    }
}
