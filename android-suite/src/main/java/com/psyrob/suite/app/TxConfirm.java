package com.psyrob.suite.app;

import android.app.Activity;

import java.util.ArrayList;
import java.util.List;

import org.json.JSONObject;

import com.psyrob.suite.core.Hex;

/** Confirmation sheet + risk check + send for transactions started from the wallet's own screens. */
final class TxConfirm {
    private TxConfirm() {}

    /** Returns the transaction hash, or null when the user rejected. */
    static String run(Activity a, WalletApi api, WalletApi.Pending p, String title) throws Exception {
        if (api.vault.watchOnly(p.account)) throw new Exception("This account is watch-only: it cannot send.");
        JSONObject d = api.describe("wallet", p);
        String from = api.vault.address(p.account);
        List<String[]> rows = new ArrayList<String[]>();
        rows.add(new String[] { "From", api.vault.accounts().optJSONObject(p.account).optString("name") + "\n" + from });
        rows.add(new String[] { "To", p.toText != null ? p.toText : d.getString("to") });
        if (p.amountText != null && !"0".equals(p.amountText)) rows.add(new String[] { "Amount", p.amountText });
        if (p.summary != null) rows.add(new String[] { "Action", p.summary });
        rows.add(new String[] { "Network fee (likely / at most)", d.getString("fee") + " / " + d.getString("feeMax") });
        rows.add(new String[] { "Network", d.getString("network") });
        Risk risk = Risk.assess(api, p.chainId, from, p.tx, null);
        rows.add(new String[] { "Pre-sign check", risk.simulation });
        String warn = d.isNull("warning") ? null : d.getString("warning");
        if (risk.text() != null) warn = (warn == null ? "" : warn + "\n\n") + risk.text();
        String detail = p.tx.data.length > 0 ? "data: " + Hex.with0x(p.tx.data) : null;
        boolean ok = Approval.ask(a, title, null, rows, warn, detail, "Confirm", risk.isHigh(), risk.isHigh() ? "I understand the risk and want to continue" : null);
        if (!ok) return null;
        return api.sendSigned(p);
    }
}
