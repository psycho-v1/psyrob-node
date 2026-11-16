package com.psyrob.suite.core;

/** Keccak-256 (the Ethereum hash: original Keccak padding 0x01, not SHA3-256). */
public final class Keccak256 {
    private static final long[] RC = {
        0x0000000000000001L, 0x0000000000008082L, 0x800000000000808aL, 0x8000000080008000L,
        0x000000000000808bL, 0x0000000080000001L, 0x8000000080008081L, 0x8000000000008009L,
        0x000000000000008aL, 0x0000000000000088L, 0x0000000080008009L, 0x000000008000000aL,
        0x000000008000808bL, 0x800000000000008bL, 0x8000000000008089L, 0x8000000000008003L,
        0x8000000000008002L, 0x8000000000000080L, 0x000000000000800aL, 0x800000008000000aL,
        0x8000000080008081L, 0x8000000000008080L, 0x0000000080000001L, 0x8000000080008008L };
    private static final int[] ROT = {
        0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14 };
    private static final int RATE = 136;

    private Keccak256() {}

    public static byte[] hash(byte[] in) { return hash(in, 0, in.length); }

    public static byte[] hash(byte[] in, int off, int len) {
        long[] s = new long[25];
        byte[] block = new byte[RATE];
        int pos = off, end = off + len;
        while (end - pos >= RATE) {
            absorb(s, in, pos);
            pos += RATE;
        }
        int rem = end - pos;
        System.arraycopy(in, pos, block, 0, rem);
        block[rem] ^= 0x01;
        block[RATE - 1] ^= (byte) 0x80;
        absorb(s, block, 0);
        byte[] out = new byte[32];
        for (int i = 0; i < 32; i++) out[i] = (byte) (s[i >>> 3] >>> (8 * (i & 7)));
        return out;
    }

    public static byte[] hash(byte[] a, byte[] b) {
        byte[] c = new byte[a.length + b.length];
        System.arraycopy(a, 0, c, 0, a.length);
        System.arraycopy(b, 0, c, a.length, b.length);
        return hash(c);
    }

    private static void absorb(long[] s, byte[] b, int off) {
        for (int i = 0; i < RATE / 8; i++) s[i] ^= Blake2b.le64(b, off + 8 * i);
        keccakF(s);
    }

    private static void keccakF(long[] a) {
        long[] c = new long[5];
        long[] b = new long[25];
        for (int round = 0; round < 24; round++) {
            for (int x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
            for (int x = 0; x < 5; x++) {
                long d = c[(x + 4) % 5] ^ Long.rotateLeft(c[(x + 1) % 5], 1);
                for (int y = 0; y < 25; y += 5) a[y + x] ^= d;
            }
            for (int x = 0; x < 5; x++)
                for (int y = 0; y < 5; y++)
                    b[y + 5 * ((2 * x + 3 * y) % 5)] = Long.rotateLeft(a[x + 5 * y], ROT[x + 5 * y]);
            for (int x = 0; x < 5; x++)
                for (int y = 0; y < 25; y += 5)
                    a[y + x] = b[y + x] ^ (~b[y + (x + 1) % 5] & b[y + (x + 2) % 5]);
            a[0] ^= RC[round];
        }
    }
}
