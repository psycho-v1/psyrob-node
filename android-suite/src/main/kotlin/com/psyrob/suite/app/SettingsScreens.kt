package com.psyrob.suite.app

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

private val LIST_PAD = PaddingValues(horizontal = 14.dp, vertical = 4.dp)
private val LOCK_TIMES = listOf(0 to "Immediately", 60 to "After 1 minute", 300 to "After 5 minutes", 900 to "After 15 minutes", 3600 to "After 1 hour")

@Composable
private fun NavRow(icon: String, title: String, sub: String, onClick: () -> Unit) {
    val p = LocalPsy.current
    Item(title, sub, onClick = onClick, lead = { PIcon(icon, size = 24.dp) }, trailing = { PIcon("chevron-right", tint = p.muted, size = 18.dp) })
}

@Composable
fun SettingsScreen(m: Model, s: Snap) {
    val p = LocalPsy.current
    PCard {
        CardTitle("Appearance")
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).border(1.dp, p.line, RoundedCornerShape(12.dp))) {
            for ((k, label, icon) in listOf(Triple("system", "System", "phone"), Triple("dark", "Dark", "moon"), Triple("light", "Day", "sun"))) {
                val on = m.theme == k
                Row(
                    Modifier.weight(1f).background(if (on) p.accent.copy(alpha = .14f) else p.input).clickable { Theme.setChoice(m.act, k); m.theme = k }.padding(vertical = 12.dp),
                    horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
                ) {
                    PIcon(icon, tint = if (on) p.accent else p.muted, size = 20.dp)
                    Spacer(Modifier.width(6.dp))
                    Text(label, color = if (on) p.accent else p.text, fontWeight = if (on) FontWeight.Bold else FontWeight.Normal, fontSize = 14.sp)
                }
            }
        }
    }

    PCard(padding = PaddingValues(start = 14.dp, end = 14.dp, top = 14.dp, bottom = 4.dp)) {
        CardTitle("Security")
        NavRow("lock", "App password", if (s.lockEnabled) "On · tap to change or remove" else "Off · tap to set one") { m.go("password") }
        if (s.lockEnabled) {
            Divider()
            var open by remember { mutableStateOf(false) }
            Item("Auto-lock", "When the app has been in the background", trailing = {
                Box {
                    LinkBtn(LOCK_TIMES.firstOrNull { it.first == s.lockTimeout }?.second ?: "${s.lockTimeout} s", { open = true })
                    DropdownMenu(open, { open = false }) {
                        LOCK_TIMES.forEach { (v, l) -> DropdownMenuItem(text = { Text(l) }, onClick = { AppLock.setTimeout(m.act, v); open = false; m.changed() }) }
                    }
                }
            })
            Divider()
            LinkBtn("Lock now", { AppLock.lockNow(); m.checkLock() }, icon = "lock")
        }
    }

    PCard(padding = PaddingValues(start = 14.dp, end = 14.dp, top = 14.dp, bottom = 4.dp)) {
        CardTitle("Wallet")
        NavRow("users", "Accounts", "${s.accounts.size} account(s), watch-only and imported keys") { m.go("accounts") }
        Divider()
        NavRow("network", "Networks", "${s.netName} · ${s.networks.size} network(s)") { m.go("networks") }
        Divider()
        NavRow("approve", "Token approvals", "Review and revoke spending rights") { m.go("approvals") }
        Divider()
        NavRow("phrase", "Recovery phrase", if (s.hasPhrase) "Show the 12 words (back up)" else "This wallet has no phrase (imported keys only)") { if (s.hasPhrase) revealPhrase(m) }
        Divider()
        NavRow("restore", "Restore another wallet", "Replace this wallet with a recovery phrase") { m.go("restore") }
    }

    MiningSettings(m)

    PCard {
        CardTitle("About")
        Kv("App", "PSYROB Suite Beta 1.0")
        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Coins", color = p.muted, fontSize = 14.sp, modifier = Modifier.weight(1f))
            Image(painterResource(p.psyLogo), null, Modifier.size(18.dp)); Text(" PSY  ·  ", fontSize = 14.sp, color = p.text)
            Image(painterResource(p.mpsyLogo), null, Modifier.size(18.dp)); Text(" M-PSY", fontSize = 14.sp, color = p.text)
        }
        Kv("Default network", "PSYROB Network, chain 87870")
        Kv("Device", "${m.settings.cores()} cores · ${fmtInt(m.settings.deviceMemoryMb())} MB")
        Row {
            LinkBtn("psyrob.com", { m.open("https://psyrob.com") })
            LinkBtn("Explorer", { m.open(Settings.EXPLORER) })
            LinkBtn("Source", { m.open("https://github.com/psycho-v1/psyrob-node") })
        }
    }

    PButton("Delete wallet from this phone", {
        m.launch {
            val done = m.io {
                if (!AppLock.confirm(m.act, "Delete wallet")) false
                else if (!m.confirm("Delete the wallet from this phone?", "All accounts, keys and the recovery phrase are deleted. Without your backup, the funds cannot be recovered.", "Delete")) false
                else { if (MinerService.active()) MinerService.stop(m.act); m.api.vault.wipe(); AppLock.clear(m.act); true }
            }
            if (done) { m.assets = null; m.reset("welcome") }
        }
    }, kind = Kind.Danger, icon = "trash")
}

