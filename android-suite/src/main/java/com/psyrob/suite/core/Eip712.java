package com.psyrob.suite.core;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import org.json.JSONArray;
import org.json.JSONObject;

/** EIP-712 typed data hashing (eth_signTypedData_v4), as MetaMask computes it. */
public final class Eip712 {
    private final JSONObject types;

    private Eip712(JSONObject types) { this.types = types; }

    /** The digest keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(message)). */
    public static byte[] digest(JSONObject typed) throws Exception {
        JSONObject types = new JSONObject(typed.getJSONObject("types").toString());
        JSONObject domain = typed.optJSONObject("domain");
        if (domain == null) domain = new JSONObject();
        if (!types.has("EIP712Domain")) {
            JSONArray d = new JSONArray();
            String[][] std = { { "name", "string" }, { "version", "string" }, { "chainId", "uint256" }, { "verifyingContract", "address" }, { "salt", "bytes32" } };
            for (String[] f : std) if (domain.has(f[0])) d.put(new JSONObject().put("name", f[0]).put("type", f[1]));
            types.put("EIP712Domain", d);
        }
        Eip712 e = new Eip712(types);
        byte[] ds = e.hashStruct("EIP712Domain", domain);
        String primary = typed.getString("primaryType");
        if (primary.equals("EIP712Domain")) return Keccak256.hash(Rlp.concat(new byte[] { 0x19, 0x01 }, ds));
        byte[] ms = e.hashStruct(primary, typed.getJSONObject("message"));
        return Keccak256.hash(Rlp.concat(new byte[] { 0x19, 0x01 }, ds, ms));
    }

    byte[] hashStruct(String type, JSONObject data) throws Exception {
        return Keccak256.hash(Rlp.concat(typeHash(type), encodeData(type, data)));
    }

    byte[] typeHash(String type) throws Exception { return Keccak256.hash(encodeType(type).getBytes(StandardCharsets.UTF_8)); }

    String encodeType(String primary) throws Exception {
        Set<String> deps = new LinkedHashSet<String>();
        findDeps(primary, deps);
        deps.remove(primary);
        List<String> sorted = new ArrayList<String>(deps);
        Collections.sort(sorted);
        sorted.add(0, primary);
        StringBuilder sb = new StringBuilder();
        for (String t : sorted) {
            sb.append(t).append('(');
            JSONArray fs = types.getJSONArray(t);
            for (int i = 0; i < fs.length(); i++) {
                if (i > 0) sb.append(',');
                sb.append(fs.getJSONObject(i).getString("type")).append(' ').append(fs.getJSONObject(i).getString("name"));
            }
            sb.append(')');
        }
        return sb.toString();
    }

    private void findDeps(String type, Set<String> out) throws Exception {
        String base = baseType(type);
        if (out.contains(base) || !types.has(base)) return;
        out.add(base);
        JSONArray fs = types.getJSONArray(base);
        for (int i = 0; i < fs.length(); i++) findDeps(fs.getJSONObject(i).getString("type"), out);
    }

    private static String baseType(String t) { int i = t.indexOf('['); return i < 0 ? t : t.substring(0, i); }

    private byte[] encodeData(String type, JSONObject data) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        JSONArray fs = types.getJSONArray(type);
        for (int i = 0; i < fs.length(); i++) {
            JSONObject f = fs.getJSONObject(i);
            byte[] w = encodeValue(f.getString("type"), data.isNull(f.getString("name")) ? null : data.get(f.getString("name")));
            out.write(w, 0, w.length);
        }
        return out.toByteArray();
    }

    private byte[] encodeValue(String type, Object v) throws Exception {
        if (type.endsWith("]")) {
            String inner = type.substring(0, type.lastIndexOf('['));
            JSONArray arr = v == null ? new JSONArray() : (JSONArray) v;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            for (int i = 0; i < arr.length(); i++) { byte[] w = encodeValue(inner, arr.isNull(i) ? null : arr.get(i)); out.write(w, 0, w.length); }
            return Keccak256.hash(out.toByteArray());
        }
        if (types.has(type)) {
            if (v == null) return new byte[32];
            return hashStruct(type, (JSONObject) v);
        }
        if (type.equals("string")) return Keccak256.hash(String.valueOf(v == null ? "" : v).getBytes(StandardCharsets.UTF_8));
        if (type.equals("bytes")) return Keccak256.hash(v == null ? new byte[0] : bytes(v));
        if (type.equals("bool")) {
            boolean b = v instanceof Boolean ? (Boolean) v : v != null && (String.valueOf(v).equals("true") || String.valueOf(v).equals("1"));
            return Abi.word(b ? BigInteger.ONE : BigInteger.ZERO);
        }
        if (type.equals("address")) {
            if (v == null) return new byte[32];
            byte[] a = Hex.decode(String.valueOf(v));
            if (a.length != 20) throw new Exception("typed data: bad address " + v);
            return Abi.word(a);
        }
        if (type.startsWith("bytes")) {
            byte[] b = v == null ? new byte[0] : bytes(v);
            byte[] w = new byte[32];
            System.arraycopy(b, 0, w, 0, Math.min(32, b.length));
            return w;
        }
        if (type.startsWith("uint") || type.startsWith("int")) {
            BigInteger n = v == null ? BigInteger.ZERO : number(v);
            if (n.signum() < 0) n = n.add(BigInteger.ONE.shiftLeft(256));
            return Abi.word(n);
        }
        throw new Exception("typed data: unsupported type " + type);
    }

    private static byte[] bytes(Object v) {
        String s = String.valueOf(v);
        if (s.startsWith("0x")) return Hex.decode(s);
        return s.getBytes(StandardCharsets.UTF_8);
    }

    private static BigInteger number(Object v) {
        if (v instanceof Integer || v instanceof Long) return BigInteger.valueOf(((Number) v).longValue());
        if (v instanceof Number) return new java.math.BigDecimal(v.toString()).toBigIntegerExact();
        String s = String.valueOf(v).trim();
        if (s.startsWith("-0x")) return new BigInteger(s.substring(3), 16).negate();
        if (s.startsWith("0x")) return s.length() == 2 ? BigInteger.ZERO : new BigInteger(s.substring(2), 16);
        return new BigInteger(s);
    }

    /** A short readable summary of typed data for the confirmation screen. */
    public static String summary(JSONObject typed) {
        StringBuilder sb = new StringBuilder();
        JSONObject d = typed.optJSONObject("domain");
        if (d != null) sb.append(d.optString("name", "")).append(d.has("verifyingContract") ? " (" + d.optString("verifyingContract") + ")" : "").append('\n');
        sb.append(typed.optString("primaryType")).append('\n');
        JSONObject m = typed.optJSONObject("message");
        if (m != null) {
            Iterator<String> it = m.keys();
            while (it.hasNext()) {
                String k = it.next();
                String v = String.valueOf(m.opt(k));
                if (v.length() > 90) v = v.substring(0, 90) + "…";
                sb.append("  ").append(k).append(": ").append(v).append('\n');
            }
        }
        return sb.toString().trim();
    }
}
