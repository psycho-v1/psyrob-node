package com.psyrob.suite.app

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.psyrob.suite.core.Rpc
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.withContext
import org.json.JSONObject

data class Route(val page: String, val args: Map<String, Any?> = emptyMap())

/** What the screens draw, read once per change from the vault and the wallet data (all local and fast). */
class Snap(m: Model) {
    val v = m.api.vault
    val d = m.api.data
    val hasWallet = v.has()
    val accounts = v.accounts().objects()
    val selected = v.selected()
    val account: JSONObject = accounts.getOrNull(selected) ?: JSONObject()
    val address: String? = v.address()
    val watchOnly = hasWallet && v.watchOnly()
    val hasPhrase = v.hasPhrase()
    val backedUp = v.backedUp()
    val network: JSONObject = d.active()
    val chainId = d.activeChain()
    val networks = d.networks().objects()
    val tokens = d.tokens(chainId).objects()
    val bookmarks = d.bookmarks().objects()
    val history = d.history().objects()
    val activity = if (address != null) d.activity(chainId, address).objects() else emptyList()
    val lockEnabled = AppLock.enabled(m.act)
    val lockTimeout = AppLock.timeout(m.act)
    val netName: String = network.optString("name", "PSYROB Network")
    val symbol: String = network.optString("symbol", "PSY")
    val explorer: String = network.optString("explorer").ifEmpty { Settings.EXPLORER }
}

class Model(val act: MainActivity) {
    val api: WalletApi = WalletApi.get(act)
    val settings = Settings(act)
    var tick by mutableIntStateOf(0)
    var clock by mutableIntStateOf(0)
    var theme by mutableStateOf(Theme.choice(act))
    var tab by mutableStateOf("wallet")
    val stack = mutableStateListOf<Route>()
    var editing by mutableIntStateOf(-1)
    var assets by mutableStateOf<JSONObject?>(null)
    var netStats by mutableStateOf<JSONObject?>(null)
    var locked by mutableStateOf(AppLock.locked(act))
    val route: Route get() = stack.lastOrNull() ?: Route(tab)

    fun changed() { tick++ }
    fun go(page: String, args: Map<String, Any?> = emptyMap()) { editing = -1; stack.add(Route(page, args)) }
    fun tab(t: String) { editing = -1; stack.clear(); tab = t; tick++ }
    /** Starts over on one page with no history, for example after onboarding. */
    fun reset(page: String, args: Map<String, Any?> = emptyMap()) { editing = -1; stack.clear(); tab = "wallet"; if (page != "wallet") stack.add(Route(page, args)); tick++ }
    fun back(): Boolean {
        editing = -1
        if (stack.isNotEmpty()) { stack.removeAt(stack.lastIndex); return true }
        if (tab != "wallet" && api.vault.has()) { tab = "wallet"; return true }
        return false
    }
    fun checkLock() {
        val l = AppLock.locked(act)
        if (l != locked) { locked = l; editing = -1; stack.clear(); tab = "wallet"; if (!l) assets = null; tick++ }
    }

    /** Runs a job on the screen's scope; a failure is shown as a toast. */
    fun launch(block: suspend () -> Unit) {
        act.lifecycleScope.launch { try { block() } catch (e: Exception) { act.toast(e.message ?: e.toString()) } }
    }

    suspend fun <T> io(f: () -> T): T = withContext(Dispatchers.IO) {
        if (AppLock.locked(act)) throw Exception("PSYROB Suite is locked.")
        f()
    }
    /** Plain confirmation on the wallet's own sheet. Call inside io. */
    fun confirm(title: String, msg: String, ok: String, danger: Boolean = true) = Approval.ask(act, title, null, ArrayList(), msg, null, ok, danger)

    suspend fun loadAssets() {
        try { assets = io { api.assets() } } catch (_: Exception) { assets = null }
        tick++
    }

    fun fetchStats() {
        Thread { try { val j = JSONObject(Rpc.get(Settings.EXPLORER + "/api/mining")); act.runOnUiThread { netStats = j } } catch (_: Exception) {} }.start()
    }

    fun copy(text: String?) {
        if (text == null || AppLock.locked(act)) return
        (act.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("PSYROB Suite", text))
        if (Build.VERSION.SDK_INT < 33) act.toast("Copied")
    }
    fun paste(): String {
        if (AppLock.locked(act)) return ""
        val c = (act.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
        return if (c == null || c.itemCount == 0) "" else c.getItemAt(0).coerceToText(act)?.toString()?.trim() ?: ""
    }
    fun share(text: String) { act.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "Share address")) }
    fun open(url: String) { if (url.startsWith("https://")) try { act.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) {} }
    fun browse(url: String?) {
        if (AppLock.locked(act)) return
        val i = Intent(act, BrowserActivity::class.java)
        if (!url.isNullOrBlank()) i.putExtra(BrowserCore.EXTRA_URL, url.trim())
        act.startActivity(i)
    }

    /** After a wallet was created, restored or imported: offer the app password once. */
    fun afterOnboard() { assets = null; if (!AppLock.enabled(act)) reset("password", mapOf("first" to true)) else reset("wallet") }

    fun dark(): Boolean = when (theme) {
        "dark" -> true
        "light" -> false
        else -> (act.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) != Configuration.UI_MODE_NIGHT_NO
    }

    fun applyScreenOn() {
        if (settings.keepScreenOn()) act.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else act.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
}

