package com.psyrob.suite.app

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder
import com.psyrob.suite.core.Hex
import com.psyrob.suite.core.Rpc
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject

private val LIST_PAD = PaddingValues(horizontal = 14.dp, vertical = 4.dp)

@Composable
fun PasteBtn(m: Model, set: (String) -> Unit) = LinkBtn("Paste", { set(m.paste()) })

@Composable
fun AccountsScreen(m: Model, s: Snap) {
    val p = LocalPsy.current
    val add = rememberAction()
    PageHead("Accounts") { m.back() }
    PCard(padding = LIST_PAD) {
        s.accounts.forEachIndexed { i, a ->
            if (i > 0) Divider()
            Item(
                a.optString("name"), short(a.optString("address")), subMono = true,
                onClick = { if (m.editing < 0) m.launch { m.io { m.api.vault.select(i) }; m.assets = null; m.tab("wallet") } },
                lead = { Avatar(a.optString("address")) },
                titleContent = { NameEditor(m, i, a) },
                trailing = {
                    if (m.editing != i) {
                        IconBtn("copy", "Copy address", { m.copy(a.optString("address")) }, size = 36.dp)
                        if (i == s.selected) PIcon("check", tint = p.ok, size = 20.dp)
                    }
                },
            )
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        PButton("New", {
            add.run {
                val addr = m.io { m.api.vault.addAccount() }
                m.assets = null; m.changed()
                m.editing = m.api.vault.accounts().objects().indexOfFirst { it.optString("address").equals(addr, true) }
            }
        }, Modifier.weight(1f), kind = Kind.Ghost, icon = "user-plus", enabled = s.hasPhrase, busy = add.busy, busyText = "Adding")
        PButton("Import", { m.go("importKey") }, Modifier.weight(1f), kind = Kind.Ghost, icon = "key")
    }
    Spacer(Modifier.height(10.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        PButton("Watch", { m.go("watch") }, Modifier.weight(1f), kind = Kind.Ghost, icon = "eye")
        PButton("Manage", { m.go("editAccount", mapOf("i" to s.selected)) }, Modifier.weight(1f), kind = Kind.Ghost, icon = "settings")
    }
    ErrText(add.err)
}

@Composable
fun WatchScreen(m: Model) {
    var addr by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    val a = rememberAction()
    PageHead("Watch an address") { m.back() }
    PCard {
        Muted("Follow any address: balances, tokens and approvals. Watch-only accounts cannot send or sign.")
        Field(addr, { addr = it.trim() }, Modifier.fillMaxWidth().padding(top = 10.dp), placeholder = "0x…", mono = true, trailing = { PasteBtn(m) { addr = it } })
        Field(name, { name = it.take(32) }, label = "Name (optional)", placeholder = "e.g. Friend's wallet")
        ErrText(a.err)
        Spacer(Modifier.height(12.dp))
        PButton("Add", { a.run { m.io { val x = m.api.vault.addWatch(addr); renameNew(m, x, name) }; m.assets = null; m.tab("wallet") } }, busy = a.busy, busyText = "Adding", icon = "eye")
    }
}

@Composable
fun EditAccountScreen(m: Model, s: Snap, i: Int) {
    val p = LocalPsy.current
    val acc = s.accounts.getOrNull(i) ?: JSONObject()
    var name by remember(i) { mutableStateOf(acc.optString("name")) }
    var key by remember { mutableStateOf<String?>(null) }
    val a = rememberAction()
    PageHead("Edit account") { m.back() }
    PCard {
        Field(name, { name = it.take(32) }, label = "Name", trailing = {
            IconBtn("check", "Save name", { if (name.isNotBlank()) a.run { m.io { m.api.vault.rename(i, name.trim()) }; m.changed(); m.back() } }, tint = p.ok)
        })
        Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            SelectionContainer(Modifier.weight(1f)) { Text(acc.optString("address"), fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = p.muted) }
            IconBtn("copy", "Copy address", { m.copy(acc.optString("address")) }, size = 36.dp)
        }
        ErrText(a.err)
    }
    PCard {
        if (acc.optString("kind") != "watch") {
            PButton("Show private key", {
                m.launch {
                    key = m.io {
                        if (!AppLock.confirm(m.act, "Show private key")) null
                        else if (!m.confirm("Show private key?", "Anyone who sees this key can take the funds of this account. Make sure nobody is watching your screen.", "Show")) null
                        else { val k = m.api.vault.privateKey(i); try { Hex.encode(k) } finally { k.fill(0) } }
                    }
                }
            }, kind = Kind.Ghost, icon = "key")
            if (key != null) {
                Spacer(Modifier.height(10.dp))
                NoteBox("Private key, never share it:", danger = true) {
                    SelectionContainer { Text(key!!, fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = p.dangerText, modifier = Modifier.padding(top = 6.dp)) }
                }
            }
            Spacer(Modifier.height(10.dp))
        }
        PButton("Remove account", {
            m.launch {
                val done = m.io {
                    val k = acc.optString("kind")
                    if (!m.confirm("Remove ${acc.optString("name")}?", if (k == "imported") "The private key of this account is deleted from this phone. Back it up first." else "The account is hidden; you can add it again from the recovery phrase.", "Remove")) false
                    else { m.api.vault.removeAccount(i); true }
                }
                if (done) { m.assets = null; m.tab("wallet") }
            }
        }, kind = Kind.Danger, icon = "trash", enabled = s.accounts.size > 1)
    }
}

@Composable
fun SendScreen(m: Model, s: Snap, token0: String) {
    val p = LocalPsy.current
    var token by remember { mutableStateOf(token0) }
    var to by remember { mutableStateOf("") }
    var amount by remember { mutableStateOf("") }
    var note by remember { mutableStateOf<String?>(null) }
    var open by remember { mutableStateOf(false) }
    val a = rememberAction()
    LaunchedEffect(Unit) { if (m.assets == null) m.loadAssets() }
    val toks = listOf(JSONObject().put("address", "").put("symbol", s.symbol).put("logo", if (s.chainId == WalletData.PSYROB_CHAIN) "psy" else "")) + s.tokens
    val cur = toks.firstOrNull { it.optString("address") == token } ?: toks[0]
    val bal = m.assets?.optJSONArray("assets")?.objects()?.firstOrNull { (if (it.optBoolean("native")) "" else it.optString("address")) == token }
    PageHead("Send") { m.back() }
    PCard {
        Text("Asset", color = p.muted, fontSize = 13.sp, modifier = Modifier.padding(bottom = 6.dp))
        Box {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.input).border(1.dp, p.line, RoundedCornerShape(12.dp)).clickable { open = true }.padding(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Coin(cur, 30.dp); Spacer(Modifier.width(10.dp))
                Text(cur.optString("symbol") + if (cur.optString("address").isNotEmpty()) "  " + short(cur.optString("address")) else "", color = p.text, modifier = Modifier.weight(1f))
                PIcon("chevron-down", tint = p.muted, size = 18.dp)
            }
            DropdownMenu(open, { open = false }) {
                toks.forEach { t ->
                    DropdownMenuItem(
                        text = { Text(t.optString("symbol") + if (t.optString("address").isNotEmpty()) "  " + short(t.optString("address")) else "") },
                        leadingIcon = { Coin(t, 26.dp) }, onClick = { token = t.optString("address"); open = false; note = null },
                    )
                }
            }
        }
        if (bal != null) Muted("Available: " + fmtAmt(bal.bal()) + " " + bal.optString("symbol"), Modifier.padding(top = 6.dp))
        Field(to, { to = it.trim() }, label = "To", placeholder = "0x… address", mono = true, trailing = { PasteBtn(m) { to = it } })
        if (s.accounts.size > 1) Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Muted("My accounts:", size = 12)
            s.accounts.filterIndexed { i, _ -> i != s.selected }.take(4).forEach { acc -> LinkBtn(acc.optString("name"), { to = acc.optString("address") }) }
        }
        Field(amount, { amount = it.trim() }, label = "Amount", placeholder = "0.0", keyboard = KeyboardType.Decimal, trailing = {
            LinkBtn("Max", {
                val b = bal?.bal()?.toBigDecimalOrNull() ?: return@LinkBtn
                if (bal.optBoolean("native")) {
                    val v = b.subtract(java.math.BigDecimal("0.01")).max(java.math.BigDecimal.ZERO).setScale(6, java.math.RoundingMode.DOWN).stripTrailingZeros()
                    amount = v.toPlainString(); note = "Kept 0.01 ${bal.optString("symbol")} for the network fee."
                } else amount = b.toPlainString()
            })
        })
        if (note != null) Muted(note!!, Modifier.padding(top = 6.dp), size = 12)
        ErrText(a.err)
        Spacer(Modifier.height(12.dp))
        PButton("Review", {
            a.run {
                val hash = m.io {
                    val pend = m.api.prepareSend(JSONObject().put("to", to).put("amount", amount).put("token", token))
                    TxConfirm.run(m.act, m.api, pend, "Send " + pend.amountText)
                }
                if (hash != null) { m.assets = null; m.tab("wallet") }
            }
        }, busy = a.busy, busyText = "Checking", icon = "send")
        Muted("You will see the fee, a simulation and a risk check before anything is signed.", Modifier.padding(top = 10.dp), size = 12)
    }
}

