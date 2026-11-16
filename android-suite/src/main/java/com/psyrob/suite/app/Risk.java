package com.psyrob.suite.app;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;

import com.psyrob.suite.core.Hex;
import com.psyrob.suite.core.Tx;

/**
 * The pre-sign risk check. It looks at what the transaction does (decoded calldata), at the addresses involved
 * (contract or plain wallet), and replays the transaction on the node (eth_call) to see whether it would fail.
 * High risks lock the confirm button until the user acknowledges them.
 */
public final class Risk {
    public final List<String> high = new ArrayList<String>();
    public final List<String> medium = new ArrayList<String>();
    public String simulation;

    private Risk() {}

    public boolean isHigh() { return !high.isEmpty(); }

    public String text() {
        StringBuilder sb = new StringBuilder();
        for (String h : high) sb.append("⛔ ").append(h).append("\n\n");
        for (String m : medium) sb.append("⚠ ").append(m).append("\n\n");
        return sb.length() == 0 ? null : sb.toString().trim();
    }

    private static boolean isContract(WalletApi api, long cid, String a) {
        try { return String.valueOf(api.rpc(cid, "eth_getCode", new JSONArray().put(a).put("latest"))).length() > 2; } catch (Exception e) { return true; }
    }

    public static Risk assess(WalletApi api, long cid, String from, Tx tx, String origin) {
        Risk r = new Risk();
        String to = tx.to == null ? null : Hex.with0x(tx.to);
        // replay on the node
        try {
            JSONObject call = new JSONObject().put("from", from).put("value", "0x" + tx.value.toString(16)).put("data", Hex.with0x(tx.data)).put("gas", "0x" + tx.gasLimit.toString(16));
            if (to != null) call.put("to", to);
            api.rpc(cid, "eth_call", new JSONArray().put(call).put("latest"));
            r.simulation = "Simulated on the node: the transaction succeeds.";
        } catch (Exception e) {
            r.simulation = "Simulated on the node: the transaction FAILS (" + String.valueOf(e.getMessage()).replaceFirst("^eth_call: ", "") + ").";
            r.high.add("The node says this transaction would fail. You would still pay the network fee.");
        }
        if (origin != null && origin.matches("https://(\\d+\\.){3}\\d+(:\\d+)?")) r.medium.add("The site is a bare IP address, not a domain name.");
        byte[] d = tx.data;
        if (to != null && d.length >= 4) {
            String sel = Hex.encode(Arrays.copyOfRange(d, 0, 4));
            boolean toIsContract = isContract(api, cid, to);
            if (!toIsContract) r.medium.add("The data is sent to " + to + ", which is not a contract: the call does nothing there.");
            if ((sel.equals("095ea7b3") || sel.equals("39509351") || sel.equals("a22cb465")) && d.length >= 68) {
                String spender = Hex.with0x(Arrays.copyOfRange(d, 16, 36));
                BigInteger amt = new BigInteger(1, Arrays.copyOfRange(d, 36, 68));
                boolean revoke = amt.signum() == 0;
                if (!revoke) {
                    if (!isContract(api, cid, spender)) r.high.add("The spender " + spender + " is a plain wallet (EOA), not a contract. Approvals to a wallet are a common way to steal tokens.");
                    if (sel.equals("a22cb465")) r.high.add("This gives the operator control over ALL your items in this collection.");
                    else if (amt.compareTo(BigInteger.ONE.shiftLeft(255)) >= 0) r.medium.add("Unlimited approval: the spender can take all of this token until you revoke it (Wallet › Approvals).");
                }
            }
            if ((sel.equals("a9059cbb") || sel.equals("23b872dd")) && d.length >= 68) {
                int off = sel.equals("a9059cbb") ? 4 : 36;
                String recipient = Hex.with0x(Arrays.copyOfRange(d, off + 12, off + 32));
                if (recipient.equalsIgnoreCase(to)) r.high.add("The tokens are sent to the token contract itself; they would most likely be lost.");
                if (recipient.equals("0x0000000000000000000000000000000000000000")) r.high.add("The tokens are sent to the zero address and would be lost.");
            }
        }
        if (to != null && d.length == 0 && tx.value.signum() > 0 && to.equals("0x0000000000000000000000000000000000000000")) r.high.add("This sends coins to the zero address; they would be lost.");
        if (to == null) r.medium.add("This deploys a new contract.");
        return r;
    }
}
