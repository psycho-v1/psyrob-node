package com.psyrob.suite.app;

import android.content.Context;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.json.JSONArray;
import org.json.JSONObject;

import com.psyrob.suite.core.Abi;
import com.psyrob.suite.core.Hex;
import com.psyrob.suite.core.Rpc;
import com.psyrob.suite.core.Tx;

/** Wallet operations against a network: balances, token data, building, signing and sending transactions. */
public final class WalletApi {
    private static WalletApi instance;
    public final Vault vault;
    public final WalletData data;
    private final Settings settings;
    private final Context ctx;
    private final Map<String, Pending> pending = new HashMap<String, Pending>();

    /** A transaction waiting for the user's confirmation. */
    public static final class Pending {
        public long chainId;
        public int account;
        public Tx tx;
        public String kind;
        public String summary;
        public String symbol;
        public String amountText;
        public String toText;
    }

    private WalletApi(Context c) {
        vault = new Vault(c);
        data = new WalletData(c);
        settings = new Settings(c);
        ctx = c;
    }

    public static synchronized WalletApi get(Context c) {
        if (instance == null) instance = new WalletApi(c.getApplicationContext());
        return instance;
    }

    /** JSON-RPC on a network; PSYROB uses the node list from Settings with failover. */
    public Object rpc(long chainId, String method, JSONArray params) throws Exception {
        List<String> urls;
        if (chainId == WalletData.PSYROB_CHAIN) urls = settings.nodeList();
        else {
            JSONObject n = data.network(chainId);
            if (n == null) throw new Exception("unknown network " + chainId);
            urls = Arrays.asList(n.getString("rpc"));
        }
        Exception last = null;
        for (String u : urls) {
            try { return Rpc.call(u, method, params); } catch (Rpc.TransientException e) { last = e; }
        }
        throw last;
    }

    private String call(long chainId, String to, byte[] data) throws Exception {
        return String.valueOf(rpc(chainId, "eth_call", new JSONArray().put(new JSONObject().put("to", to).put("data", Hex.with0x(data))).put("latest")));
    }

    /** Balances of the selected account on the active network: native coin first, then tokens. */
    public JSONObject assets() throws Exception {
        long cid = data.activeChain();
        JSONObject net = data.network(cid);
        String addr = vault.address();
        JSONObject out = new JSONObject().put("chainId", cid).put("network", net).put("address", addr);
        JSONArray list = new JSONArray();
        JSONObject nat = new JSONObject().put("symbol", net.getString("symbol")).put("name", cid == WalletData.PSYROB_CHAIN ? "PSY" : net.getString("name"))
            .put("decimals", net.optInt("decimals", 18)).put("native", true).put("logo", cid == WalletData.PSYROB_CHAIN ? "psy" : "");
        try {
            BigInteger b = Hex.quantity(rpc(cid, "eth_getBalance", new JSONArray().put(addr).put("latest")));
            nat.put("raw", b.toString()).put("balance", Abi.units(b, net.optInt("decimals", 18)));
        } catch (Exception e) { nat.put("error", e.getMessage()); }
        list.put(nat);
        JSONArray toks = data.tokens(cid);
        for (int i = 0; i < toks.length(); i++) {
            JSONObject t = new JSONObject(toks.getJSONObject(i).toString());
            try {
                BigInteger b = Abi.uint(call(cid, t.getString("address"), Abi.balanceOf(addr)));
                t.put("raw", b.toString()).put("balance", Abi.units(b, t.getInt("decimals")));
            } catch (Exception e) { t.put("error", e.getMessage()); }
            list.put(t);
        }
        return out.put("assets", list);
    }

