package com.psyrob.suite.core;

import java.math.BigInteger;
import java.security.SecureRandom;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * secp256k1 for the miner wallet: key generation, addresses, and recoverable low-s ECDSA signatures with
 * deterministic nonces (RFC 6979, HMAC-SHA256), as common/crypto.js signDigest() in psyrob-node.
 * Fixed-base multiplication uses a precomputed 4-bit window table, so one signature costs about 64 point additions.
 */
public final class Secp256k1 {
    public static final BigInteger P = new BigInteger("fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f", 16);
    public static final BigInteger N = new BigInteger("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16);
    public static final BigInteger HALF_N = N.shiftRight(1);
    private static final BigInteger GX = new BigInteger("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", 16);
    private static final BigInteger GY = new BigInteger("483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8", 16);
    private static final BigInteger THREE = BigInteger.valueOf(3);
    private static final BigInteger SEVEN = BigInteger.valueOf(7);

    /** Affine point table: TABLE[w][d] = d * 16^w * G, for 64 windows of 4 bits. */
    private static volatile BigInteger[][][] table;

    private Secp256k1() {}

    // ---- Jacobian arithmetic (x, y, z); z == 0 is infinity ----

    private static BigInteger[] dbl(BigInteger[] p) {
        if (p[2].signum() == 0 || p[1].signum() == 0) return new BigInteger[] { BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO };
        BigInteger x = p[0], y = p[1], z = p[2];
        BigInteger ysq = y.multiply(y).mod(P);
        BigInteger s = x.multiply(ysq).shiftLeft(2).mod(P);
        BigInteger m = x.multiply(x).multiply(THREE).mod(P);
        BigInteger nx = m.multiply(m).subtract(s.shiftLeft(1)).mod(P);
        BigInteger ny = m.multiply(s.subtract(nx)).subtract(ysq.multiply(ysq).shiftLeft(3)).mod(P);
        BigInteger nz = y.multiply(z).shiftLeft(1).mod(P);
        return new BigInteger[] { nx, ny, nz };
    }

    /** Jacobian p + affine q (q != infinity). */
    private static BigInteger[] addMixed(BigInteger[] p, BigInteger qx, BigInteger qy) {
        if (p[2].signum() == 0) return new BigInteger[] { qx, qy, BigInteger.ONE };
        BigInteger z2 = p[2].multiply(p[2]).mod(P);
        BigInteger u2 = qx.multiply(z2).mod(P);
        BigInteger s2 = qy.multiply(z2).multiply(p[2]).mod(P);
        BigInteger h = u2.subtract(p[0]).mod(P);
        BigInteger r = s2.subtract(p[1]).mod(P);
        if (h.signum() == 0) {
            if (r.signum() == 0) return dbl(new BigInteger[] { qx, qy, BigInteger.ONE });
            return new BigInteger[] { BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO };
        }
        BigInteger h2 = h.multiply(h).mod(P);
        BigInteger h3 = h2.multiply(h).mod(P);
        BigInteger v = p[0].multiply(h2).mod(P);
        BigInteger nx = r.multiply(r).subtract(h3).subtract(v.shiftLeft(1)).mod(P);
        BigInteger ny = r.multiply(v.subtract(nx)).subtract(p[1].multiply(h3)).mod(P);
        BigInteger nz = p[2].multiply(h).mod(P);
        return new BigInteger[] { nx, ny, nz };
    }

    private static BigInteger[] toAffine(BigInteger[] p) {
        if (p[2].signum() == 0) return null;
        BigInteger zi = p[2].modInverse(P);
        BigInteger zi2 = zi.multiply(zi).mod(P);
        return new BigInteger[] { p[0].multiply(zi2).mod(P), p[1].multiply(zi2).multiply(zi).mod(P) };
    }

    private static BigInteger[][][] table() {
        BigInteger[][][] t = table;
        if (t != null) return t;
        synchronized (Secp256k1.class) {
            if (table != null) return table;
            t = new BigInteger[64][16][];
            BigInteger[] base = { GX, GY, BigInteger.ONE };
            for (int w = 0; w < 64; w++) {
                BigInteger[] ab = toAffine(base);
                BigInteger[] acc = { BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO };
                for (int d = 1; d < 16; d++) {
                    acc = addMixed(acc, ab[0], ab[1]);
                    t[w][d] = toAffine(acc);
                }
                for (int i = 0; i < 4; i++) base = dbl(base);
            }
            table = t;
            return t;
        }
    }

    /** k * G as affine (x, y). */
    public static BigInteger[] mulG(BigInteger k) {
        BigInteger[][][] t = table();
        BigInteger[] acc = { BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO };
        for (int w = 0; w < 64; w++) {
            int d = 0;
            for (int b = 0; b < 4; b++) if (k.testBit(4 * w + b)) d |= 1 << b;
            if (d != 0) acc = addMixed(acc, t[w][d][0], t[w][d][1]);
        }
        return toAffine(acc);
    }

    // ---- keys ----

    public static byte[] randomPrivateKey() {
        SecureRandom rnd = new SecureRandom();
        byte[] k = new byte[32];
        while (true) {
            rnd.nextBytes(k);
            BigInteger d = new BigInteger(1, k);
            if (d.signum() > 0 && d.compareTo(N) < 0) return k;
        }
    }

    public static boolean isValidPrivateKey(byte[] k) {
        if (k == null || k.length != 32) return false;
        BigInteger d = new BigInteger(1, k);
        return d.signum() > 0 && d.compareTo(N) < 0;
    }

    /** 64-byte uncompressed public key without the 0x04 prefix. */
    public static byte[] publicKey(byte[] sk) {
        BigInteger[] q = mulG(new BigInteger(1, sk));
        byte[] out = new byte[64];
        Hex.putFixed(q[0], out, 0, 32);
        Hex.putFixed(q[1], out, 32, 32);
        return out;
    }

    /** 20-byte address: last 20 bytes of keccak256(public key). */
    public static byte[] address(byte[] sk) {
        byte[] h = Keccak256.hash(publicKey(sk));
        byte[] a = new byte[20];
        System.arraycopy(h, 12, a, 0, 20);
        return a;
    }

    // ---- signatures ----

    /** Sign a 32-byte digest: 65 bytes r ‖ s ‖ recovery (0 or 1), low s. */
    public static byte[] sign(byte[] digest, byte[] sk) {
        if (digest.length != 32) throw new IllegalArgumentException("digest must be 32 bytes");
        BigInteger d = new BigInteger(1, sk);
        BigInteger e = new BigInteger(1, digest);
        Rfc6979 gen = new Rfc6979(sk, reduce(digest));
        while (true) {
            BigInteger k = gen.next();
            BigInteger[] rp = mulG(k);
            BigInteger r = rp[0].mod(N);
            if (r.signum() == 0) continue;
            if (rp[0].compareTo(N) >= 0) continue; // recovery id would be 2 or 3; the network takes only 0 or 1
            BigInteger s = k.modInverse(N).multiply(e.add(r.multiply(d))).mod(N);
            if (s.signum() == 0) continue;
            int rec = rp[1].testBit(0) ? 1 : 0;
            if (s.compareTo(HALF_N) > 0) { s = N.subtract(s); rec ^= 1; }
            byte[] out = new byte[65];
            Hex.putFixed(r, out, 0, 32);
            Hex.putFixed(s, out, 32, 32);
            out[64] = (byte) rec;
            return out;
        }
    }

    /** bits2octets of RFC 6979: the digest as an integer mod n, 32 bytes. */
    private static byte[] reduce(byte[] digest) {
        BigInteger z = new BigInteger(1, digest);
        if (z.compareTo(N) >= 0) z = z.subtract(N);
        byte[] o = new byte[32];
        Hex.putFixed(z, o, 0, 32);
        return o;
    }

    /** Recover the 20-byte signer address (used by the self-test). */
    public static byte[] recoverAddress(byte[] digest, byte[] sig) {
        BigInteger r = new BigInteger(1, java.util.Arrays.copyOfRange(sig, 0, 32));
        BigInteger s = new BigInteger(1, java.util.Arrays.copyOfRange(sig, 32, 64));
        int rec = sig[64];
        BigInteger x = r;
        BigInteger alpha = x.pow(3).add(SEVEN).mod(P);
        BigInteger y = alpha.modPow(P.add(BigInteger.ONE).shiftRight(2), P);
        if (y.testBit(0) != (rec == 1)) y = P.subtract(y);
        BigInteger e = new BigInteger(1, digest);
        BigInteger ri = r.modInverse(N);
        BigInteger u1 = N.subtract(e).multiply(ri).mod(N);
        BigInteger u2 = s.multiply(ri).mod(N);
        BigInteger[] a = mulG(u1);
        BigInteger[] b = mul(x, y, u2);
        BigInteger[] sum = a == null ? new BigInteger[] { b[0], b[1], BigInteger.ONE } : addMixed(new BigInteger[] { a[0], a[1], BigInteger.ONE }, b[0], b[1]);
        BigInteger[] q = toAffine(sum);
        byte[] pub = new byte[64];
        Hex.putFixed(q[0], pub, 0, 32);
        Hex.putFixed(q[1], pub, 32, 32);
        byte[] h = Keccak256.hash(pub);
        return java.util.Arrays.copyOfRange(h, 12, 32);
    }

    private static BigInteger[] mul(BigInteger px, BigInteger py, BigInteger k) {
        BigInteger[] acc = { BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO };
        for (int i = k.bitLength() - 1; i >= 0; i--) {
            acc = dbl(acc);
            if (k.testBit(i)) acc = addMixed(acc, px, py);
        }
        return toAffine(acc);
    }

    /** RFC 6979 section 3.2 deterministic k with HMAC-SHA256. */
    private static final class Rfc6979 {
        private byte[] v = new byte[32];
        private byte[] k = new byte[32];
        private final Mac mac;

        Rfc6979(byte[] x, byte[] h1) {
            try { mac = Mac.getInstance("HmacSHA256"); } catch (Exception e) { throw new IllegalStateException(e); }
            java.util.Arrays.fill(v, (byte) 1);
            k = hmac(k, v, new byte[] { 0 }, x, h1);
            v = hmac(k, v);
            k = hmac(k, v, new byte[] { 1 }, x, h1);
            v = hmac(k, v);
        }

        private boolean first = true;

        BigInteger next() {
            if (!first) {
                k = hmac(k, v, new byte[] { 0 });
                v = hmac(k, v);
            }
            first = false;
            while (true) {
                v = hmac(k, v);
                BigInteger t = new BigInteger(1, v);
                if (t.signum() > 0 && t.compareTo(N) < 0) return t;
                k = hmac(k, v, new byte[] { 0 });
                v = hmac(k, v);
            }
        }

        private byte[] hmac(byte[] key, byte[]... parts) {
            try {
                mac.init(new SecretKeySpec(key, "HmacSHA256"));
                for (byte[] p : parts) mac.update(p);
                return mac.doFinal();
            } catch (Exception e) { throw new IllegalStateException(e); }
        }
    }
}
