package com.psyrob.suite.core;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * A mining job: the node's psy_getBlockTemplate answer turned back into the header encoding of common/header.js.
 *
 *   header        = rlp([version, parents, timestamp, target, blueScore, blueWork, stateRoot, txRoot, receiptsRoot,
 *                        acceptedTxRoot, gasLimit, gasUsed, baseFee, miner, extra, nonce, minerSig])
 *   signing bytes = the same list with minerSig = empty
 *   minerSig      = secp256k1 over keccak256("PSYROB-miner-signature" ‖ signing bytes)
 *   powHash       = Argon2d(full header, salt "PSYROB-PoW")
 */
public final class Job {
    public static final byte[] POW_SALT = "PSYROB-PoW".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] SIG_DOMAIN = "PSYROB-miner-signature".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] EMPTY_STR = { (byte) 0x80 };

    public final String id;
    public final BigInteger target;
    public final int memoryKiB;
    public final int iterations;
    public final long blueScore;
    public final String miner; // 0x… lower case
    public final String nodeUrl;
    public final long receivedAt;
    /** RLP items 0..14 (everything before the nonce), already encoded. */
    private final byte[] prefix;
    private final String signingBytesHex;

    private Job(String id, BigInteger target, int memoryKiB, int iterations, long blueScore, String miner, byte[] prefix,
                String signingBytesHex, String nodeUrl) {
        this.id = id; this.target = target; this.memoryKiB = memoryKiB; this.iterations = iterations; this.blueScore = blueScore;
        this.miner = miner; this.prefix = prefix; this.signingBytesHex = signingBytesHex; this.nodeUrl = nodeUrl;
        this.receivedAt = System.currentTimeMillis();
    }

    public static Job fromTemplate(JSONObject t, String nodeUrl) throws Exception {
        JSONObject h = t.getJSONObject("header");
        List<byte[]> items = new ArrayList<byte[]>();
        items.add(Rlp.integer(Hex.quantity(h.get("version"))));
        JSONArray ps = h.getJSONArray("parents");
        List<byte[]> parents = new ArrayList<byte[]>();
        for (int i = 0; i < ps.length(); i++) {
            byte[] p = Hex.decode(ps.getString(i));
            if (p.length != 32) throw new Exception("template: parent must be 32 bytes");
            parents.add(Rlp.str(p));
        }
        items.add(Rlp.list(parents));
        items.add(Rlp.integer(Hex.quantity(h.get("timestamp"))));
        BigInteger target = Hex.quantity(h.get("target"));
        items.add(Rlp.str(Hex.fixed(target, 32)));
        long blueScore = Hex.quantity(h.get("blueScore")).longValue();
        items.add(Rlp.integer(Hex.quantity(h.get("blueScore"))));
        items.add(Rlp.integer(Hex.quantity(h.get("blueWork"))));
        for (String k : new String[] { "stateRoot", "txRoot", "receiptsRoot", "acceptedTxRoot" }) {
            byte[] r = Hex.decode(h.getString(k));
            if (r.length != 32) throw new Exception("template: " + k + " must be 32 bytes");
            items.add(Rlp.str(r));
        }
        items.add(Rlp.integer(Hex.quantity(h.get("gasLimit"))));
        items.add(Rlp.integer(Hex.quantity(h.get("gasUsed"))));
        items.add(Rlp.integer(Hex.quantity(h.get("baseFee"))));
        byte[] miner = Hex.decode(h.getString("miner"));
        if (miner.length != 20) throw new Exception("template: miner must be 20 bytes");
        items.add(Rlp.str(miner));
        items.add(Rlp.str(Hex.decode(h.getString("extra"))));
        int n = 0;
        for (byte[] b : items) n += b.length;
        byte[] prefix = new byte[n];
        int o = 0;
        for (byte[] b : items) { System.arraycopy(b, 0, prefix, o, b.length); o += b.length; }

        JSONObject pow = t.optJSONObject("pow");
        int mem = pow == null ? -1 : pow.optInt("memoryKiB", -1);
        int it = pow == null ? -1 : pow.optInt("iterations", -1);
        return new Job(t.getString("id"), target, mem, it, blueScore, Hex.with0x(miner), prefix,
            t.optString("signingBytes", "").toLowerCase(), nodeUrl);
    }

    /**
     * The checks of miner/src/miner.js checkTemplate(): the fields re-encode to the node's signing bytes, the template
     * names this wallet, and the proof-of-work settings are sane (and the public network's on chain 87870).
     * Throws with the reason when the template must not be signed.
     */
    public void check(String expectAddress, Long chainId) throws Exception {
        if (!Hex.with0x(signingBytes(BigInteger.ZERO)).equals(signingBytesHex))
            throw new Exception("the node sent a template whose fields do not match its signing bytes; refusing to sign it");
        if (!miner.equalsIgnoreCase(expectAddress))
            throw new Exception("the node sent a template for another miner address; refusing to sign it");
        if (memoryKiB < 8 || memoryKiB > (1 << 21) || iterations < 1 || iterations > 16)
            throw new Exception("the node sent unusual proof-of-work settings; refusing to mine");
        if (chainId != null && chainId == 87870L && (memoryKiB != 32768 || iterations != 1))
            throw new Exception("the node sent proof-of-work settings of another network; refusing to mine");
    }

    private byte[] nonceItem(BigInteger nonce) { return Rlp.str(Hex.fixed(nonce, 8)); }

    public byte[] signingBytes(BigInteger nonce) {
        return Rlp.wrapList(Rlp.concat(prefix, nonceItem(nonce), EMPTY_STR));
    }

    public byte[] fullHeader(BigInteger nonce, byte[] sig) {
        return Rlp.wrapList(Rlp.concat(prefix, nonceItem(nonce), Rlp.str(sig)));
    }

    public static byte[] sigDigest(byte[] signing) { return Keccak256.hash(SIG_DOMAIN, signing); }

    /** Expected attempts per block: 2^256 / (target + 1). */
    public double expectedAttempts() {
        return BigInteger.ONE.shiftLeft(256).divide(target.add(BigInteger.ONE)).doubleValue();
    }

    /** One attempt's result. */
    public static final class Attempt {
        public boolean ok;
        public byte[] sig;
    }

    /** Set the nonce, sign, hash. Reuses `out`. */
    public Attempt attempt(BigInteger nonce, byte[] sk, Argon2d argon, Attempt out) {
        byte[] sig = Secp256k1.sign(sigDigest(signingBytes(nonce)), sk);
        byte[] pow = argon.hash(fullHeader(nonce, sig), POW_SALT, memoryKiB, iterations);
        out.ok = new BigInteger(1, pow).compareTo(target) <= 0;
        out.sig = sig;
        return out;
    }
}