    /** symbol, name and decimals of an ERC-20 contract. */
    public JSONObject tokenInfo(long chainId, String address) throws Exception {
        if (!address.matches("0x[0-9a-fA-F]{40}")) throw new Exception("A token address is 0x followed by 40 hex characters.");
        Object code = rpc(chainId, "eth_getCode", new JSONArray().put(address).put("latest"));
        if (String.valueOf(code).length() <= 2) throw new Exception("There is no contract at this address on this network.");
        JSONObject t = new JSONObject().put("address", address);
        t.put("symbol", Abi.string(call(chainId, address, Abi.selector("symbol()"))));
        try { t.put("name", Abi.string(call(chainId, address, Abi.selector("name()")))); } catch (Exception e) { t.put("name", t.getString("symbol")); }
        t.put("decimals", Abi.uint(call(chainId, address, Abi.selector("decimals()"))).intValue());
        return t;
    }

    /**
     * Fill nonce, gas and fees for a transaction from `account` on `chainId`. `p` holds the dApp/eth_sendTransaction
     * fields (to, value, data, gas, gasPrice, maxFeePerGas, maxPriorityFeePerGas, nonce), all optional except to/data.
     */
    public Tx build(long chainId, String from, JSONObject p) throws Exception {
        Tx t = new Tx();
        t.chainId = BigInteger.valueOf(chainId);
        String to = p.optString("to", "");
        t.to = to.isEmpty() || to.equals("null") ? null : Hex.decode(to);
        if (t.to != null && t.to.length != 20) throw new Exception("bad recipient address");
        t.value = p.has("value") && !p.isNull("value") ? Hex.quantity(p.get("value")) : BigInteger.ZERO;
        String d = p.has("data") && !p.isNull("data") ? p.getString("data") : p.optString("input", "0x");
        t.data = Hex.decode(d.isEmpty() ? "0x" : d);
        t.nonce = p.has("nonce") && !p.isNull("nonce") ? Hex.quantity(p.get("nonce"))
            : Hex.quantity(rpc(chainId, "eth_getTransactionCount", new JSONArray().put(from).put("pending")));
        if (p.has("gas") && !p.isNull("gas")) t.gasLimit = Hex.quantity(p.get("gas"));
        else if (p.has("gasLimit") && !p.isNull("gasLimit")) t.gasLimit = Hex.quantity(p.get("gasLimit"));
        else {
            JSONObject est = new JSONObject().put("from", from).put("value", "0x" + t.value.toString(16)).put("data", Hex.with0x(t.data));
            if (t.to != null) est.put("to", Hex.with0x(t.to));
            BigInteger g;
            try { g = Hex.quantity(rpc(chainId, "eth_estimateGas", new JSONArray().put(est))); }
            catch (Exception e) { throw new Exception("This transaction would fail: " + e.getMessage().replaceFirst("^eth_estimateGas: ", "")); }
            t.gasLimit = g.equals(BigInteger.valueOf(21000)) ? g : g.multiply(BigInteger.valueOf(12)).divide(BigInteger.TEN);
        }
        if (p.has("gasPrice") && !p.isNull("gasPrice")) t.gasPrice = Hex.quantity(p.get("gasPrice"));
        else {
            JSONObject blk = null;
            try { blk = (JSONObject) rpc(chainId, "eth_getBlockByNumber", new JSONArray().put("latest").put(false)); } catch (Exception ignored) { }
            if (blk != null && blk.has("baseFeePerGas") && !blk.isNull("baseFeePerGas")) {
                BigInteger base = Hex.quantity(blk.get("baseFeePerGas"));
                BigInteger tip;
                if (p.has("maxPriorityFeePerGas") && !p.isNull("maxPriorityFeePerGas")) tip = Hex.quantity(p.get("maxPriorityFeePerGas"));
                else { try { tip = Hex.quantity(rpc(chainId, "eth_maxPriorityFeePerGas", new JSONArray())); } catch (Exception e) { tip = BigInteger.valueOf(100000000L); } }
                t.maxPriorityFee = tip;
                t.maxFee = p.has("maxFeePerGas") && !p.isNull("maxFeePerGas") ? Hex.quantity(p.get("maxFeePerGas")) : base.shiftLeft(1).add(tip);
                if (t.maxFee.compareTo(t.maxPriorityFee) < 0) t.maxPriorityFee = t.maxFee;
            } else {
                t.gasPrice = Hex.quantity(rpc(chainId, "eth_gasPrice", new JSONArray()));
            }
        }
        return t;
    }