@Composable
private fun MiningSettings(m: Model) {
    val p = LocalPsy.current
    val st = m.settings
    var threads by remember { mutableStateOf(st.threads().toFloat()) }
    var charging by remember { mutableStateOf(st.chargingOnly()) }
    var screen by remember { mutableStateOf(st.keepScreenOn()) }
    var resume by remember { mutableStateOf(st.autoResume()) }
    var nodes by remember { mutableStateOf(st.nodes().split(Regex("[\\s,]+")).joinToString("\n")) }
    var err by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(saved) { if (saved != null) { delay(2000); saved = null } }
    val max = st.maxThreads()
    PCard {
        CardTitle("Mining")
        Row(verticalAlignment = Alignment.CenterVertically) {
            Slider(threads, { threads = it }, Modifier.weight(1f), valueRange = 1f..max.coerceAtLeast(2).toFloat(), steps = (max - 2).coerceAtLeast(0), enabled = max > 1,
                colors = SliderDefaults.colors(thumbColor = p.accent, activeTrackColor = p.accent, inactiveTrackColor = p.line))
            Text(threads.toInt().toString(), fontSize = 20.sp, fontWeight = FontWeight.Bold, color = p.text, textAlign = TextAlign.End, modifier = Modifier.width(40.dp))
        }
        Muted("This phone has ${st.cores()} cores; up to $max threads fit in memory (32 MiB each). More threads mine faster but heat the phone.", size = 12)
        SwitchRow("Mine only while charging", "Pauses on battery, resumes on the charger.", charging) { charging = it }
        SwitchRow("Keep screen on", "While the app is open.", screen) { screen = it }
        SwitchRow("Resume after restart", null, resume) { resume = it }
        Field(nodes, { nodes = it }, label = "PSYROB RPC node(s), one per line", singleLine = false, minLines = 2, keyboard = KeyboardType.Uri)
        ErrText(err)
        Spacer(Modifier.height(12.dp))
        PButton(saved ?: "Save mining settings", {
            err = null
            try {
                val list = nodes.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
                list.firstOrNull { !it.startsWith("https://") }?.let { throw Exception("Node addresses must start with https:// ($it)") }
                st.save(list.joinToString(",").ifEmpty { Settings.DEFAULT_NODE }, threads.toInt(), charging, screen, resume)
                m.applyScreenOn()
                if (MinerService.active()) {
                    saved = "Saved, restarting the miner"
                    MinerService.stop(m.act)
                    m.launch { delay(1200); MinerService.start(m.act) }
                } else saved = "Saved"
            } catch (e: Exception) { err = e.message }
        }, icon = if (saved != null) "check" else null)
    }
}

@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
fun DappsScreen(m: Model, s: Snap) {
    val p = LocalPsy.current
    var url by remember { mutableStateOf("") }
    var sites by remember { mutableStateOf<List<String>?>(null) }
    LaunchedEffect(m.tick) { sites = try { m.io { m.api.data.sites().let { a -> (0 until a.length()).map { a.optString(it) } } } } catch (_: Exception) { emptyList() } }
    PCard {
        Field(url, { url = it }, placeholder = "Search or enter a dApp address", keyboard = KeyboardType.Uri, onDone = { m.browse(url) },
            trailing = { IconBtn("search", "Go", { m.browse(url) }) })
        Muted("Sites connect to PSYROB Suite like to any Web3 wallet. Every connection, transaction and signature is shown on the wallet's own sheet first.", Modifier.padding(top = 10.dp), size = 12)
    }
    Section("Favourites")
    PCard {
        if (s.bookmarks.isEmpty()) Muted("No favourites yet.")
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(10.dp), maxItemsInEachRow = 4) {
            s.bookmarks.forEachIndexed { i, b ->
                val title = b.optString("title").ifEmpty { b.optString("url") }
                Column(
                    Modifier.weight(1f).clip(RoundedCornerShape(12.dp)).combinedClickable(
                        onClick = { m.browse(b.optString("url")) },
                        onLongClick = {
                            m.launch {
                                if (m.io { m.confirm("Remove $title?", "The favourite is removed from the list.", "Remove") }) {
                                    val all = m.api.data.bookmarks(); all.remove(i); m.api.data.setBookmarks(all); m.changed()
                                }
                            }
                        },
                    ).padding(4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(Modifier.size(46.dp).clip(CircleShape).background(p.heroTop), contentAlignment = Alignment.Center) {
                        Text(title.removePrefix("https://").removePrefix("http://").take(1).uppercase(), color = p.accent, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    }
                    Text(title, fontSize = 11.sp, color = p.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                }
            }
        }
        Muted("Add favourites from the menu in the browser. Long-press to remove.", Modifier.padding(top = 10.dp), size = 12)
    }
    if (s.history.isNotEmpty()) {
        Section("Recent")
        PCard(padding = LIST_PAD) {
            s.history.take(10).forEachIndexed { i, h ->
                if (i > 0) Divider()
                Item(h.optString("title").ifEmpty { h.optString("url") }, h.optString("url"), onClick = { m.browse(h.optString("url")) })
            }
            Divider()
            LinkBtn("Clear history", { m.api.data.clearHistory(); m.changed() })
        }
    }
    Section("Connected sites")
    PCard(padding = LIST_PAD) {
        val list = sites
        when {
            list == null -> Muted("…", Modifier.padding(vertical = 10.dp))
            list.isEmpty() -> Muted("No site is connected.", Modifier.padding(vertical = 10.dp))
            else -> list.forEachIndexed { i, o ->
                if (i > 0) Divider()
                Item(o, trailing = { LinkBtn("Disconnect", { m.launch { m.io { m.api.data.disconnect(o) }; m.changed() } }, color = p.bad) })
            }
        }
    }
}
