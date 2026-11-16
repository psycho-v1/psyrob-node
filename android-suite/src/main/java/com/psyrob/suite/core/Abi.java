package com.psyrob.suite.core;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;

/** The few ABI pieces the wallet needs: ERC-20 calls and a readable description of common calldata. */
public final class Abi {
    public static final BigInteger MAX_UINT = BigInteger.ONE.shiftLeft(256).subtract(BigInteger.ONE);

    private Abi() {}

    public static byte[] selector(String signature) {
        return java.util.Arrays.copyOfRange(Keccak256.hash(signature.getBytes(StandardCharsets.US_ASCII)), 0, 4);
    }

    public static byte[] word(BigInteger n) { return Hex.fixed(n, 32); }

    public static byte[] word(byte[] address20) { byte[] w = new byte[32]; System.arraycopy(address20, 0, w, 12, 20); return w; }

    public static byte[] call(String signature, byte[]... words) {
        byte[][] parts = new byte[words.length + 1][];
        parts[0] = selector(signature);
        System.arraycopy(words, 0, parts, 1, words.length);
        return Rlp.concat(parts);
    }

    public static byte[] balanceOf(String owner) { return call("balanceOf(address)", word(Hex.decode(owner))); }

    public static byte[] transfer(String to, BigInteger amount) { return call("transfer(address,uint256)", word(Hex.decode(to)), word(amount)); }

    public static BigInteger uint(String hexResult) {
        byte[] b = Hex.decode(hexResult);
        if (b.length == 0) throw new IllegalArgumentException("empty result (not a contract?)");
        return new BigInteger(1, java.util.Arrays.copyOfRange(b, 0, Math.min(32, b.length)));
    }

    /** Decode an ABI string result; also accepts the old bytes32 form. */
    public static String string(String hexResult) {
        byte[] b = Hex.decode(hexResult);
        if (b.length == 32) {
            int n = 0;
            while (n < 32 && b[n] != 0) n++;
            return new String(b, 0, n, StandardCharsets.UTF_8);
        }
        if (b.length < 64) throw new IllegalArgumentException("not a string");
        int off = new BigInteger(1, java.util.Arrays.copyOfRange(b, 0, 32)).intValue();
        int len = new BigInteger(1, java.util.Arrays.copyOfRange(b, off, off + 32)).intValue();
        return new String(b, off + 32, len, StandardCharsets.UTF_8);
    }

    public static String units(BigInteger v, int decimals) {
        BigDecimal d = new BigDecimal(v).movePointLeft(decimals).stripTrailingZeros();
        String s = d.toPlainString();
        return s;
    }

    /** "1.5" with 18 decimals -> 1500000000000000000. Throws on more decimals than the token has. */
    public static BigInteger parseUnits(String s, int decimals) throws Exception {
        String t = s.trim().replace(",", ".");
        if (!t.matches("\\d*(\\.\\d*)?") || t.equals("") || t.equals(".")) throw new Exception("Enter an amount like 1.25");
        BigDecimal d = new BigDecimal(t).movePointRight(decimals);
        if (d.scale() > 0 && d.stripTrailingZeros().scale() > 0) throw new Exception("Too many decimals (at most " + decimals + ")");
        return d.toBigIntegerExact();
    }

    /** What calldata does, for the confirmation screen: null when unknown. */
    public static String describe(byte[] data, String tokenSymbol, int decimals) {
        if (data == null || data.length < 4) return null;
        String sel = Hex.encode(java.util.Arrays.copyOfRange(data, 0, 4));
        try {
            if (sel.equals("a9059cbb") && data.length >= 68)
                return "Token transfer of " + amount(data, 36, tokenSymbol, decimals) + " to " + addr(data, 4);
            if (sel.equals("095ea7b3") && data.length >= 68)
                return "APPROVAL: lets " + addr(data, 4) + " spend " + amount(data, 36, tokenSymbol, decimals) + " of your " + (tokenSymbol == null ? "tokens" : tokenSymbol);
            if (sel.equals("39509351") && data.length >= 68)
                return "APPROVAL: raises what " + addr(data, 4) + " may spend by " + amount(data, 36, tokenSymbol, decimals);
            if (sel.equals("23b872dd") && data.length >= 100)
                return "Token transfer of " + amount(data, 68, tokenSymbol, decimals) + " from " + addr(data, 4) + " to " + addr(data, 36);
            if (sel.equals("a22cb465") && data.length >= 68)
                return (new BigInteger(1, java.util.Arrays.copyOfRange(data, 36, 68)).signum() != 0
                    ? "APPROVAL FOR ALL: lets " + addr(data, 4) + " move ALL your items in this collection"
                    : "Removes the approval for all of " + addr(data, 4));
        } catch (Exception ignored) { }
        return null;
    }

    private static String addr(byte[] d, int off) { return Hex.with0x(java.util.Arrays.copyOfRange(d, off + 12, off + 32)); }

    private static String amount(byte[] d, int off, String sym, int decimals) {
        BigInteger v = new BigInteger(1, java.util.Arrays.copyOfRange(d, off, off + 32));
        if (v.compareTo(BigInteger.ONE.shiftLeft(255)) >= 0) return "UNLIMITED";
        return sym == null ? v.toString() + " (raw units)" : units(v, decimals) + " " + sym;
    }
}
