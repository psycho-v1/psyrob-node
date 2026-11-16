package com.psyrob.suite.app

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder
import com.psyrob.suite.core.Hex
import com.psyrob.suite.core.Rpc
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

private fun kindName(k: String) = when (k) { "send", "token" -> "Sent"; "contract" -> "Contract call"; "dapp" -> "dApp transaction"; "revoke" -> "Revoked approval"; else -> k }

/** Account name with a pencil; the pencil turns it into a field with save and cancel. */
@Composable
fun NameEditor(m: Model, i: Int, acc: JSONObject, big: Boolean = false) {
    val p = LocalPsy.current
    if (m.editing == i) {
        var v by remember(i) { mutableStateOf(acc.optString("name")) }
        val a = rememberAction()
        val focus = remember { FocusRequester() }
        fun save() { if (v.isBlank()) return; a.run { m.io { m.api.vault.rename(i, v.trim()) }; m.editing = -1; m.changed() } }
        Row(verticalAlignment = Alignment.CenterVertically) {
            BasicTextField(
                v, { v = it.take(32) }, singleLine = true,
                textStyle = TextStyle(color = p.text, fontSize = if (big) 17.sp else 15.sp, fontWeight = FontWeight.SemiBold),
                cursorBrush = SolidColor(p.accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { save() }),
                modifier = Modifier.weight(1f).focusRequester(focus).clip(RoundedCornerShape(8.dp)).background(p.input)
                    .border(1.dp, p.accent, RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 6.dp),
            )
            IconBtn("check", "Save name", { save() }, tint = p.ok, size = 36.dp)
            IconBtn("close", "Cancel", { m.editing = -1 }, tint = p.muted, size = 36.dp)
        }
        LaunchedEffect(i) { try { focus.requestFocus() } catch (_: Exception) {} }
    } else Row(verticalAlignment = Alignment.CenterVertically) {
        Text(acc.optString("name"), color = p.text, fontWeight = FontWeight.SemiBold, fontSize = if (big) 17.sp else 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false))
        IconBtn("edit", "Edit name", { m.editing = i }, size = 32.dp, tint = p.muted)
        when (acc.optString("kind")) { "watch" -> Tag("WATCH"); "imported" -> Badge("imported") }
    }
}