/** QR code drawn natively from the zxing matrix, on a white tile so every scanner reads it in both themes. */
@Composable
fun QrCode(text: String, modifier: Modifier = Modifier) {
    val matrix = remember(text) { try { Encoder.encode(text, ErrorCorrectionLevel.M).matrix } catch (_: Exception) { null } }
    Box(modifier.clip(RoundedCornerShape(16.dp)).background(Color.White).padding(14.dp)) {
        if (matrix != null) Canvas(Modifier.fillMaxWidth().aspectRatio(1f)) {
            val n = matrix.width
            val cell = size.width / n
            for (y in 0 until matrix.height) for (x in 0 until n) if (matrix.get(x, y).toInt() == 1)
                drawRect(Color(0xFF071014), Offset(x * cell, y * cell), Size(cell + 0.5f, cell + 0.5f))
        }
    }
}

@Composable
fun ReceiveScreen(m: Model, s: Snap) {
    val p = LocalPsy.current
    PageHead("Receive") { m.back() }
    PCard {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(s.address); Spacer(Modifier.width(10.dp))
                Column { Text(s.account.optString("name"), fontWeight = FontWeight.SemiBold, color = p.text); Muted(s.netName, size = 12) }
            }
            Spacer(Modifier.height(14.dp))
            QrCode(s.shown ?: "", Modifier.widthIn(max = 260.dp).fillMaxWidth())
            Spacer(Modifier.height(12.dp))
            SelectionContainer { Text(splitAddr(s.shown ?: ""), fontFamily = FontFamily.Monospace, fontSize = 14.sp, color = p.text, textAlign = TextAlign.Center) }
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                IconBtn("copy", "Copy address", { m.copy(s.shown) }, size = 52.dp)
                IconBtn("share", "Share address", { m.share(s.shown ?: "") }, size = 52.dp)
            }
            Muted("Send only ${s.symbol} and tokens on ${s.netName} (chain ${s.chainId}) to this address.", Modifier.padding(top = 8.dp), size = 12)
        }
    }
}