/** PSYROB Suite's main screen: wallet, miner, dApps and settings, drawn natively with Jetpack Compose. */
class MainActivity : HostActivity() {
    lateinit var model: Model
    private var uiMode by mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val m = Model(this)
        model = m
        uiMode = resources.configuration.uiMode
        bars(m.dark())
        m.applyScreenOn()
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        if (m.settings.autoResume() && m.settings.wasMining() && m.api.vault.has() && !MinerService.active()) MinerService.start(this)
        m.fetchStats()
        setContent {
            @Suppress("UNUSED_EXPRESSION") uiMode
            val dark = m.dark()
            LaunchedEffect(dark) { bars(dark) }
            PsyTheme(dark) { App(m); HostDialogs(this) }
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) { super.onConfigurationChanged(newConfig); uiMode = newConfig.uiMode }
    override fun onStart() { super.onStart(); if (::model.isInitialized) model.checkLock() }
    override fun onResume() { super.onResume(); if (::model.isInitialized) model.changed() }
}

private val TABS = listOf(Triple("wallet", "Wallet", "wallet"), Triple("mine", "Mine", "mine"), Triple("browser", "dApps", "dapps"), Triple("settings", "Settings", "settings"))
private val START = setOf("welcome", "restore", "importFirst", "backup")

@Composable
fun App(m: Model) {
    val p = LocalPsy.current
    val s = remember(m.tick, m.locked) { Snap(m) }
    // 1 s clock: lock checks, the miner screen and the mining lamp
    LaunchedEffect(Unit) { while (true) { delay(1000); m.clock++; m.checkLock() } }
    var route = m.route
    if (!m.locked && !s.hasWallet && route.page !in START) route = Route("welcome")
    val shell = s.hasWallet && !m.locked
    BackHandler(true) { if (m.locked || !m.back()) m.act.moveTaskToBack(true) }

    Column(Modifier.fillMaxSize().background(p.bg).windowInsetsPadding(WindowInsets.safeDrawing)) {
        if (shell) TopBar(m, s)
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
            if (m.locked) LockScreen(m, s)
            else key(route) {
                Column(Modifier.widthIn(max = 640.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Page(m, s, route)
                    Spacer(Modifier.height(16.dp))
                }
            }
        }
        if (shell) NavigationBar(containerColor = p.nav, tonalElevation = 0.dp, modifier = Modifier.height(68.dp)) {
            for ((id, label, icon) in TABS) {
                val on = m.stack.isEmpty() && m.tab == id
                NavigationBarItem(
                    selected = on, onClick = { m.tab(id) }, icon = { PIcon(icon, tint = if (on) p.accent else p.muted, size = 24.dp) },
                    label = { Text(label, fontSize = 12.sp, color = if (on) p.accent else p.muted, fontWeight = if (on) FontWeight.Bold else FontWeight.Normal) },
                    colors = NavigationBarItemDefaults.colors(indicatorColor = p.accent.copy(alpha = .12f)),
                )
            }
        }
    }
}

@Composable
private fun Page(m: Model, s: Snap, r: Route) {
    when (r.page) {
        "welcome" -> WelcomeScreen(m)
        "restore" -> RestoreScreen(m, s)
        "importFirst", "importKey" -> ImportKeyScreen(m, s, first = r.page == "importFirst")
        "backup" -> BackupScreen(m, r.args["phrase"] as String? ?: "", r.args["first"] == true)
        "password" -> PasswordScreen(m, s, r.args["first"] == true)
        "accounts" -> AccountsScreen(m, s)
        "watch" -> WatchScreen(m)
        "editAccount" -> EditAccountScreen(m, s, r.args["i"] as Int? ?: s.selected)
        "send" -> SendScreen(m, s, r.args["token"] as String? ?: "")
        "receive" -> ReceiveScreen(m, s)
        "addToken" -> AddTokenScreen(m, s)
        "networks" -> NetworksScreen(m, s)
        "approvals" -> ApprovalsScreen(m, s)
        "mine" -> MineScreen(m, s)
        "browser" -> DappsScreen(m, s)
        "settings" -> SettingsScreen(m, s)
        else -> WalletScreen(m, s)
    }
}

@Composable
private fun TopBar(m: Model, s: Snap) {
    val p = LocalPsy.current
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Image(painterResource(p.psyLogo), null, Modifier.size(30.dp).clip(CircleShape).then(if (!p.dark) Modifier.background(Color.White) else Modifier))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text("PSYROB Suite", fontWeight = FontWeight.Bold, fontSize = 17.sp, color = p.text)
            Text("Beta 1.0", fontSize = 11.sp, color = p.muted)
        }
        Text(s.netName, color = p.accent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 140.dp).clip(RoundedCornerShape(20.dp)).border(1.dp, p.line, RoundedCornerShape(20.dp))
                .clickable { m.go("networks") }.padding(horizontal = 12.dp, vertical = 6.dp))
        Spacer(Modifier.width(10.dp))
        MiningLamp(m)
    }
}

/** Small light in the top bar: green and pulsing while mining, amber while waiting, dim when off. Tap opens Mine. */
@Composable
private fun MiningLamp(m: Model) {
    val p = LocalPsy.current
    @Suppress("UNUSED_VARIABLE") val c = m.clock
    val e = MinerService.engine()
    val snap = e?.snapshot()
    val mining = snap != null && snap.optBoolean("running") && snap.optString("status") == "Mining"
    val color = if (mining) p.ok else if (MinerService.active()) p.warn else p.line
    val pulse by rememberInfiniteTransition(label = "lamp").animateFloat(.45f, 1f, infiniteRepeatable(tween(900), RepeatMode.Reverse), label = "a")
    Box(Modifier.size(32.dp).clip(CircleShape).clickable { m.tab("mine") }, contentAlignment = Alignment.Center) {
        Box(Modifier.size(12.dp).alpha(if (mining) pulse else 1f).clip(CircleShape).background(color))
    }
}

