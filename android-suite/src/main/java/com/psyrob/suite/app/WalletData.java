package com.psyrob.suite.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/** Networks, tokens, connected sites and the activity list (all public data, kept in plain preferences). */
public final class WalletData {
    public static final long PSYROB_CHAIN = 87870L;
    /** M-PSY on PSYROB (Mini PSY deployment of 3 Nov 2026, docs/TEST_REPORT_V11.md). */
    public static final String MPSY_ADDRESS = "0xa47e6561d1E3EfC564b8C0D1D07A5b9250fcA8eb";

    private final SharedPreferences p;

    public WalletData(Context c) { p = c.getApplicationContext().getSharedPreferences("walletdata", Context.MODE_PRIVATE); }

    // ---- networks ----

    static JSONObject psyrob() {
        try {
            return new JSONObject().put("chainId", PSYROB_CHAIN).put("name", "PSYROB Network").put("rpc", Settings.DEFAULT_NODE)
                .put("symbol", "PSY").put("decimals", 18).put("explorer", Settings.EXPLORER).put("builtin", true);
        } catch (Exception e) { throw new IllegalStateException(e); }
    }

    public synchronized JSONArray networks() {
        JSONArray out = new JSONArray();
        out.put(psyrob());
        try {
            JSONArray custom = new JSONArray(p.getString("networks", "[]"));
            for (int i = 0; i < custom.length(); i++) out.put(custom.get(i));
        } catch (Exception ignored) { }
        return out;
    }

    public synchronized JSONObject network(long chainId) {
        JSONArray n = networks();
        for (int i = 0; i < n.length(); i++) if (n.optJSONObject(i).optLong("chainId") == chainId) return n.optJSONObject(i);
        return null;
    }

    public long activeChain() { long c = p.getLong("activeChain", PSYROB_CHAIN); return network(c) == null ? PSYROB_CHAIN : c; }

    public JSONObject active() { return network(activeChain()); }

    public void setActiveChain(long c) { if (network(c) != null) p.edit().putLong("activeChain", c).apply(); }

    public synchronized void addNetwork(JSONObject n) throws Exception {
        long cid = n.getLong("chainId");
        if (cid == PSYROB_CHAIN) throw new Exception("PSYROB Network is built in.");
        String rpc = n.getString("rpc");
        if (!rpc.startsWith("https://")) throw new Exception("The RPC address must start with https://");
        JSONArray custom = new JSONArray(p.getString("networks", "[]"));
        JSONArray out = new JSONArray();
        for (int i = 0; i < custom.length(); i++) if (custom.getJSONObject(i).getLong("chainId") != cid) out.put(custom.get(i));
        out.put(new JSONObject().put("chainId", cid).put("name", n.optString("name", "Chain " + cid)).put("rpc", rpc)
            .put("symbol", n.optString("symbol", "ETH")).put("decimals", n.optInt("decimals", 18)).put("explorer", n.optString("explorer", "")).put("builtin", false));
        p.edit().putString("networks", out.toString()).apply();
    }

    public synchronized void removeNetwork(long cid) throws Exception {
        if (cid == PSYROB_CHAIN) throw new Exception("PSYROB Network cannot be removed.");
        JSONArray custom = new JSONArray(p.getString("networks", "[]"));
        JSONArray out = new JSONArray();
        for (int i = 0; i < custom.length(); i++) if (custom.getJSONObject(i).getLong("chainId") != cid) out.put(custom.get(i));
        p.edit().putString("networks", out.toString()).apply();
        if (activeChain() == cid) setActiveChain(PSYROB_CHAIN);
    }

    // ---- tokens ----

    public synchronized JSONArray tokens(long chainId) {
        JSONArray out = new JSONArray();
        try {
            if (chainId == PSYROB_CHAIN && !p.getBoolean("hideMpsy", false))
                out.put(new JSONObject().put("address", MPSY_ADDRESS).put("symbol", "M-PSY").put("name", "Mini PSY").put("decimals", 18).put("logo", "mpsy").put("builtin", true));
            JSONArray t = new JSONArray(p.getString("tokens_" + chainId, "[]"));
            for (int i = 0; i < t.length(); i++) out.put(t.get(i));
        } catch (Exception ignored) { }
        return out;
    }

    public synchronized JSONObject token(long chainId, String address) {
        JSONArray t = tokens(chainId);
        for (int i = 0; i < t.length(); i++) if (t.optJSONObject(i).optString("address").equalsIgnoreCase(address)) return t.optJSONObject(i);
        return null;
    }