    /** Check the account can pay value + the highest fee; returns a warning or null. */
    public String fundsWarning(long chainId, String from, Tx t) {
        try {
            BigInteger bal = Hex.quantity(rpc(chainId, "eth_getBalance", new JSONArray().put(from).put("latest")));
            BigInteger need = t.value.add(t.maxCost());
            if (bal.compareTo(need) < 0) {
                JSONObject n = data.network(chainId);
                return "Not enough " + n.optString("symbol") + ": this needs up to " + Abi.units(need, 18) + " and the account holds " + Abi.units(bal, 18) + ".";
            }
        } catch (Exception ignored) { }
        return null;
    }

    public String newPending(Pending p) {
        String id = UUID.randomUUID().toString();
        synchronized (pending) { pending.put(id, p); }
        return id;
    }

    public Pending takePending(String id) { synchronized (pending) { return pending.remove(id); } }

    /** The confirmation data the screen shows for a pending transaction. */
    public JSONObject describe(String id, Pending p) throws Exception {
        JSONObject n = data.network(p.chainId);
        int dec = n.optInt("decimals", 18);
        Tx t = p.tx;
        BigInteger feeMax = t.maxCost();
        BigInteger feeLikely = t.legacy() ? feeMax : t.gasLimit.multiply(t.maxFee.subtract(t.maxPriorityFee).shiftRight(1).add(t.maxPriorityFee));
        return new JSONObject().put("id", id).put("kind", p.kind).put("network", n.getString("name")).put("from", vault.address(p.account))
            .put("to", t.to == null ? "new contract" : Hex.with0x(t.to)).put("toText", p.toText).put("amount", p.amountText)
            .put("value", Abi.units(t.value, dec) + " " + n.getString("symbol")).put("summary", p.summary)
            .put("fee", Abi.units(feeLikely, dec) + " " + n.getString("symbol")).put("feeMax", Abi.units(feeMax, dec) + " " + n.getString("symbol"))
            .put("gas", t.gasLimit.toString()).put("nonce", t.nonce.toString()).put("dataLen", t.data.length)
            .put("warning", fundsWarning(p.chainId, vault.address(p.account), t));
    }

    /** Sign with the account's key and broadcast. Returns the transaction hash. */
    public String sendSigned(Pending p) throws Exception {
        byte[] sk = vault.privateKey(p.account);
        try { p.tx.sign(sk); } finally { Arrays.fill(sk, (byte) 0); }
        String hash = String.valueOf(rpc(p.chainId, "eth_sendRawTransaction", new JSONArray().put(Hex.with0x(p.tx.raw))));
        String from = vault.address(p.account);
        data.addActivity(p.chainId, from, new JSONObject().put("hash", hash).put("kind", p.kind).put("at", System.currentTimeMillis())
            .put("to", p.toText != null ? p.toText : p.tx.to == null ? "contract creation" : Hex.with0x(p.tx.to))
            .put("amount", p.amountText).put("summary", p.summary).put("status", "pending"));
        watch(p.chainId, from, hash);
        return hash;
    }

    /** Follow a transaction until it has a receipt (up to about 10 minutes). */
    public void watch(final long chainId, final String from, final String hash) {
        new Thread(new Runnable() { public void run() {
            for (int i = 0; i < 120; i++) {
                try {
                    Thread.sleep(5000);
                    Object r = rpc(chainId, "eth_getTransactionReceipt", new JSONArray().put(hash));
                    if (r instanceof JSONObject) {
                        String st = ((JSONObject) r).optString("status");
                        data.updateActivity(chainId, from, hash, "0x1".equals(st) || "1".equals(st) ? "confirmed" : "failed");
                        return;
                    }
                } catch (Exception ignored) { }
            }
        } }).start();
    }


    // ---- approvals ----

