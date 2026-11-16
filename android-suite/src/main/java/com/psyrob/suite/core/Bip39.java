package com.psyrob.suite.core;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.text.Normalizer;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** BIP-39 recovery phrases (English word list): the same 12/24 words MetaMask and other wallets use. */
public final class Bip39 {
    private final List<String> words;
    private final Map<String, Integer> index = new HashMap<String, Integer>();

    public Bip39(List<String> words) {
        if (words.size() != 2048) throw new IllegalArgumentException("word list must have 2048 words");
        this.words = words;
        for (int i = 0; i < words.size(); i++) index.put(words.get(i), i);
    }

    /** A new phrase with `strengthBits` of entropy (128 = 12 words, 256 = 24 words). */
    public String generate(int strengthBits) {
        byte[] e = new byte[strengthBits / 8];
        new SecureRandom().nextBytes(e);
        return fromEntropy(e);
    }

    public String fromEntropy(byte[] entropy) {
        int ent = entropy.length * 8, cs = ent / 32;
        byte[] h = sha256(entropy);
        int total = ent + cs;
        StringBuilder sb = new StringBuilder();
        for (int w = 0; w < total / 11; w++) {
            int idx = 0;
            for (int b = 0; b < 11; b++) {
                int bit = w * 11 + b;
                int v = bit < ent ? (entropy[bit >> 3] >> (7 - (bit & 7))) & 1 : (h[(bit - ent) >> 3] >> (7 - ((bit - ent) & 7))) & 1;
                idx = (idx << 1) | v;
            }
            if (sb.length() > 0) sb.append(' ');
            sb.append(words.get(idx));
        }
        return sb.toString();
    }

    /** Normalised phrase (lower case, single spaces), or throws with the reason when it is not a valid phrase. */
    public String validate(String phrase) throws Exception {
        String[] ws = phrase.trim().toLowerCase(java.util.Locale.ROOT).split("\\s+");
        if (ws.length != 12 && ws.length != 15 && ws.length != 18 && ws.length != 21 && ws.length != 24)
            throw new Exception("A recovery phrase has 12, 15, 18, 21 or 24 words (this one has " + ws.length + ").");
        int total = ws.length * 11, cs = total / 33, ent = total - cs;
        byte[] e = new byte[ent / 8];
        int[] bits = new int[total];
        for (int i = 0; i < ws.length; i++) {
            Integer idx = index.get(ws[i]);
            if (idx == null) throw new Exception("\"" + ws[i] + "\" (word " + (i + 1) + ") is not in the BIP-39 English word list.");
            for (int b = 0; b < 11; b++) bits[i * 11 + b] = (idx >> (10 - b)) & 1;
        }
        for (int i = 0; i < ent; i++) if (bits[i] == 1) e[i >> 3] |= (byte) (1 << (7 - (i & 7)));
        byte[] h = sha256(e);
        for (int i = 0; i < cs; i++) if (bits[ent + i] != ((h[i >> 3] >> (7 - (i & 7))) & 1)) throw new Exception("The checksum of this phrase is wrong: check the words and their order.");
        StringBuilder sb = new StringBuilder();
        for (String w : ws) { if (sb.length() > 0) sb.append(' '); sb.append(w); }
        return sb.toString();
    }

    /** 64-byte seed: PBKDF2-HMAC-SHA512(phrase, "mnemonic" + passphrase, 2048). */
    public static byte[] seed(String phrase, String passphrase) {
        byte[] pw = Normalizer.normalize(phrase, Normalizer.Form.NFKD).getBytes(StandardCharsets.UTF_8);
        byte[] salt = Normalizer.normalize("mnemonic" + (passphrase == null ? "" : passphrase), Normalizer.Form.NFKD).getBytes(StandardCharsets.UTF_8);
        try {
            Mac mac = Mac.getInstance("HmacSHA512");
            mac.init(new SecretKeySpec(pw, "HmacSHA512"));
            mac.update(salt);
            mac.update(new byte[] { 0, 0, 0, 1 });
            byte[] u = mac.doFinal();
            byte[] out = u.clone();
            for (int i = 1; i < 2048; i++) {
                u = mac.doFinal(u);
                for (int j = 0; j < 64; j++) out[j] ^= u[j];
            }
            return out;
        } catch (Exception e) { throw new IllegalStateException(e); }
    }

    static byte[] sha256(byte[] b) {
        try { return MessageDigest.getInstance("SHA-256").digest(b); } catch (Exception e) { throw new IllegalStateException(e); }
    }
}
