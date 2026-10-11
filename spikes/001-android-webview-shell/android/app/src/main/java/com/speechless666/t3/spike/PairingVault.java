package com.speechless666.t3.spike;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.nio.charset.StandardCharsets;

/** Only app-private ciphertext is persisted. Corruption/missing Keystore authority fails closed. */
public final class PairingVault {
    private static final String ALIAS = "t3.paired.transport.v1";
    private final SharedPreferences preferences;
    public PairingVault(Context context) { preferences = context.getSharedPreferences("t3-paired-transport",Context.MODE_PRIVATE); }
    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(ALIAS)) {
            if (!create) throw new SecurityException("Pairing encryption key unavailable");
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            return generator.generateKey();
        }
        return (SecretKey)store.getKey(ALIAS,null);
    }
    public synchronized void save(PairingState state) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE,key(true));
        byte[] bytes = cipher.doFinal(state.serialize().toString().getBytes(StandardCharsets.UTF_8));
        if (!preferences.edit().putString("ciphertext", Base64.encodeToString(bytes,Base64.NO_WRAP)).putString("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)).commit()) throw new SecurityException("Unable to save pairing");
    }
    /** Explicit user action only: the stored offline copy stays, but it can never synchronize again. */
    public synchronized void clear() { preferences.edit().clear().commit(); cachedCiphertext = null; cachedState = null; }
    /**
     * Decrypting through the Android Keystore is a hardware round-trip, and it was paid
     * again for every single API and media request on the phone — measured as one of the
     * costs that starved the page behind the media download. The decrypted state is kept
     * while the stored ciphertext is unchanged, and that ciphertext is the invalidation
     * too: a re-pair or a clear writes a new (or no) ciphertext, in this process or another.
     */
    private static volatile String cachedCiphertext;
    private static volatile PairingState cachedState;
    public synchronized PairingState load() throws Exception {
        if (!preferences.contains("ciphertext") && !preferences.contains("iv")) { cachedCiphertext = null; cachedState = null; return null; }
        if (!preferences.getAll().keySet().equals(new java.util.HashSet<>(java.util.Arrays.asList("ciphertext","iv")))) throw new SecurityException("Invalid pairing storage shape");
        String ciphertext = preferences.getString("ciphertext",null), iv = preferences.getString("iv",null);
        if (ciphertext == null || iv == null || ciphertext.length() > 16384 || iv.length() > 64) throw new SecurityException("Invalid pairing storage");
        PairingState cached = cachedState;
        if (cached != null && ciphertext.equals(cachedCiphertext)) return cached;
        byte[] initialization = Base64.decode(iv,Base64.NO_WRAP); if (initialization.length != 12) throw new SecurityException("Invalid pairing IV");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE,key(false),new GCMParameterSpec(128,initialization));
        PairingState state = PairingState.parse(new String(cipher.doFinal(Base64.decode(ciphertext,Base64.NO_WRAP)),StandardCharsets.UTF_8));
        cachedCiphertext = ciphertext; cachedState = state;
        return state;
    }
}
