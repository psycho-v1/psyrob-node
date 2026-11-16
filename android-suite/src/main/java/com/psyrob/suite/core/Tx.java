package com.psyrob.suite.core;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;

/**
 * Transactions as node/src/tx.js accepts them: EIP-1559 (type 2, empty access list) or legacy with an EIP-155
 * signature. Signatures are low-s.
 */
public final class Tx {
    public BigInteger chainId;
    public BigInteger nonce;
    public byte[] to; // 20 bytes, or null for contract creation
    public BigInteger value = BigInteger.ZERO;
    public byte[] data = new byte[0];
    public BigInteger gasLimit;
    /** Legacy when gasPrice != null, else type 2 with maxFee / maxPriorityFee. */
    public BigInteger gasPrice;
    public BigInteger maxFee;
    public BigInteger maxPriorityFee;

    public byte[] raw;
    public byte[] hash;

    public boolean legacy() { return gasPrice != null; }

    /** Highest fee this transaction can cost: gasLimit × (gasPrice or maxFee). */
    public BigInteger maxCost() { return gasLimit.multiply(legacy() ? gasPrice : maxFee); }

    private List<byte[]> type2Fields() {
        List<byte[]> f = new ArrayList<byte[]>();
        f.add(Rlp.integer(chainId)); f.add(Rlp.integer(nonce)); f.add(Rlp.integer(maxPriorityFee)); f.add(Rlp.integer(maxFee));
        f.add(Rlp.integer(gasLimit)); f.add(Rlp.str(to == null ? new byte[0] : to)); f.add(Rlp.integer(value)); f.add(Rlp.str(data));
        f.add(Rlp.wrapList(new byte[0]));
        return f;
    }

    private List<byte[]> legacyFields() {
        List<byte[]> f = new ArrayList<byte[]>();
        f.add(Rlp.integer(nonce)); f.add(Rlp.integer(gasPrice)); f.add(Rlp.integer(gasLimit));
        f.add(Rlp.str(to == null ? new byte[0] : to)); f.add(Rlp.integer(value)); f.add(Rlp.str(data));
        return f;
    }

    /** Sign with `sk`; fills raw and hash and returns raw. */
    public byte[] sign(byte[] sk) {
        if (legacy()) {
            List<byte[]> f = legacyFields();
            f.add(Rlp.integer(chainId)); f.add(Rlp.str(new byte[0])); f.add(Rlp.str(new byte[0]));
            byte[] sig = Secp256k1.sign(Keccak256.hash(Rlp.list(f)), sk);
            List<byte[]> s = legacyFields();
            s.add(Rlp.integer(chainId.shiftLeft(1).add(BigInteger.valueOf(35 + sig[64]))));
            s.add(Rlp.integer(new BigInteger(1, java.util.Arrays.copyOfRange(sig, 0, 32))));
            s.add(Rlp.integer(new BigInteger(1, java.util.Arrays.copyOfRange(sig, 32, 64))));
            raw = Rlp.list(s);
        } else {
            byte[] payload = Rlp.concat(new byte[] { 2 }, Rlp.list(type2Fields()));
            byte[] sig = Secp256k1.sign(Keccak256.hash(payload), sk);
            List<byte[]> s = type2Fields();
            s.add(Rlp.integer(sig[64]));
            s.add(Rlp.integer(new BigInteger(1, java.util.Arrays.copyOfRange(sig, 0, 32))));
            s.add(Rlp.integer(new BigInteger(1, java.util.Arrays.copyOfRange(sig, 32, 64))));
            raw = Rlp.concat(new byte[] { 2 }, Rlp.list(s));
        }
        hash = Keccak256.hash(raw);
        return raw;
    }

    /** EIP-191 personal_sign digest. */
    public static byte[] personalDigest(byte[] msg) {
        byte[] prefix = ("\u0019Ethereum Signed Message:\n" + msg.length).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        return Keccak256.hash(prefix, msg);
    }

    /** 65-byte signature r ‖ s ‖ v with v = 27/28 (the eth_sign / personal_sign / signTypedData form). */
    public static byte[] signDigest27(byte[] digest, byte[] sk) {
        byte[] s = Secp256k1.sign(digest, sk);
        s[64] = (byte) (27 + s[64]);
        return s;
    }
}
