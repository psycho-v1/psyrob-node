package com.psyrob.suite.core;

import java.math.BigInteger;

public final class Hex {
    private static final char[] DIGITS = "0123456789abcdef".toCharArray();

    private Hex() {}

    public static String encode(byte[] b) {
        char[] c = new char[b.length * 2];
        for (int i = 0; i < b.length; i++) { c[2 * i] = DIGITS[(b[i] >> 4) & 15]; c[2 * i + 1] = DIGITS[b[i] & 15]; }
        return new String(c);
    }

    public static String with0x(byte[] b) { return "0x" + encode(b); }

    /** Decode hex with or without 0x. Throws on odd length or a non-hex character. */
    public static byte[] decode(String s) {
        if (s.startsWith("0x") || s.startsWith("0X")) s = s.substring(2);
        if ((s.length() & 1) != 0) throw new IllegalArgumentException("hex: odd length");
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int hi = Character.digit(s.charAt(2 * i), 16), lo = Character.digit(s.charAt(2 * i + 1), 16);
            if (hi < 0 || lo < 0) throw new IllegalArgumentException("hex: bad character");
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }

    /** Write n big-endian into exactly `width` bytes at out[off]. */
    public static void putFixed(BigInteger n, byte[] out, int off, int width) {
        byte[] b = n.toByteArray();
        int start = 0;
        while (start < b.length - 1 && b[start] == 0) start++;
        int len = b.length - start;
        if (len > width) throw new IllegalArgumentException("number does not fit");
        for (int i = 0; i < width - len; i++) out[off + i] = 0;
        System.arraycopy(b, start, out, off + width - len, len);
    }

    public static byte[] fixed(BigInteger n, int width) { byte[] o = new byte[width]; putFixed(n, o, 0, width); return o; }

    /** Minimal big-endian bytes (zero = empty), the RLP integer form. */
    public static byte[] minimal(BigInteger n) {
        if (n.signum() < 0) throw new IllegalArgumentException("negative");
        if (n.signum() == 0) return new byte[0];
        byte[] b = n.toByteArray();
        if (b[0] == 0) return java.util.Arrays.copyOfRange(b, 1, b.length);
        return b;
    }

    /** Parse a JSON quantity: "0x…" hex, or a decimal string, or a number. */
    public static BigInteger quantity(Object o) {
        if (o instanceof Number) return BigInteger.valueOf(((Number) o).longValue());
        String s = String.valueOf(o).trim();
        if (s.startsWith("0x") || s.startsWith("0X")) return s.length() == 2 ? BigInteger.ZERO : new BigInteger(s.substring(2), 16);
        return new BigInteger(s);
    }
}
