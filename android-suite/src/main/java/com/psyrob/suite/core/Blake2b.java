package com.psyrob.suite.core;

/** BLAKE2b (RFC 7693), unkeyed, variable output length 1..64. Used by Argon2d. */
public final class Blake2b {
    private static final long[] IV = {
        0x6a09e667f3bcc908L, 0xbb67ae8584caa73bL, 0x3c6ef372fe94f82bL, 0xa54ff53a5f1d36f1L,
        0x510e527fade682d1L, 0x9b05688c2b3e6c1fL, 0x1f83d9abfb41bd6bL, 0x5be0cd19137e2179L };
    private static final byte[][] SIGMA = {
        {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
        {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
        {11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4},
        {7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
        {9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13},
        {2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
        {12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11},
        {13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
        {6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5},
        {10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
        {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
        {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3} };

    private final long[] h = new long[8];
    private final long[] v = new long[16];
    private final long[] m = new long[16];
    private final byte[] buf = new byte[128];
    private int bufLen;
    private long t0, t1;
    private int outLen;

    public Blake2b(int outLen) { init(outLen); }

    public void init(int outLen) {
        if (outLen < 1 || outLen > 64) throw new IllegalArgumentException("blake2b: bad output length");
        this.outLen = outLen;
        System.arraycopy(IV, 0, h, 0, 8);
        h[0] ^= 0x01010000L ^ outLen;
        bufLen = 0; t0 = 0; t1 = 0;
    }

    public void update(byte[] in, int off, int len) {
        while (len > 0) {
            if (bufLen == 128) {
                incr(128);
                compress(buf, 0, false);
                bufLen = 0;
            }
            int n = Math.min(128 - bufLen, len);
            System.arraycopy(in, off, buf, bufLen, n);
            bufLen += n; off += n; len -= n;
        }
    }

    public void update(byte[] in) { update(in, 0, in.length); }

    public void updateLE32(int x) {
        byte[] b = { (byte) x, (byte) (x >>> 8), (byte) (x >>> 16), (byte) (x >>> 24) };
        update(b, 0, 4);
    }

    public void doFinal(byte[] out, int off) {
        incr(bufLen);
        for (int i = bufLen; i < 128; i++) buf[i] = 0;
        compress(buf, 0, true);
        for (int i = 0; i < outLen; i++) out[off + i] = (byte) (h[i >>> 3] >>> (8 * (i & 7)));
    }

    public byte[] doFinal() { byte[] o = new byte[outLen]; doFinal(o, 0); return o; }

    private void incr(int n) {
        t0 += n;
        if ((t0 + Long.MIN_VALUE) < ((long) n + Long.MIN_VALUE)) t1++; // unsigned carry (API 24 has no compareUnsigned)
    }

    private void compress(byte[] block, int off, boolean last) {
        for (int i = 0; i < 16; i++) m[i] = le64(block, off + 8 * i);
        System.arraycopy(h, 0, v, 0, 8);
        System.arraycopy(IV, 0, v, 8, 8);
        v[12] ^= t0; v[13] ^= t1;
        if (last) v[14] = ~v[14];
        for (int r = 0; r < 12; r++) {
            byte[] s = SIGMA[r];
            g(0, 4, 8, 12, m[s[0]], m[s[1]]);
            g(1, 5, 9, 13, m[s[2]], m[s[3]]);
            g(2, 6, 10, 14, m[s[4]], m[s[5]]);
            g(3, 7, 11, 15, m[s[6]], m[s[7]]);
            g(0, 5, 10, 15, m[s[8]], m[s[9]]);
            g(1, 6, 11, 12, m[s[10]], m[s[11]]);
            g(2, 7, 8, 13, m[s[12]], m[s[13]]);
            g(3, 4, 9, 14, m[s[14]], m[s[15]]);
        }
        for (int i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
    }

    private void g(int a, int b, int c, int d, long x, long y) {
        long[] v = this.v;
        v[a] = v[a] + v[b] + x; v[d] = Long.rotateRight(v[d] ^ v[a], 32);
        v[c] = v[c] + v[d];     v[b] = Long.rotateRight(v[b] ^ v[c], 24);
        v[a] = v[a] + v[b] + y; v[d] = Long.rotateRight(v[d] ^ v[a], 16);
        v[c] = v[c] + v[d];     v[b] = Long.rotateRight(v[b] ^ v[c], 63);
    }

    static long le64(byte[] b, int o) {
        return (b[o] & 0xffL) | (b[o + 1] & 0xffL) << 8 | (b[o + 2] & 0xffL) << 16 | (b[o + 3] & 0xffL) << 24
            | (b[o + 4] & 0xffL) << 32 | (b[o + 5] & 0xffL) << 40 | (b[o + 6] & 0xffL) << 48 | (b[o + 7] & 0xffL) << 56;
    }
}
