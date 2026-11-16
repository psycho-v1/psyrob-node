package com.psyrob.suite.app;

import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONArray;
import org.json.JSONObject;

import com.psyrob.suite.core.Abi;
import com.psyrob.suite.core.Eip712;
import com.psyrob.suite.core.Hex;
import com.psyrob.suite.core.Tx;

/**
 * The dApp browser's wallet side. Pages get window.ethereum (assets/provider.js); every request is answered here, and
 * anything that connects, spends or signs needs the user's approval on the wallet's own sheet (Approval).
 * The screen around the page is drawn in Compose by BrowserActivity.
 */
public abstract class BrowserCore extends HostActivity {
    public static final String EXTRA_URL = "url";
    private static final Set<String> SIGNING = new HashSet<String>(Arrays.asList(
        "eth_sendTransaction", "eth_sign", "personal_sign", "eth_signTypedData", "eth_signTypedData_v1", "eth_signTypedData_v3",
        "eth_signTypedData_v4", "eth_signTransaction", "eth_requestAccounts", "eth_accounts", "eth_coinbase"));

    protected WebView web;
    protected WalletApi api;
    private volatile String topUrl = "";
    private String providerTemplate;
    private final String uuid = UUID.randomUUID().toString();
    private final ExecutorService exec = Executors.newCachedThreadPool();
    /** One approval sheet at a time, in order. */
    private final Object approvalLock = new Object();

