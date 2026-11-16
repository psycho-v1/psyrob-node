package com.psyrob.suite.core;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** BIP-32 private key derivation on secp256k1; accounts use MetaMask's path m/44'/60'/0'/0/i. */
public final class Bip32 {
    private Bip32() {}

    public static String accountPath(int i) { return "m/44'/60'/0'/0/" + i; }

    /** The 32-byte private key at `path` (for example m/44'/60'/0'/0/0) from a BIP-39 seed. */
    public static byte[] derive(byte[] seed, String path) {
        byte[] I = hmac("Bitcoin seed".getBytes(StandardCharsets.US_ASCII), seed);
        byte[] k = java.util.Arrays.copyOfRange(I, 0, 32), c = java.util.Arrays.copyOfRange(I, 32, 64);
        String[] parts = path.split("/");
        if (!parts[0].equals("m")) throw new IllegalArgumentException("path must start with m");
        for (int i = 1; i < parts.length; i++) {
            String p = parts[i];
            boolean hard = p.endsWith("'") || p.endsWith("h");
            long idx = Long.parseLong(hard ? p.substring(0, p.length() - 1) : p);
            if (hard) idx += 0x80000000L;
            byte[] data = new byte[37];
            if (hard) { System.arraycopy(k, 0, data, 1, 32); }
            else {
                byte[] pub = Secp256k1.publicKey(k); // x ‖ y
                data[0] = (byte) ((pub[63] & 1) == 0 ? 2 : 3);
                System.arraycopy(pub, 0, data, 1, 32);
            }
            data[33] = (byte) (idx >>> 24); data[34] = (byte) (idx >>> 16); data[35] = (byte) (idx >>> 8); data[36] = (byte) idx;
            byte[] J = hmac(c, data);
            BigInteger il = new BigInteger(1, java.util.Arrays.copyOfRange(J, 0, 32));
            BigInteger child = il.add(new BigInteger(1, k)).mod(Secp256k1.N);
            if (il.compareTo(Secp256k1.N) >= 0 || child.signum() == 0) throw new IllegalStateException("invalid child key; use the next index");
            k = Hex.fixed(child, 32);
            c = java.util.Arrays.copyOfRange(J, 32, 64);
        }
        return k;
    }

    private static byte[] hmac(byte[] key, byte[] data) {
        try {
            Mac m = Mac.getInstance("HmacSHA512");
            m.init(new SecretKeySpec(key, "HmacSHA512"));
            return m.doFinal(data);
        } catch (Exception e) { throw new IllegalStateException(e); }
    }
}
