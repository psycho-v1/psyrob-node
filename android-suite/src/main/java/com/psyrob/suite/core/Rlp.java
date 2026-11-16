package com.psyrob.suite.core;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.util.List;

/** RLP encoding (strings and nested lists), the canonical form of common/rlp.js. */
public final class Rlp {
    private Rlp() {}

    public static byte[] str(byte[] b) {
        if (b.length == 1 && (b[0] & 0xff) < 0x80) return b.clone();
        return concat(length(b.length, 0x80), b);
    }

    public static byte[] integer(BigInteger n) { return str(Hex.minimal(n)); }

    public static byte[] integer(long n) { return integer(BigInteger.valueOf(n)); }

    /** A list whose items are already RLP-encoded. */
    public static byte[] list(List<byte[]> encodedItems) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (byte[] e : encodedItems) body.write(e, 0, e.length);
        return wrapList(body.toByteArray());
    }

    public static byte[] wrapList(byte[] body) { return concat(length(body.length, 0xc0), body); }

    static byte[] length(int len, int offset) {
        if (len < 56) return new byte[] { (byte) (offset + len) };
        byte[] lb = Hex.minimal(BigInteger.valueOf(len));
        byte[] out = new byte[1 + lb.length];
        out[0] = (byte) (offset + 55 + lb.length);
        System.arraycopy(lb, 0, out, 1, lb.length);
        return out;
    }

    public static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p.length;
        byte[] out = new byte[n];
        int o = 0;
        for (byte[] p : parts) { System.arraycopy(p, 0, out, o, p.length); o += p.length; }
        return out;
    }
}