    public synchronized void addToken(long chainId, JSONObject tok) throws Exception {
        String a = tok.getString("address");
        if (token(chainId, a) != null) return;
        JSONArray t = new JSONArray(p.getString("tokens_" + chainId, "[]"));
        t.put(new JSONObject().put("address", a).put("symbol", tok.getString("symbol")).put("name", tok.optString("name", tok.getString("symbol")))
            .put("decimals", tok.getInt("decimals")).put("image", tok.optString("image", "")));
        p.edit().putString("tokens_" + chainId, t.toString()).apply();
    }

    public synchronized void removeToken(long chainId, String address) throws Exception {
        if (chainId == PSYROB_CHAIN && address.equalsIgnoreCase(MPSY_ADDRESS)) { p.edit().putBoolean("hideMpsy", true).apply(); return; }
        JSONArray t = new JSONArray(p.getString("tokens_" + chainId, "[]"));
        JSONArray out = new JSONArray();
        for (int i = 0; i < t.length(); i++) if (!t.getJSONObject(i).optString("address").equalsIgnoreCase(address)) out.put(t.get(i));
        p.edit().putString("tokens_" + chainId, out.toString()).apply();
    }

    public void showMpsy() { p.edit().putBoolean("hideMpsy", false).apply(); }

    // ---- connected sites (per address) ----

    public synchronized boolean connected(String origin, String address) {
        try { return new JSONObject(p.getString("sites", "{}")).optJSONObject(origin) != null && new JSONObject(p.getString("sites", "{}")).getJSONObject(origin).optBoolean(address.toLowerCase()); }
        catch (Exception e) { return false; }
    }

    public synchronized void connect(String origin, String address) {
        try {
            JSONObject s = new JSONObject(p.getString("sites", "{}"));
            JSONObject o = s.optJSONObject(origin);
            if (o == null) o = new JSONObject();
            o.put(address.toLowerCase(), true);
            s.put(origin, o);
            p.edit().putString("sites", s.toString()).apply();
        } catch (Exception ignored) { }
    }

    public synchronized JSONArray sites() {
        JSONArray out = new JSONArray();
        try { JSONObject s = new JSONObject(p.getString("sites", "{}")); java.util.Iterator<String> it = s.keys(); while (it.hasNext()) out.put(it.next()); } catch (Exception ignored) { }
        return out;
    }

    public synchronized void disconnect(String origin) {
        try { JSONObject s = new JSONObject(p.getString("sites", "{}")); s.remove(origin); p.edit().putString("sites", s.toString()).apply(); } catch (Exception ignored) { }
    }

    // ---- activity ----

    public synchronized JSONArray activity(long chainId, String address) {
        try { return new JSONArray(p.getString("act_" + chainId + "_" + address.toLowerCase(), "[]")); } catch (Exception e) { return new JSONArray(); }
    }

    public synchronized void addActivity(long chainId, String address, JSONObject item) {
        JSONArray a = activity(chainId, address);
        JSONArray out = new JSONArray().put(item);
        for (int i = 0; i < a.length() && i < 199; i++) out.put(a.opt(i));
        p.edit().putString("act_" + chainId + "_" + address.toLowerCase(), out.toString()).apply();
    }

    public synchronized void updateActivity(long chainId, String address, String hash, String status) {
        try {
            JSONArray a = activity(chainId, address);
            for (int i = 0; i < a.length(); i++) if (a.getJSONObject(i).optString("hash").equalsIgnoreCase(hash)) a.getJSONObject(i).put("status", status);
            p.edit().putString("act_" + chainId + "_" + address.toLowerCase(), a.toString()).apply();
        } catch (Exception ignored) { }
    }

    // ---- browser bookmarks / history ----

    public synchronized JSONArray bookmarks() {
        try {
            String d = new JSONArray()
                .put(new JSONObject().put("title", "PSYROB").put("url", "https://psyrob.com"))
                .put(new JSONObject().put("title", "PSYROB Explorer").put("url", Settings.EXPLORER))
                .toString();
            return new JSONArray(p.getString("bookmarks", d));
        } catch (Exception e) { return new JSONArray(); }
    }

    public synchronized void setBookmarks(JSONArray b) { p.edit().putString("bookmarks", b.toString()).apply(); }

    public synchronized JSONArray history() { try { return new JSONArray(p.getString("history", "[]")); } catch (Exception e) { return new JSONArray(); } }

    public synchronized void addHistory(String url, String title) {
        try {
            JSONArray h = history();
            JSONArray out = new JSONArray().put(new JSONObject().put("url", url).put("title", title == null ? url : title));
            for (int i = 0; i < h.length() && out.length() < 30; i++) if (!h.getJSONObject(i).optString("url").equals(url)) out.put(h.get(i));
            p.edit().putString("history", out.toString()).apply();
        } catch (Exception ignored) { }
    }

    public synchronized void clearHistory() { p.edit().remove("history").apply(); }
}