    /** The page's address or title changed. */
    protected abstract void onPage(String url, String title);
    /** Loading progress, 0..100. */
    protected abstract void onProgress(int p);
    /** The network or the account changed (the toolbar chip shows them). */
    protected abstract void onWalletChanged();

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        api = WalletApi.get(this);
        providerTemplate = asset("provider.js");
    }

    /** Builds the page view; called once by the Compose screen. */
    protected WebView createWeb() {
        if (web != null) return web;
        web = new WebView(this);
        web.setBackgroundColor(Theme.of(this).bg);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setUserAgentString(s.getUserAgentString() + " PSYROBSuite/1.0");
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.addJavascriptInterface(new ProviderBridge(), "PSYProvider");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String sc = u.getScheme() == null ? "" : u.getScheme();
                if (sc.equals("https")) return false;
                if (sc.equals("http")) { v.loadUrl(u.buildUpon().scheme("https").build().toString()); return true; }
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
            @Override public void onPageStarted(WebView v, String url, Bitmap fav) {
                topUrl = url == null ? "" : url;
                onPage(topUrl, null);
                inject();
            }
            @Override public void doUpdateVisitedHistory(WebView v, String url, boolean reload) { topUrl = url == null ? "" : url; onPage(topUrl, v.getTitle()); }
            @Override public void onPageFinished(WebView v, String url) {
                topUrl = url == null ? "" : url;
                inject();
                onPage(topUrl, v.getTitle());
                api.data.addHistory(url, v.getTitle());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView v, int pr) {
                onProgress(pr);
                if (pr >= 10 && pr < 100) inject();
            }
        });
        String start = getIntent().getStringExtra(EXTRA_URL);
        if (start != null) go(start);
        return web;
    }

    protected String startUrl() { return getIntent().getStringExtra(EXTRA_URL); }
    protected String currentUrl() { return topUrl; }

    protected void go(String input) {
        String s = input.trim();
        if (s.isEmpty()) return;
        String url;
        if (s.startsWith("https://")) url = s;
        else if (s.startsWith("http://")) url = "https://" + s.substring(7);
        else if (s.matches("^[\\w.-]+\\.[a-zA-Z]{2,}(/.*)?$")) url = "https://" + s;
        else url = "https://duckduckgo.com/?q=" + Uri.encode(s);
        web.requestFocus();
        web.loadUrl(url);
    }

    protected String origin() {
        try { Uri u = Uri.parse(topUrl); return u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : ""); } catch (Exception e) { return ""; }
    }

    private void inject() {
        if (!topUrl.startsWith("https://")) return;
        String addr = api.vault.address();
        boolean conn = addr != null && api.data.connected(origin(), addr);
        String js = providerTemplate.replace("__CHAIN__", "0x" + Long.toHexString(api.data.activeChain()))
            .replace("__ACCOUNTS__", conn ? "[\"" + addr.toLowerCase() + "\"]" : "[]")
            .replace("__UUID__", uuid).replace("__ICON__", icon());
        web.evaluateJavascript(js, null);
    }

    private String iconCache;
    private String icon() {
        if (iconCache == null) iconCache = "data:image/svg+xml;base64," + Base64.encodeToString(asset("psy-logo.svg").getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        return iconCache;
    }

    private String asset(String name) {
        try {
            InputStream in = getAssets().open(name);
            byte[] buf = new byte[in.available()];
            int off = 0, n;
            while (off < buf.length && (n = in.read(buf, off, buf.length - off)) > 0) off += n;
            in.close();
            return new String(buf, StandardCharsets.UTF_8);
        } catch (Exception e) { throw new IllegalStateException(e); }
    }

    protected void bookmark() {
        try { JSONArray bm = api.data.bookmarks(); bm.put(new JSONObject().put("title", web.getTitle()).put("url", topUrl)); api.data.setBookmarks(bm); toast("Bookmarked"); } catch (Exception ignored) { }
    }
    protected void disconnectSite() { api.data.disconnect(origin()); emit("accountsChanged", new JSONArray()); toast("Disconnected " + origin()); }
    protected void openOutside() { try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(topUrl))); } catch (Exception ignored) { } }
    protected void switchNetwork(long chainId) {
        api.data.setActiveChain(chainId);
        onWalletChanged();
        emit("chainChanged", "0x" + Long.toHexString(api.data.activeChain()));
    }
    protected void switchAccount(int i) {
        api.vault.select(i);
        String a = api.vault.address();
        onWalletChanged();
        emit("accountsChanged", api.data.connected(origin(), a) ? new JSONArray().put(a.toLowerCase()) : new JSONArray());
    }

    static String short4(String a) { return a == null || a.length() < 12 ? String.valueOf(a) : a.substring(0, 6) + "…" + a.substring(a.length() - 4); }


    private void emit(final String ev, final Object data) {
        runOnUiThread(new Runnable() { public void run() {
            if (web != null) web.evaluateJavascript("window.__psyrobEmit && window.__psyrobEmit(" + JSONObject.quote(ev) + "," + (data instanceof String ? JSONObject.quote((String) data) : String.valueOf(data)) + ")", null);
        } });
    }

    private void reply(final int id, final JSONObject err, final Object result) {
        final String res = result == null ? "null" : result instanceof String ? JSONObject.quote((String) result) : result.toString();
        runOnUiThread(new Runnable() { public void run() {
            if (web != null) web.evaluateJavascript("window.__psyrobReply && window.__psyrobReply(" + id + "," + (err == null ? "null" : err.toString()) + "," + res + ")", null);
        } });
    }

    @Override protected void onStart() {
        super.onStart();
        if (AppLock.locked(this)) { // back to the lock screen; the dApp page is closed
            startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
            finish();
        }
    }

    @Override protected void onDestroy() {
        exec.shutdownNow();
        if (web != null) { web.removeJavascriptInterface("PSYProvider"); web.destroy(); web = null; }
        super.onDestroy();
    }

    /** EIP-1193 errors. */
    static final class ProviderError extends Exception {
        final int code;
        ProviderError(int code, String m) { super(m); this.code = code; }
    }

    final class ProviderBridge {
        @JavascriptInterface public void request(final int id, final String payload) {
            final String origin = origin();
            final String page = topUrl;
            exec.execute(new Runnable() { public void run() {
                try {
                    if (!page.startsWith("https://")) throw new ProviderError(4100, "The wallet only answers https pages.");
                    JSONObject p = new JSONObject(payload);
                    Object params = p.opt("params");
                    JSONArray arr = params instanceof JSONArray ? (JSONArray) params : params == null || params == JSONObject.NULL ? new JSONArray() : new JSONArray().put(params);
                    reply(id, null, handle(origin, p.getString("method"), arr));
                } catch (ProviderError e) {
                    try { reply(id, new JSONObject().put("code", e.code).put("message", e.getMessage()), null); } catch (Exception ignored) { }
                } catch (Exception e) {
                    try { reply(id, new JSONObject().put("code", -32603).put("message", String.valueOf(e.getMessage())), null); } catch (Exception ignored) { }
                }
            } });
        }
    }

    private Object handle(String origin, String method, JSONArray params) throws Exception {
        if (AppLock.locked(this)) throw new ProviderError(4100, "The wallet is locked.");
        String addr = api.vault.address();
        long cid = api.data.activeChain();
        boolean conn = api.data.connected(origin, addr);
        if (method.equals("eth_chainId")) return "0x" + Long.toHexString(cid);
        if (method.equals("net_version")) return String.valueOf(cid);
        if (method.equals("eth_accounts")) return conn ? new JSONArray().put(addr.toLowerCase()) : new JSONArray();
        if (method.equals("eth_coinbase")) return conn ? addr.toLowerCase() : null;
        if (method.equals("eth_requestAccounts") || method.equals("wallet_requestPermissions")) {
            if (!conn) {
                List<String[]> rows = new ArrayList<String[]>();
                rows.add(new String[] { "Account", accountName() + "\n" + addr });
                rows.add(new String[] { "Network", api.data.active().optString("name") });
                rows.add(new String[] { "The site will be able to", "see your address and balance, and ask you to approve transactions and signatures. It cannot move funds without your approval." });
                if (!approve("Connect to this site?", origin, rows, null, null, "Connect", false)) throw new ProviderError(4001, "User rejected the request.");
                api.data.connect(origin, addr);
            }
            if (method.equals("wallet_requestPermissions")) return permissions(origin);
            return new JSONArray().put(addr.toLowerCase());
        }
        if (method.equals("wallet_getPermissions")) return conn ? permissions(origin) : new JSONArray();
        if (method.equals("wallet_revokePermissions")) { api.data.disconnect(origin); emit("accountsChanged", new JSONArray()); return null; }
        if (method.equals("wallet_switchEthereumChain")) {
            long want = Hex.quantity(params.getJSONObject(0).get("chainId")).longValue();
            if (want == cid) return null;
            JSONObject n = api.data.network(want);
            if (n == null) throw new ProviderError(4902, "Unrecognized chain ID " + params.getJSONObject(0).opt("chainId") + ". Try adding the chain using wallet_addEthereumChain first.");
            // known networks switch automatically, as Rabby does; the chip in the toolbar shows the change
            api.data.setActiveChain(want);
            toast("Switched to " + n.optString("name"));
            onWalletChanged();
            emit("chainChanged", "0x" + Long.toHexString(want));
            return null;
        }
        if (method.equals("wallet_addEthereumChain")) {
            JSONObject c = params.getJSONObject(0);
            long want = Hex.quantity(c.get("chainId")).longValue();
            JSONObject existing = api.data.network(want);
            if (existing == null) {
                JSONArray rpcs = c.optJSONArray("rpcUrls");
                String rpc = null;
                for (int i = 0; rpcs != null && i < rpcs.length(); i++) if (rpcs.getString(i).startsWith("https://")) { rpc = rpcs.getString(i); break; }
                if (rpc == null) throw new ProviderError(-32602, "rpcUrls must contain an https address");
                JSONObject cur = c.optJSONObject("nativeCurrency");
                JSONArray ex = c.optJSONArray("blockExplorerUrls");
                JSONObject n = new JSONObject().put("chainId", want).put("name", c.optString("chainName", "Chain " + want)).put("rpc", rpc)
                    .put("symbol", cur == null ? "ETH" : cur.optString("symbol", "ETH")).put("decimals", cur == null ? 18 : cur.optInt("decimals", 18))
                    .put("explorer", ex != null && ex.length() > 0 ? ex.getString(0) : "");
                List<String[]> rows = new ArrayList<String[]>();
                rows.add(new String[] { "Network", n.getString("name") });
                rows.add(new String[] { "Chain ID", String.valueOf(want) });
                rows.add(new String[] { "RPC address", rpc });
                rows.add(new String[] { "Currency", n.getString("symbol") });
                if (!approve("Add a network?", origin, rows, "Only add networks you trust: a malicious network can show you wrong balances.", null, "Add network", false))
                    throw new ProviderError(4001, "User rejected the request.");
                // a network that answers with another chain ID is refused
                Object got = com.psyrob.suite.core.Rpc.call(rpc, "eth_chainId", new JSONArray());
                if (Hex.quantity(got).longValue() != want) throw new ProviderError(-32603, "The RPC address answers for chain " + Hex.quantity(got) + ", not " + want);
                api.data.addNetwork(n);
            }
            if (want != api.data.activeChain()) return handle(origin, "wallet_switchEthereumChain", new JSONArray().put(new JSONObject().put("chainId", "0x" + Long.toHexString(want))));
            return null;
        }
        if (method.equals("wallet_watchAsset")) {
            JSONObject a = params.length() > 0 && params.get(0) instanceof JSONObject ? params.getJSONObject(0) : new JSONObject();
            if (!a.optString("type").equalsIgnoreCase("ERC20")) throw new ProviderError(-32602, "Only ERC20 tokens can be added.");
            JSONObject o = a.getJSONObject("options");
            JSONObject t;
            try { t = api.tokenInfo(cid, o.getString("address")); } catch (Exception e) { throw new ProviderError(-32602, e.getMessage()); }
            List<String[]> rows = new ArrayList<String[]>();
            rows.add(new String[] { "Token", t.getString("symbol") + " (" + t.optString("name") + ")" });
            rows.add(new String[] { "Contract", t.getString("address") });
            rows.add(new String[] { "Decimals", String.valueOf(t.getInt("decimals")) });
            String warn = !t.getString("symbol").equals(o.optString("symbol", t.getString("symbol"))) ? "The site calls this token " + o.optString("symbol") + " but the contract says " + t.getString("symbol") + "." : null;
            if (!approve("Add token?", origin, rows, warn, null, "Add token", false)) throw new ProviderError(4001, "User rejected the request.");
            api.data.addToken(cid, t.put("image", o.optString("image", "")));
            return true;
        }
        if ((method.equals("eth_sendTransaction") || method.startsWith("eth_sign") || method.equals("personal_sign")) && api.vault.watchOnly())
            throw new ProviderError(4100, "The selected account is watch-only: it cannot sign.");
        if (SIGNING.contains(method) && !conn) throw new ProviderError(4100, "Connect this site to the wallet first (eth_requestAccounts).");
        if (method.equals("eth_sendTransaction")) return sendTransaction(origin, params.getJSONObject(0), addr, cid);
        if (method.equals("personal_sign")) {
            String a0 = params.getString(0), a1 = params.optString(1, "");
            String msgHex = a1.matches("0x[0-9a-fA-F]{40}") && !a0.matches("0x[0-9a-fA-F]{40}") ? a0 : a0.matches("0x[0-9a-fA-F]{40}") ? a1 : a0;
            String signer = msgHex.equals(a0) ? a1 : a0;
            if (signer.length() > 0 && !signer.equalsIgnoreCase(addr)) throw new ProviderError(4100, "The site asked to sign with " + signer + ", which is not the selected account.");
            byte[] msg = msgHex.startsWith("0x") && msgHex.matches("0x([0-9a-fA-F]{2})*") ? Hex.decode(msgHex) : msgHex.getBytes(StandardCharsets.UTF_8);
            String shown = readable(msg);
            List<String[]> rows = new ArrayList<String[]>();
            rows.add(new String[] { "Account", accountName() + "\n" + addr });
            String warn = shown == null ? "This message is not readable text. Only sign it if you trust the site." : null;
            if (!approve("Signature request", origin, rows, warn, shown != null ? shown : Hex.with0x(msg), "Sign", false)) throw new ProviderError(4001, "User rejected the request.");
            return sign(Tx.personalDigest(msg));
        }
        if (method.startsWith("eth_signTypedData")) {
            if (method.equals("eth_signTypedData") || method.equals("eth_signTypedData_v1")) throw new ProviderError(4200, "eth_signTypedData (v1) is not supported; use eth_signTypedData_v4.");
            String signer = params.getString(0);
            Object raw = params.get(1);
            if (!signer.matches("0x[0-9a-fA-F]{40}")) { signer = params.getString(1); raw = params.get(0); }
            if (!signer.equalsIgnoreCase(addr)) throw new ProviderError(4100, "The site asked to sign with " + signer + ", which is not the selected account.");
            JSONObject typed = raw instanceof JSONObject ? (JSONObject) raw : new JSONObject(String.valueOf(raw));
            JSONObject dom = typed.optJSONObject("domain");
            String warn = null;
            if (dom != null && dom.has("chainId") && Hex.quantity(dom.get("chainId")).longValue() != cid)
                throw new ProviderError(-32603, "The data is for chain " + Hex.quantity(dom.get("chainId")) + " but the wallet is on chain " + cid + ".");
            String pt = typed.optString("primaryType");
            if (pt.equals("Permit") || pt.equals("PermitSingle") || pt.equals("PermitBatch") || pt.equals("PermitTransferFrom"))
                warn = "PERMIT: this signature lets " + typed.optJSONObject("message").optString("spender", "another address") + " spend your tokens without a further transaction.";
            List<String[]> rows = new ArrayList<String[]>();
            rows.add(new String[] { "Account", accountName() + "\n" + addr });
            boolean okSig;
            synchronized (approvalLock) { okSig = Approval.ask(this, "Sign typed data", origin, rows, warn, Eip712.summary(typed), "Sign", warn != null, warn != null ? "I understand this signature can move my tokens" : null); }
            if (!okSig) throw new ProviderError(4001, "User rejected the request.");
            return sign(Eip712.digest(typed));
        }
        if (method.equals("eth_sign")) throw new ProviderError(4200, "eth_sign is disabled because it can sign transactions blindly. Use personal_sign.");
        if (method.equals("eth_signTransaction")) throw new ProviderError(4200, "eth_signTransaction is not supported; use eth_sendTransaction.");
        if (method.startsWith("eth_") || method.equals("web3_clientVersion") || method.equals("net_listening") || method.equals("net_peerCount"))
            return api.rpc(cid, method, params);
        throw new ProviderError(4200, "The method " + method + " is not supported.");
    }

    private JSONArray permissions(String origin) throws Exception {
        return new JSONArray().put(new JSONObject().put("parentCapability", "eth_accounts").put("invoker", origin)
            .put("caveats", new JSONArray().put(new JSONObject().put("type", "restrictReturnedAccounts").put("value", new JSONArray().put(api.vault.address().toLowerCase())))));
    }

    private String accountName() { return api.vault.accounts().optJSONObject(api.vault.selected()).optString("name"); }

    private boolean approve(String title, String origin, List<String[]> rows, String warning, String detail, String ok, boolean danger) {
        synchronized (approvalLock) { return Approval.ask(this, title, origin, rows, warning, detail, ok, danger); }
    }

    private String sign(byte[] digest) throws Exception {
        byte[] sk = api.vault.privateKey();
        try { return Hex.with0x(Tx.signDigest27(digest, sk)); } finally { Arrays.fill(sk, (byte) 0); }
    }

    private static String readable(byte[] b) {
        try {
            String s = StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(b)).toString();
            for (int i = 0; i < s.length(); i++) { char c = s.charAt(i); if (c < 0x20 && c != '\n' && c != '\r' && c != '\t') return null; }
            return s;
        } catch (Exception e) { return null; }
    }

    private Object sendTransaction(String origin, JSONObject t, String addr, long cid) throws Exception {
        String from = t.optString("from", addr);
        if (!from.equalsIgnoreCase(addr)) throw new ProviderError(4100, "The transaction is from " + from + ", which is not the selected account.");
        if (t.has("chainId") && !t.isNull("chainId") && Hex.quantity(t.get("chainId")).longValue() != cid)
            throw new ProviderError(-32603, "The transaction is for chain " + Hex.quantity(t.get("chainId")) + " but the wallet is on chain " + cid + ".");
        Tx tx;
        try { tx = api.build(cid, addr, t); } catch (Exception e) { throw new ProviderError(-32603, e.getMessage()); }
        WalletApi.Pending p = new WalletApi.Pending();
        p.chainId = cid; p.account = api.vault.selected(); p.tx = tx; p.kind = tx.data.length > 0 ? "contract" : "send";
        JSONObject net = api.data.network(cid);
        String sym = null; int dec = 18;
        if (tx.to != null && tx.data.length >= 4) {
            JSONObject known = api.data.token(cid, Hex.with0x(tx.to));
            if (known == null) { try { known = api.tokenInfo(cid, Hex.with0x(tx.to)); } catch (Exception ignored) { } }
            if (known != null) { sym = known.optString("symbol", null); dec = known.optInt("decimals", 18); }
        }
        String what = Abi.describe(tx.data, sym, dec);
        p.summary = what;
        p.amountText = Abi.units(tx.value, net.optInt("decimals", 18)) + " " + net.optString("symbol");
        JSONObject d = api.describe("dapp", p);
        List<String[]> rows = new ArrayList<String[]>();
        rows.add(new String[] { "From", accountName() + "\n" + addr });
        rows.add(new String[] { tx.to == null ? "Creates" : "To (contract or address)", d.getString("to") });
        rows.add(new String[] { "Amount", d.getString("value") });
        if (what != null) rows.add(new String[] { "Action", what });
        else if (tx.data.length >= 4) rows.add(new String[] { "Contract call", "function 0x" + Hex.encode(Arrays.copyOfRange(tx.data, 0, 4)) + ", " + tx.data.length + " bytes of data" });
        rows.add(new String[] { "Network fee (likely / at most)", d.getString("fee") + " / " + d.getString("feeMax") });
        rows.add(new String[] { "Network", net.optString("name") });
        Risk risk = Risk.assess(api, cid, addr, tx, origin);
        rows.add(new String[] { "Pre-sign check", risk.simulation });
        String warn = d.isNull("warning") ? null : d.getString("warning");
        if (risk.text() != null) warn = (warn == null ? "" : warn + "\n\n") + risk.text();
        boolean danger = (what != null && what.startsWith("APPROVAL")) || risk.isHigh();
        String detail = tx.data.length > 0 ? "data: " + Hex.with0x(tx.data) : null;
        if (detail != null && detail.length() > 600) detail = detail.substring(0, 600) + "…";
        boolean ok;
        synchronized (approvalLock) {
            ok = Approval.ask(this, what != null && what.startsWith("APPROVAL") ? "Approve token spending?" : "Confirm transaction", origin, rows, warn, detail,
                what != null && what.startsWith("APPROVAL") ? "Approve" : "Confirm", danger, risk.isHigh() ? "I understand the risk and want to continue" : null);
        }
        if (!ok) throw new ProviderError(4001, "User rejected the transaction.");
        try { return api.sendSigned(p); } catch (Exception e) { throw new ProviderError(-32603, e.getMessage()); }
    }

}
