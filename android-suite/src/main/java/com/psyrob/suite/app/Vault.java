package com.psyrob.suite.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import org.json.JSONArray;
import org.json.JSONObject;

import com.psyrob.suite.core.Bip32;
import com.psyrob.suite.core.Bip39;
import com.psyrob.suite.core.Hex;
import com.psyrob.suite.core.Secp256k1;

/**
 * The wallet's secrets: an optional BIP-39 recovery phrase (accounts m/44'/60'/0'/0/i, as MetaMask) and imported
 * private keys. All secrets are kept in one blob encrypted with AES-256-GCM under a key held by the Android Keystore,
 * which never leaves the secure hardware. Addresses and names are kept in clear so the screen can show them.
 */
public final class Vault {
    private static final String ALIAS = "psyrob_suite_vault_v1";
    private static Bip39 bip39;
    private final SharedPreferences prefs;
    private final Context ctx;

    public Vault(Context c) {
        ctx = c.getApplicationContext();
        prefs = ctx.getSharedPreferences("vault", Context.MODE_PRIVATE);
    }

    public static synchronized Bip39 bip39(Context c) {
        if (bip39 == null) {
            try {
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getAssets().open("bip39-english.txt"), StandardCharsets.UTF_8));
                List<String> words = new ArrayList<String>();
                String l;
                while ((l = r.readLine()) != null) if (l.trim().length() > 0) words.add(l.trim());
                r.close();
                bip39 = new Bip39(words);
            } catch (Exception e) { throw new IllegalStateException(e); }
        }
        return bip39;
    }

    public boolean has() { return accounts().length() > 0; }

    /** [{name, address, kind: "phrase"|"imported", index?}] */
    public JSONArray accounts() {
        try { return new JSONArray(prefs.getString("accounts", "[]")); } catch (Exception e) { return new JSONArray(); }
    }

    public int selected() { return Math.max(0, Math.min(prefs.getInt("selected", 0), Math.max(0, accounts().length() - 1))); }

    public void select(int i) { if (i >= 0 && i < accounts().length()) prefs.edit().putInt("selected", i).apply(); }

    public String address() { JSONArray a = accounts(); return a.length() == 0 ? null : a.optJSONObject(selected()).optString("address"); }

    public String address(int i) { return accounts().optJSONObject(i).optString("address"); }

    public boolean hasPhrase() { return prefs.getBoolean("hasPhrase", false); }

    public boolean backedUp() { return prefs.getBoolean("backedUp", true); }

    public void setBackedUp() { prefs.edit().putBoolean("backedUp", true).apply(); }

    // ---- creation ----

    /** A new wallet with a fresh 12-word phrase; returns the phrase so the user can write it down. */
    public synchronized String create() throws Exception {
        String phrase = bip39(ctx).generate(128);
        restore(phrase);
        prefs.edit().putBoolean("backedUp", false).apply();
        return phrase;
    }

    /** Replace everything with the wallet of this recovery phrase (account 1). */
    public synchronized String restore(String phrase) throws Exception {
        String p = bip39(ctx).validate(phrase);
        byte[] sk = Bip32.derive(Bip39.seed(p, ""), Bip32.accountPath(0));
        String addr = Hex.with0x(Secp256k1.address(sk));
        Arrays.fill(sk, (byte) 0);
        JSONObject secrets = new JSONObject().put("phrase", p).put("keys", new JSONObject());
        JSONArray accts = new JSONArray().put(new JSONObject().put("name", "Account 1").put("address", addr).put("kind", "phrase").put("index", 0));
        writeSecrets(secrets);
        prefs.edit().putString("accounts", accts.toString()).putInt("selected", 0).putBoolean("hasPhrase", true).putBoolean("backedUp", true).commit();
        return addr;
    }

    /** Add the next account of the recovery phrase. */
    public synchronized String addAccount() throws Exception {
        JSONObject s = readSecrets();
        if (!s.has("phrase")) throw new Exception("This wallet has no recovery phrase; import a key instead.");
        JSONArray accts = accounts();
        int next = 0;
        for (int i = 0; i < accts.length(); i++) if ("phrase".equals(accts.getJSONObject(i).optString("kind"))) next = Math.max(next, accts.getJSONObject(i).optInt("index") + 1);
        byte[] sk = Bip32.derive(Bip39.seed(s.getString("phrase"), ""), Bip32.accountPath(next));
        String addr = Hex.with0x(Secp256k1.address(sk));
        Arrays.fill(sk, (byte) 0);
        accts.put(new JSONObject().put("name", "Account " + (accts.length() + 1)).put("address", addr).put("kind", "phrase").put("index", next));
        prefs.edit().putString("accounts", accts.toString()).putInt("selected", accts.length() - 1).commit();
        return addr;
    }

    /** Add an account from a private key (for example the desktop miner's key). */
    public synchronized String importKey(String hex) throws Exception {
        String h = hex.trim();
        if (h.startsWith("0x") || h.startsWith("0X")) h = h.substring(2);
        if (!h.matches("[0-9a-fA-F]{64}")) throw new Exception("A private key is 64 hex characters (0-9, a-f).");
        byte[] k = Hex.decode(h);
        if (!Secp256k1.isValidPrivateKey(k)) throw new Exception("This is not a valid secp256k1 private key.");
        String addr = Hex.with0x(Secp256k1.address(k));
        JSONArray accts = accounts();
        for (int i = 0; i < accts.length(); i++) if (accts.getJSONObject(i).optString("address").equalsIgnoreCase(addr)) { select(i); return addr; }
        JSONObject s = has() ? readSecrets() : new JSONObject().put("keys", new JSONObject());
        s.getJSONObject("keys").put(addr, Hex.encode(k));
        Arrays.fill(k, (byte) 0);
        writeSecrets(s);
        accts.put(new JSONObject().put("name", "Imported " + (accts.length() + 1)).put("address", addr).put("kind", "imported"));
        prefs.edit().putString("accounts", accts.toString()).putInt("selected", accts.length() - 1).commit();
        return addr;
    }

    /** Follow an address without its key (watch-only: balances and history, no signing). */
    public synchronized String addWatch(String address) throws Exception {
        String a = address.trim();
        if (!a.matches("0x[0-9a-fA-F]{40}")) throw new Exception("An address is 0x followed by 40 hex characters.");
        if (!WalletApi.checksumOk(a)) throw new Exception("This address has a wrong capital-letter checksum: it may contain a typo.");
        JSONArray accts = accounts();
        for (int i = 0; i < accts.length(); i++) if (accts.getJSONObject(i).optString("address").equalsIgnoreCase(a)) { select(i); return a; }
        if (!has()) throw new Exception("Create or restore a wallet first.");
        accts.put(new JSONObject().put("name", "Watch " + (accts.length() + 1)).put("address", a.toLowerCase()).put("kind", "watch"));
        prefs.edit().putString("accounts", accts.toString()).putInt("selected", accts.length() - 1).commit();
        return a;
    }

    public boolean watchOnly() { return watchOnly(selected()); }

    public boolean watchOnly(int i) { JSONObject a = accounts().optJSONObject(i); return a != null && "watch".equals(a.optString("kind")); }

    public synchronized void rename(int i, String name) throws Exception {
        JSONArray a = accounts();
        String n = name.trim();
        if (n.isEmpty() || n.length() > 32) throw new Exception("Use 1 to 32 characters.");
        a.getJSONObject(i).put("name", n);
        prefs.edit().putString("accounts", a.toString()).apply();
    }

    public synchronized void removeAccount(int i) throws Exception {
        JSONArray a = accounts();
        if (a.length() <= 1) throw new Exception("A wallet keeps at least one account.");
        JSONObject acc = a.getJSONObject(i);
        if ("imported".equals(acc.optString("kind"))) {
            JSONObject s = readSecrets();
            s.getJSONObject("keys").remove(acc.optString("address"));
            writeSecrets(s);
        }
        JSONArray b = new JSONArray();
        for (int j = 0; j < a.length(); j++) if (j != i) b.put(a.get(j));
        prefs.edit().putString("accounts", b.toString()).putInt("selected", 0).commit();
    }

    /** Delete the whole wallet from this phone. */
    public synchronized void wipe() {
        prefs.edit().clear().commit();
        try { KeyStore ks = KeyStore.getInstance("AndroidKeyStore"); ks.load(null); ks.deleteEntry(ALIAS); } catch (Exception ignored) { }
    }

    // ---- secrets ----

    public synchronized String phrase() throws Exception {
        JSONObject s = readSecrets();
        if (!s.has("phrase")) throw new Exception("This wallet has no recovery phrase.");
        return s.getString("phrase");
    }

    /** Private key of the selected account. The caller wipes it. */
    public byte[] privateKey() throws Exception { return privateKey(selected()); }

    public synchronized byte[] privateKey(int i) throws Exception {
        JSONObject acc = accounts().getJSONObject(i);
        if ("watch".equals(acc.optString("kind"))) throw new Exception("This account is watch-only: it has no key on this phone.");
        JSONObject s = readSecrets();
        if ("phrase".equals(acc.optString("kind"))) return Bip32.derive(Bip39.seed(s.getString("phrase"), ""), Bip32.accountPath(acc.getInt("index")));
        return Hex.decode(s.getJSONObject("keys").getString(acc.getString("address")));
    }

    private JSONObject readSecrets() throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(ALIAS), new GCMParameterSpec(128, Base64.decode(prefs.getString("iv", ""), Base64.NO_WRAP)));
        return new JSONObject(new String(c.doFinal(Base64.decode(prefs.getString("ct", ""), Base64.NO_WRAP)), StandardCharsets.UTF_8));
    }

    private void writeSecrets(JSONObject s) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key(ALIAS));
        byte[] ct = c.doFinal(s.toString().getBytes(StandardCharsets.UTF_8));
        prefs.edit().putString("ct", Base64.encodeToString(ct, Base64.NO_WRAP)).putString("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP)).commit();
    }

    private static SecretKey key(String alias) throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(alias)) return ((KeyStore.SecretKeyEntry) ks.getEntry(alias, null)).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
        return g.generateKey();
    }

}