@Composable
fun AddTokenScreen(m: Model, s: Snap) {
    var addr by remember { mutableStateOf("") }
    val a = rememberAction()
    PageHead("Add token") { m.back() }
    PCard {
        Text("Token contract on ${s.netName}", color = LocalPsy.current.muted, fontSize = 13.sp)
        Field(addr, { addr = it.trim() }, Modifier.fillMaxWidth().padding(top = 6.dp), placeholder = "0x…", mono = true, trailing = { PasteBtn(m) { addr = it } })
        ErrText(a.err)
        Spacer(Modifier.height(12.dp))
        PButton("Add", { a.run { m.io { val t = m.api.tokenInfo(s.chainId, addr); m.api.data.addToken(s.chainId, t) }; m.assets = null; m.tab("wallet") } }, busy = a.busy, busyText = "Reading contract", icon = "plus")
    }
    if (s.tokens.isNotEmpty()) {
        Section("Your tokens")
        PCard(padding = LIST_PAD) {
            s.tokens.forEachIndexed { i, t ->
                if (i > 0) Divider()
                Item(t.optString("symbol"), t.optString("address"), subMono = true, lead = { Coin(t) }, trailing = {
                    LinkBtn("Hide", { m.launch { m.io { m.api.data.removeToken(s.chainId, t.optString("address")) }; m.assets = null; m.changed() } })
                })
            }
        }
    }
}

