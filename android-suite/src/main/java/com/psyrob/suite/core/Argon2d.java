package com.psyrob.suite.core;

/**
 * Argon2d (RFC 9106, version 0x13), one lane, 32-byte output: the PSYROB proof of work
 * (common/pow.js in psyrob-node). One instance per thread; the working memory is reused between calls,
 * so a 32 MiB hash allocates nothing after the first call.
 */
public final class Argon2d {
    private static final int BLOCK_LONGS = 128; // 1 KiB
    private static final int VERSION = 0x13;

    private long[] mem = new long[0];
    private final long[] r = new long[BLOCK_LONGS];
    private final long[] z = new long[BLOCK_LONGS];
    private final byte[] blockBytes = new byte[1024];
    private final byte[] h0 = new byte[72];
    private final Blake2b b64 = new Blake2b(64);

    /** Argon2d(password, salt, m = memoryKiB, t = iterations, p = 1) -> 32 bytes. */
    public byte[] hash(byte[] pwd, byte[] salt, int memoryKiB, int iterations) {
        if (memoryKiB < 8) throw new IllegalArgumentException("argon2: memory below 8 KiB");
        if (iterations < 1) throw new IllegalArgumentException("argon2: iterations below 1");
        int blocks = (memoryKiB / 4) * 4;
        int seg = blocks / 4;
        int laneLen = blocks;
        if (mem.length != blocks * BLOCK_LONGS) mem = new long[blocks * BLOCK_LONGS];
        long[] m = mem;

        // H0
        Blake2b b = b64;
        b.init(64);
        b.updateLE32(1); b.updateLE32(32); b.updateLE32(memoryKiB); b.updateLE32(iterations);
        b.updateLE32(VERSION); b.updateLE32(0 /* Argon2d */);
        b.updateLE32(pwd.length); b.update(pwd);
        b.updateLE32(salt.length); b.update(salt);
        b.updateLE32(0); b.updateLE32(0);
        b.doFinal(h0, 0);

        // first two blocks
        for (int i = 0; i < 2; i++) {
            h0[64] = (byte) i; h0[65] = 0; h0[66] = 0; h0[67] = 0;
            h0[68] = 0; h0[69] = 0; h0[70] = 0; h0[71] = 0;
            hPrime(blockBytes, 1024, h0, 72);
            for (int k = 0; k < BLOCK_LONGS; k++) m[i * BLOCK_LONGS + k] = Blake2b.le64(blockBytes, 8 * k);
        }

        for (int pass = 0; pass < iterations; pass++) {
            for (int slice = 0; slice < 4; slice++) {
                int start = (pass == 0 && slice == 0) ? 2 : 0;
                for (int i = start; i < seg; i++) {
                    int cur = slice * seg + i;
                    int prev = cur == 0 ? laneLen - 1 : cur - 1;
                    long rand = m[prev * BLOCK_LONGS];
                    long j1 = rand & 0xffffffffL;
                    long area;
                    if (pass == 0) area = slice == 0 ? i - 1 : (long) slice * seg + i - 1;
                    else area = (long) laneLen - seg + i - 1;
                    long rel = (j1 * j1) >>> 32;
                    rel = area - 1 - ((area * rel) >>> 32);
                    long startPos = (pass != 0 && slice != 3) ? (long) (slice + 1) * seg : 0;
                    int ref = (int) ((startPos + rel) % laneLen);
                    fill(m, prev * BLOCK_LONGS, ref * BLOCK_LONGS, cur * BLOCK_LONGS, pass != 0);
                }
            }
        }

        int last = (laneLen - 1) * BLOCK_LONGS;
        for (int k = 0; k < BLOCK_LONGS; k++) {
            long x = m[last + k];
            for (int j = 0; j < 8; j++) blockBytes[8 * k + j] = (byte) (x >>> (8 * j));
        }
        byte[] out = new byte[32];
        hPrime(out, 32, blockBytes, 1024);
        return out;
    }

    /** H' (variable-length hash) of RFC 9106 section 3.3. */
    private void hPrime(byte[] out, int outLen, byte[] in, int inLen) {
        Blake2b b = b64;
        if (outLen <= 64) {
            b.init(outLen); b.updateLE32(outLen); b.update(in, 0, inLen); b.doFinal(out, 0);
            return;
        }
        byte[] v = new byte[64];
        b.init(64); b.updateLE32(outLen); b.update(in, 0, inLen); b.doFinal(v, 0);
        System.arraycopy(v, 0, out, 0, 32);
        int pos = 32;
        int rem = outLen - 32;
        while (rem > 64) {
            b.init(64); b.update(v, 0, 64); b.doFinal(v, 0);
            System.arraycopy(v, 0, out, pos, 32);
            pos += 32; rem -= 32;
        }
        b.init(rem); b.update(v, 0, 64);
        byte[] lastV = new byte[rem];
        b.doFinal(lastV, 0);
        System.arraycopy(lastV, 0, out, pos, rem);
    }

    private void fill(long[] m, int prev, int ref, int next, boolean withXor) {
        long[] r = this.r, z = this.z;
        for (int k = 0; k < BLOCK_LONGS; k++) { long x = m[prev + k] ^ m[ref + k]; r[k] = x; z[k] = x; }
        if (withXor) for (int k = 0; k < BLOCK_LONGS; k++) z[k] ^= m[next + k];
        for (int i = 0; i < 8; i++) {
            int o = 16 * i;
            round(z, o, o + 1, o + 2, o + 3, o + 4, o + 5, o + 6, o + 7, o + 8, o + 9, o + 10, o + 11, o + 12, o + 13, o + 14, o + 15);
        }
        for (int i = 0; i < 8; i++) {
            int o = 2 * i;
            round(z, o, o + 1, o + 16, o + 17, o + 32, o + 33, o + 48, o + 49, o + 64, o + 65, o + 80, o + 81, o + 96, o + 97, o + 112, o + 113);
        }
        for (int k = 0; k < BLOCK_LONGS; k++) m[next + k] = z[k] ^ r[k];
    }

    private static void round(long[] v, int i0, int i1, int i2, int i3, int i4, int i5, int i6, int i7,
                              int i8, int i9, int i10, int i11, int i12, int i13, int i14, int i15) {
        gb(v, i0, i4, i8, i12); gb(v, i1, i5, i9, i13); gb(v, i2, i6, i10, i14); gb(v, i3, i7, i11, i15);
        gb(v, i0, i5, i10, i15); gb(v, i1, i6, i11, i12); gb(v, i2, i7, i8, i13); gb(v, i3, i4, i9, i14);
    }

    private static void gb(long[] v, int a, int b, int c, int d) {
        long va = v[a], vb = v[b], vc = v[c], vd = v[d];
        va = va + vb + 2 * (va & 0xffffffffL) * (vb & 0xffffffffL); vd = Long.rotateRight(vd ^ va, 32);
        vc = vc + vd + 2 * (vc & 0xffffffffL) * (vd & 0xffffffffL); vb = Long.rotateRight(vb ^ vc, 24);
        va = va + vb + 2 * (va & 0xffffffffL) * (vb & 0xffffffffL); vd = Long.rotateRight(vd ^ va, 16);
        vc = vc + vd + 2 * (vc & 0xffffffffL) * (vd & 0xffffffffL); vb = Long.rotateRight(vb ^ vc, 63);
        v[a] = va; v[b] = vb; v[c] = vc; v[d] = vd;
    }
}
