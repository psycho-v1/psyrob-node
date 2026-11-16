package com.psyrob.suite.app

import android.os.Bundle
import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView

/** The dApp browser screen in Compose: address bar, network chip, menu, and the page. The wallet side is in BrowserCore. */
class BrowserActivity : BrowserCore() {
    private var url by mutableStateOf("")
    private var loadPct by mutableIntStateOf(100)
    private var walletTick by mutableIntStateOf(0)
    override val secure: Boolean = false

    override fun onPage(u: String, title: String?) { runOnUiThread { url = u } }
    override fun onProgress(p: Int) { runOnUiThread { loadPct = p } }
    override fun onWalletChanged() { runOnUiThread { walletTick++ } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dark = Theme.isDark(this)
        bars(dark)
        setContent { PsyTheme(dark) { Screen(); HostDialogs(this) } }
    }

    @Composable
    private fun Screen() {
        val p = LocalPsy.current
        val focus = LocalFocusManager.current
        val kb = LocalSoftwareKeyboardController.current
        var field by remember { mutableStateOf(TextFieldValue(startUrl() ?: "")) }
        var editing by remember { mutableStateOf(startUrl() == null) }
        var menu by remember { mutableStateOf(false) }
        if (!editing && field.text != url) field = TextFieldValue(url)
        BackHandler(true) { val w = web; if (w != null && w.canGoBack()) w.goBack() else finish() }
        @Suppress("UNUSED_VARIABLE") val t = walletTick
        val net = api.data.active()

        Column(Modifier.fillMaxSize().background(p.bg).windowInsetsPadding(WindowInsets.safeDrawing)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                IconBtn("close", "Close", { finish() })
                BasicTextField(
                    field, { field = it }, singleLine = true,
                    textStyle = TextStyle(color = p.text, fontSize = 14.sp), cursorBrush = SolidColor(p.accent),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onGo = { go(field.text); editing = false; kb?.hide(); focus.clearFocus() }),
                    decorationBox = { inner ->
                        Box(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp)) {
                            if (field.text.isEmpty()) Text("Search or enter a dApp address", color = p.hint, fontSize = 14.sp)
                            inner()
                        }
                    },
                    modifier = Modifier.weight(1f).padding(horizontal = 4.dp).clip(RoundedCornerShape(12.dp)).background(p.panel)
                        .border(1.dp, p.line, RoundedCornerShape(12.dp))
                        .onFocusChanged { f -> if (f.isFocused && !editing) { editing = true; field = field.copy(selection = TextRange(0, field.text.length)) } else if (!f.isFocused) editing = false },
                )
                Text(net.optString("name"), color = p.accent, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 96.dp).clip(RoundedCornerShape(16.dp)).clickable { menu = true }.padding(horizontal = 8.dp, vertical = 8.dp))
                Box {
                    IconBtn("dots", "Menu", { menu = true })
                    BrowserMenu(menu) { menu = false }
                }
            }
            if (loadPct < 100) LinearProgressIndicator({ loadPct / 100f }, Modifier.fillMaxWidth().height(2.dp), color = p.accent, trackColor = p.line)
            else Spacer(Modifier.height(2.dp))
            AndroidView(
                factory = { createWeb().also { (it.parent as? ViewGroup)?.removeView(it) } },
                modifier = Modifier.fillMaxWidth().weight(1f),
            )
        }
    }

    @Composable
    private fun BrowserMenu(open: Boolean, close: () -> Unit) {
        val p = LocalPsy.current
        @Suppress("UNUSED_VARIABLE") val t = walletTick
        DropdownMenu(open, close) {
            DropdownMenuItem({ Text("Reload") }, { web?.reload(); close() }, leadingIcon = { PIcon("refresh", size = 20.dp) })
            DropdownMenuItem({ Text("Bookmark this page") }, { bookmark(); close() }, leadingIcon = { PIcon("bookmark", size = 20.dp) })
            DropdownMenuItem({ Text("Disconnect this site") }, { disconnectSite(); close() }, leadingIcon = { PIcon("link", size = 20.dp) })
            DropdownMenuItem({ Text("Open in other browser") }, { openOutside(); close() }, leadingIcon = { PIcon("external", size = 20.dp) })
            HorizontalDivider(color = p.line)
            Text("Network", color = p.muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
            val active = api.data.activeChain()
            api.data.networks().objects().forEach { n ->
                val c = n.optLong("chainId")
                DropdownMenuItem({ Text(n.optString("name")) }, { switchNetwork(c); close() },
                    leadingIcon = { if (c == active) PIcon("check", tint = p.ok, size = 18.dp) else Spacer(Modifier.width(18.dp)) })
            }
            HorizontalDivider(color = p.line)
            Text("Account", color = p.muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
            val sel = api.vault.selected()
            api.vault.accounts().objects().forEachIndexed { i, a ->
                DropdownMenuItem({ Text(a.optString("name") + "  " + short(a.optString("address"))) }, { switchAccount(i); close() },
                    leadingIcon = { if (i == sel) PIcon("check", tint = p.ok, size = 18.dp) else Spacer(Modifier.width(18.dp)) })
            }
        }
    }
}