@Composable
fun NetworksScreen(m: Model, s: Snap) {
    val p = LocalPsy.current
    var name by remember { mutableStateOf("") }
    var rpc by remember { mutableStateOf("") }
    var cid by remember { mutableStateOf("") }
    var sym by remember { mutableStateOf("") }
    var ex by remember { mutableStateOf("") }
    val a = rememberAction()
    PageHead("Networks") { m.back() }
    PCard(padding = LIST_PAD) {
        s.networks.forEachIndexed { i, n ->
            if (i > 0) Divider()
            val c = n.optLong("chainId")
            Item(
                n.optString("name"), "Chain $c · ${n.optString("symbol")} · ${n.optString("rpc")}",
                onClick = { m.launch { m.io { m.api.data.setActiveChain(c) }; m.assets = null; m.tab("wallet") } },
                lead = { Coin(if (c == WalletData.PSYROB_CHAIN) JSONObject().put("logo", "psy") else JSONObject().put("symbol", n.optString("symbol"))) },
                trailing = {
                    when {
                        c == s.chainId -> PIcon("check", tint = p.ok, size = 20.dp)
                        n.optBoolean("builtin") -> Badge("built in")
                        else -> LinkBtn("Remove", {
                            m.launch { if (m.io { m.confirm("Remove ${n.optString("name")}?", "The network and its tokens are removed from this wallet.", "Remove") }) { m.io { m.api.data.removeNetwork(c) }; m.changed() } }
                        }, color = p.bad)
                    }
                },
            )
        }
    }
    Section("Add a network")
    PCard {
        Field(name, { name = it }, label = "Name", placeholder = "My network")
        Field(rpc, { rpc = it.trim() }, label = "RPC address (https)", placeholder = "https://…", keyboard = KeyboardType.Uri)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(Modifier.weight(1f)) { Field(cid, { cid = it.filter(Char::isDigit) }, label = "Chain ID (optional)", placeholder = "from RPC", keyboard = KeyboardType.Number) }
            Column(Modifier.weight(1f)) { Field(sym, { sym = it.trim() }, label = "Symbol", placeholder = "ETH") }
        }
        Field(ex, { ex = it.trim() }, label = "Block explorer (optional)", placeholder = "https://…", keyboard = KeyboardType.Uri)
        ErrText(a.err)
        Spacer(Modifier.height(12.dp))
        PButton("Add network", {
            a.run {
                m.io {
                    if (!rpc.startsWith("https://")) throw Exception("The RPC address must start with https://")
                    val got = Hex.quantity(Rpc.call(rpc, "eth_chainId", JSONArray())).toLong()
                    if (cid.isNotEmpty() && cid.toLong() != got) throw Exception("The RPC address answers for chain $got, not $cid.")
                    m.api.data.addNetwork(JSONObject().put("name", name.trim().ifEmpty { "Custom network" }).put("rpc", rpc).put("symbol", sym.ifEmpty { "ETH" }).put("explorer", ex).put("chainId", got))
                    m.api.data.setActiveChain(got)
                }
                m.assets = null; m.tab("wallet")
            }
        }, busy = a.busy, busyText = "Checking RPC", icon = "network")
        Muted("dApps can also ask to add or switch networks; known networks switch automatically.", Modifier.padding(top = 10.dp), size = 12)
    }
}

@Composable
fun ApprovalsScreen(m: Model, s: Snap) {
    val p = LocalPsy.current
    var result by remember(s.address, s.chainId) { mutableStateOf<JSONObject?>(null) }
    var err by remember(s.address, s.chainId) { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf("Reading the chain…") }
    var revoking by remember { mutableStateOf(setOf<String>()) }
    LaunchedEffect(s.address, s.chainId) {
        try { result = m.io { m.api.approvals() } } catch (e: Exception) { err = e.message }
    }
    LaunchedEffect(result, err) { while (result == null && err == null) { m.api.scanStatus()?.let { status = it }; delay(700) } }
    PageHead("Token approvals") { m.back() }
    PCard {
        Muted("Contracts and addresses that may spend tokens of ${s.account.optString("name")} on ${s.netName}. Revoke what you no longer use.")
        Spacer(Modifier.height(10.dp))
        val r = result
        when {
            err != null -> ErrText(err)
            r == null -> Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = p.accent); Spacer(Modifier.width(10.dp)); Muted(status)
            }
            else -> {
                val list = r.optJSONArray("approvals")?.objects() ?: emptyList()
                if (list.isEmpty()) Muted("No active approvals.", size = 14)
                list.forEachIndexed { i, x ->
                    if (i > 0) Divider()
                    val id = x.optString("token") + x.optString("spender")
                    Row(Modifier.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text((x.optString("symbol").ifEmpty { short(x.optString("token")) }) + " · " + x.optString("amount"), fontWeight = FontWeight.SemiBold, color = p.text)
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Muted("Spender " + short(x.optString("spender")), size = 12)
                                if (x.has("spenderIsContract") && !x.optBoolean("spenderIsContract")) { Spacer(Modifier.width(6.dp)); Tag("EOA – risky") }
                            }
                            Muted("Token " + short(x.optString("token")), size = 12)
                            if (x.has("error")) ErrText(x.optString("error"))
                        }
                        if (id in revoking) Badge("revoking", "pending")
                        else if (!s.watchOnly) PButton("Revoke", {
                            m.launch {
                                val h = m.io {
                                    val pend = m.api.prepareRevoke(x.optString("token"), x.optString("spender"), x.optString("kind") == "all")
                                    TxConfirm.run(m.act, m.api, pend, "Revoke approval")
                                }
                                if (h != null) revoking = revoking + id
                            }
                        }, Modifier, kind = Kind.Danger, height = 40.dp)
                    }
                }
                Muted("Checked up to block ${fmtInt(r.optLong("head"))}.", Modifier.padding(top = 8.dp), size = 12)
            }
        }
    }
}