    private static final String TOPIC_APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
    private static final String TOPIC_APPROVAL_ALL = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
    private volatile String scanStatus = null;

    public String scanStatus() { return scanStatus; }

    /**
     * Every token approval the selected account has given that is still active: Approval / ApprovalForAll logs found
     * with eth_getLogs (10,000 blocks per call, remembered between scans), then checked against the current allowance.
     */
    public JSONObject approvals() throws Exception {
        long cid = data.activeChain();
        String owner = vault.address().toLowerCase();
        android.content.SharedPreferences sp = ctx.getSharedPreferences("approvals", Context.MODE_PRIVATE);
        String key = cid + "_" + owner;
        JSONObject cache = new JSONObject(sp.getString(key, "{\"next\":0,\"pairs\":{}}"));
        long head = Hex.quantity(rpc(cid, "eth_blockNumber", new JSONArray())).longValue();
        long from = cache.getLong("next");
        String ownerTopic = "0x000000000000000000000000" + owner.substring(2);
        JSONObject pairs = cache.getJSONObject("pairs");
        try {
            while (from <= head) {
                long to = Math.min(head, from + 9999);
                scanStatus = "Scanning blocks " + from + " to " + to + " of " + head;
                for (String topic : new String[] { TOPIC_APPROVAL, TOPIC_APPROVAL_ALL }) {
                    JSONObject f = new JSONObject().put("fromBlock", "0x" + Long.toHexString(from)).put("toBlock", "0x" + Long.toHexString(to))
                        .put("topics", new JSONArray().put(topic).put(ownerTopic));
                    JSONArray logs = (JSONArray) rpc(cid, "eth_getLogs", new JSONArray().put(f));
                    for (int i = 0; i < logs.length(); i++) {
                        JSONObject l = logs.getJSONObject(i);
                        JSONArray tp = l.getJSONArray("topics");
                        if (tp.length() < 3) continue;
                        String token = l.getString("address").toLowerCase();
                        String spender = "0x" + tp.getString(2).substring(26).toLowerCase();
                        boolean all = topic.equals(TOPIC_APPROVAL_ALL);
                        if (!all && tp.length() == 4) continue; // ERC-721 single-item approval
                        pairs.put(token + ":" + spender + ":" + (all ? "all" : "erc20"), true);
                    }
                }
                from = to + 1;
                cache.put("next", from);
            }
        } finally {
            sp.edit().putString(key, cache.toString()).apply();
            scanStatus = null;
        }
        JSONArray out = new JSONArray();
        java.util.Iterator<String> it = pairs.keys();
        while (it.hasNext()) {
            String[] k = it.next().split(":");
            String token = k[0], spender = k[1];
            boolean all = k[2].equals("all");
            JSONObject row = new JSONObject().put("token", token).put("spender", spender).put("kind", k[2]);
            try {
                if (all) {
                    BigInteger v = Abi.uint(call(cid, token, Abi.call("isApprovedForAll(address,address)", Abi.word(Hex.decode(owner)), Abi.word(Hex.decode(spender)))));
                    if (v.signum() == 0) continue;
                    row.put("amount", "ALL items");
                } else {
                    BigInteger v = Abi.uint(call(cid, token, Abi.call("allowance(address,address)", Abi.word(Hex.decode(owner)), Abi.word(Hex.decode(spender)))));
                    if (v.signum() == 0) continue;
                    JSONObject t = data.token(cid, token);
                    if (t == null) { try { t = tokenInfo(cid, token); } catch (Exception e) { t = null; } }
                    row.put("symbol", t == null ? "?" : t.optString("symbol"));
                    row.put("amount", v.compareTo(BigInteger.ONE.shiftLeft(255)) >= 0 ? "Unlimited" : t == null ? v.toString() : Abi.units(v, t.optInt("decimals", 18)));
                }
                row.put("spenderIsContract", String.valueOf(rpc(cid, "eth_getCode", new JSONArray().put(spender).put("latest"))).length() > 2);
                out.put(row);
            } catch (Exception e) { row.put("error", e.getMessage()); out.put(row); }
        }
        return new JSONObject().put("head", head).put("approvals", out);
    }