@Composable
fun WalletScreen(m: Model, s: Snap) {
    val p = LocalPsy.current
    LaunchedEffect(s.address, s.chainId) {
        if (m.assets?.optString("address") != s.address || m.assets?.optLong("chainId") != s.chainId) m.assets = null
        while (true) { m.loadAssets(); m.fetchStats(); delay(30_000) }
    }
    LaunchedEffect(Unit) { while (true) { delay(5_000); m.changed() } } // activity status
    val a = m.assets
    val list = if (a != null && a.optLong("chainId") == s.chainId && a.optString("address") == s.address) a.optJSONArray("assets")?.objects() else null
    val nat = list?.firstOrNull()

    if (!s.backedUp) Row(
        Modifier.fillMaxWidth().padding(bottom = 12.dp).clip(RoundedCornerShape(12.dp)).background(p.warnBg)
            .border(1.dp, p.warnLine, RoundedCornerShape(12.dp)).clickable { revealPhrase(m) }.padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PIcon("alert", tint = p.warnText, size = 20.dp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text("Your recovery phrase is not backed up yet.", color = p.warnText, fontSize = 14.sp)
            Text("Back it up now", color = p.warnText, fontWeight = FontWeight.Bold, fontSize = 14.sp, modifier = Modifier.padding(top = 2.dp))
        }
        PIcon("chevron-right", tint = p.warnText, size = 18.dp)
    }
    PCard {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { if (m.editing < 0) m.go("accounts") }, verticalAlignment = Alignment.CenterVertically) {
            Avatar(s.address, 44.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                NameEditor(m, s.selected, s.account, big = true)
                Text(short(s.shown), color = p.muted, fontSize = 13.sp, fontFamily = FontFamily.Monospace)
            }
            if (m.editing != s.selected) {
                PIcon("chevron-down", tint = p.muted, size = 18.dp)
                IconBtn("copy", "Copy address", { m.copy(s.shown) })
            }
        }
        Spacer(Modifier.height(14.dp))
        Row(verticalAlignment = Alignment.Bottom) {
            if (nat != null) Text(fmtAmt(nat.bal()), fontSize = 34.sp, fontWeight = FontWeight.Bold, color = p.text)
            else CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp, color = p.accent)
            Spacer(Modifier.width(8.dp))
            Text(s.symbol, fontSize = 16.sp, color = p.accent, fontWeight = FontWeight.Bold, modifier = Modifier.padding(bottom = 6.dp))
        }
        Row {
            Muted(s.netName)
            if (nat?.has("error") == true) Text(" · " + nat.optString("error"), color = p.bad, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(14.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            ActionTile("send", "Send", !s.watchOnly) { m.go("send") }
            ActionTile("receive", "Receive") { m.go("receive") }
            ActionTile("dapps", "dApps") { m.tab("browser") }
            ActionTile("approve", "Approvals") { m.go("approvals") }
        }
    }

    Section("Assets")
    PCard(padding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 4.dp)) {
        val rows = list ?: (listOf(JSONObject().put("symbol", s.symbol).put("name", s.symbol).put("native", true).put("logo", if (s.chainId == WalletData.PSYROB_CHAIN) "psy" else "")) + s.tokens)
        rows.forEachIndexed { i, t ->
            if (i > 0) Divider()
            val native = t.optBoolean("native")
            Item(
                t.optString("symbol"),
                if (native) (if (s.chainId == WalletData.PSYROB_CHAIN) "PSY · PSYROB Network" else t.optString("name")) else t.optString("name") + " · " + short(t.optString("address")),
                onClick = if (s.watchOnly) null else ({ m.go("send", mapOf("token" to if (native) "" else t.optString("address"))) }),
                lead = { Coin(t) },
                trailing = {
                    when {
                        t.has("error") -> Text("error", color = p.bad, fontSize = 13.sp)
                        list != null -> Text(fmtAmt(t.bal()), color = p.text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                        else -> CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = p.accent)
                    }
                },
            )
        }
        Divider()
        Row(Modifier.padding(vertical = 4.dp)) {
            LinkBtn("Add token", { m.go("addToken") }, icon = "plus")
            if (s.chainId == WalletData.PSYROB_CHAIN && s.tokens.none { it.optString("logo") == "mpsy" })
                LinkBtn("Show M-PSY", { m.api.data.showMpsy(); m.assets = null; m.changed() }, icon = "token")
        }
    }

    Section("Activity")
    PCard(padding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 4.dp)) {
        if (s.activity.isEmpty()) Muted("No transactions from this phone yet.", Modifier.padding(vertical = 12.dp))
        val df = remember { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT) }
        s.activity.take(30).forEachIndexed { i, x ->
            if (i > 0) Divider()
            val amt = x.optString("amount").takeIf { it.isNotEmpty() && it != "0" && it != "null" }
            Item(
                kindName(x.optString("kind")) + (amt?.let { " $it" } ?: ""),
                df.format(Date(x.optLong("at"))) + " · " + short(x.optString("to")) + (x.optString("summary").takeIf { it.isNotEmpty() && it != "null" }?.let { " · $it" } ?: ""),
                onClick = { m.open(s.explorer + "/tx/" + x.optString("hash")) },
                trailing = { Badge(x.optString("status"), x.optString("status")) },
            )
        }
        Divider()
        LinkBtn("Full history on the explorer", { m.open(s.explorer + "/address/" + s.address) }, icon = "external")
    }
}

@Composable
private fun ActionTile(icon: String, label: String, enabled: Boolean = true, onClick: () -> Unit) {
    val p = LocalPsy.current
    Column(
        Modifier.width(76.dp).clip(RoundedCornerShape(14.dp)).clickable(enabled = enabled, onClick = onClick).padding(vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(48.dp).clip(RoundedCornerShape(14.dp)).background(p.panel2).border(1.dp, p.line, RoundedCornerShape(14.dp)), contentAlignment = Alignment.Center) {
            PIcon(icon, tint = if (enabled) p.accent else p.muted.copy(alpha = .4f), size = 24.dp)
        }
        Spacer(Modifier.height(6.dp))
        Text(label, fontSize = 12.sp, color = if (enabled) p.text else p.muted, maxLines = 1)
    }
}

fun revealPhrase(m: Model) {
    m.launch {
        val ph = m.io {
            if (!AppLock.confirm(m.act, "Show recovery phrase")) null
            else if (!m.confirm("Show recovery phrase?", "Anyone who sees these words can take everything in this wallet. Make sure nobody is watching your screen. Never type them into a website.", "Show")) null
            else m.api.vault.phrase()
        }
        if (ph != null) m.go("backup", mapOf("phrase" to ph))
    }
}