    /** A revoke transaction (approve(spender, 0) or setApprovalForAll(operator, false)) waiting for confirmation. */
    public Pending prepareRevoke(String token, String spender, boolean all) throws Exception {
        long cid = data.activeChain();
        Pending p = new Pending();
        p.chainId = cid; p.account = vault.selected(); p.kind = "revoke"; p.toText = token;
        byte[] callData = all ? Abi.call("setApprovalForAll(address,bool)", Abi.word(Hex.decode(spender)), Abi.word(BigInteger.ZERO))
            : Abi.call("approve(address,uint256)", Abi.word(Hex.decode(spender)), Abi.word(BigInteger.ZERO));
        p.tx = build(cid, vault.address(), new JSONObject().put("to", token).put("data", Hex.with0x(callData)));
        p.summary = "Revoke: " + spender + " can no longer spend " + (all ? "your items in " : "this token ") + token;
        p.amountText = "0";
        return p;
    }

    /** A simple send of the native coin or a token from the main wallet screen. */
    public Pending prepareSend(JSONObject req) throws Exception {
        long cid = data.activeChain();
        JSONObject net = data.network(cid);
        String from = vault.address();
        String to = req.getString("to").trim();
        if (!to.matches("0x[0-9a-fA-F]{40}")) throw new Exception("The recipient must be an address: 0x followed by 40 hex characters.");
        if (!checksumOk(to)) throw new Exception("This address has a wrong capital-letter checksum: it may contain a typo.");
        String token = req.optString("token", "");
        Pending p = new Pending();
        p.chainId = cid; p.account = vault.selected(); p.toText = to;
        JSONObject tx = new JSONObject();
        if (token.isEmpty()) {
            BigInteger v = Abi.parseUnits(req.getString("amount"), net.optInt("decimals", 18));
            tx.put("to", to).put("value", "0x" + v.toString(16));
            p.kind = "send"; p.symbol = net.getString("symbol"); p.amountText = Abi.units(v, net.optInt("decimals", 18)) + " " + p.symbol;
        } else {
            JSONObject t = data.token(cid, token);
            if (t == null) throw new Exception("unknown token");
            BigInteger v = Abi.parseUnits(req.getString("amount"), t.getInt("decimals"));
            tx.put("to", token).put("data", Hex.with0x(Abi.transfer(to, v)));
            p.kind = "token"; p.symbol = t.getString("symbol"); p.amountText = Abi.units(v, t.getInt("decimals")) + " " + p.symbol;
            BigInteger bal = Abi.uint(call(cid, token, Abi.balanceOf(from)));
            if (bal.compareTo(v) < 0) throw new Exception("Not enough " + p.symbol + ": the account holds " + Abi.units(bal, t.getInt("decimals")) + ".");
        }
        if (to.equalsIgnoreCase(from)) p.summary = "Sending to your own address";
        p.tx = build(cid, from, tx);
        return p;
    }

    /** EIP-55: an all-lower or all-upper address has no checksum; a mixed-case one must match. */
    public static boolean checksumOk(String a) {
        String h = a.substring(2);
        if (h.equals(h.toLowerCase()) || h.equals(h.toUpperCase())) return true;
        return checksum(a).equals(a);
    }

    public static String checksum(String a) {
        String h = a.substring(2).toLowerCase();
        String k = Hex.encode(com.psyrob.suite.core.Keccak256.hash(h.getBytes()));
        StringBuilder sb = new StringBuilder("0x");
        for (int i = 0; i < 40; i++) sb.append(Character.digit(k.charAt(i), 16) >= 8 ? Character.toUpperCase(h.charAt(i)) : h.charAt(i));
        return sb.toString();
    }

    static String fmt(BigInteger wei) { return new BigDecimal(wei).movePointLeft(18).stripTrailingZeros().toPlainString(); }
}
