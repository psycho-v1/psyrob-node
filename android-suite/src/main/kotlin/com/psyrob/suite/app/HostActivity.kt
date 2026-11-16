package com.psyrob.suite.app

import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.SecureFlagPolicy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Base of both screens: app lock bookkeeping, edge-to-edge bars, and the wallet's own confirmation and password
 * sheets. Background threads call approve / confirmPassword (Approval.Host) and wait; the sheets are drawn by
 * HostDialogs() in their own secure windows (no screenshots, drawn above any web page).
 */
abstract class HostActivity : ComponentActivity(), Approval.Host {
    class Ask<T>(val value: T) {
        private val latch = CountDownLatch(1)
        @Volatile var result = false
            private set
        fun done(r: Boolean) { if (latch.count > 0) { result = r; latch.countDown() } }
        fun await(host: HostActivity): Boolean {
            while (!latch.await(250, TimeUnit.MILLISECONDS)) if (host.isDestroyed) return false
            return result
        }
    }

    var approval by mutableStateOf<Ask<Approval.Request>?>(null)
    var password by mutableStateOf<Ask<String>?>(null)
    private val askLock = Any()

    /** No screenshots or screen recording of this screen. */
    protected open val secure: Boolean = true

    /** Debug builds allow screenshots (adb screencap) for testing; release builds never do. */
    val debuggable: Boolean get() = (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (secure && !debuggable) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    override fun onStart() { super.onStart(); AppLock.onStart(this) }
    override fun onStop() { AppLock.onStop(); super.onStop() }
    override fun onDestroy() { approval?.done(false); password?.done(false); super.onDestroy() }

    fun bars(dark: Boolean) {
        val c = PsyColors(dark).bg.toArgb()
        enableEdgeToEdge(
            if (dark) SystemBarStyle.dark(c) else SystemBarStyle.light(c, c),
            if (dark) SystemBarStyle.dark(c) else SystemBarStyle.light(c, c),
        )
    }

    override fun approve(r: Approval.Request): Boolean = synchronized(askLock) {
        val a = Ask(r)
        runOnUiThread { approval = a }
        val ok = a.await(this)
        runOnUiThread { if (approval === a) approval = null }
        ok
    }

    override fun confirmPassword(title: String): Boolean = synchronized(askLock) {
        val a = Ask(title)
        runOnUiThread { password = a }
        val ok = a.await(this)
        runOnUiThread { if (password === a) password = null }
        ok
    }

    fun toast(s: String) = runOnUiThread { Toast.makeText(this, s, Toast.LENGTH_SHORT).show() }
}

@Composable
fun HostDialogs(host: HostActivity) {
    host.approval?.let { ApprovalSheet(host, it) }
    host.password?.let { PasswordSheet(host, it) }
}

@Composable
private fun ApprovalSheet(host: HostActivity, ask: HostActivity.Ask<Approval.Request>) {
    val r = ask.value
    val p = LocalPsy.current
    var ack by remember(ask) { mutableStateOf(false) }
    Dialog(
        onDismissRequest = { ask.done(false) },
        properties = DialogProperties(usePlatformDefaultWidth = false, securePolicy = if (host.debuggable) SecureFlagPolicy.SecureOff else SecureFlagPolicy.SecureOn, dismissOnClickOutside = false, decorFitsSystemWindows = false),
    ) {
        Column(Modifier.fillMaxSize().background(p.bg).windowInsetsPadding(WindowInsets.safeDrawing).padding(18.dp)) {
            Text(r.title, fontSize = 21.sp, fontWeight = FontWeight.Bold, color = p.text)
            if (r.origin != null) Text(r.origin, fontSize = 14.sp, color = p.accent, modifier = Modifier.padding(top = 4.dp, bottom = 6.dp))
            Spacer(Modifier.height(8.dp))
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                val rows = r.rows.filter { it.size > 1 && it[1] != null }
                if (rows.isNotEmpty()) Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(p.panel).border(1.dp, p.line, RoundedCornerShape(14.dp))
                        .padding(horizontal = 14.dp, vertical = 6.dp),
                ) {
                    rows.forEachIndexed { i, row ->
                        if (i > 0) Divider()
                        Column(Modifier.padding(vertical = 8.dp)) {
                            Text(row[0], fontSize = 12.sp, color = p.muted)
                            SelectionContainer {
                                Text(splitAddr(row[1]), fontSize = 15.sp, color = p.text, fontFamily = if (row[1].startsWith("0x")) FontFamily.Monospace else FontFamily.Default)
                            }
                        }
                    }
                }
                if (r.warning != null) {
                    Spacer(Modifier.height(12.dp))
                    NoteBox(r.warning, danger = r.danger)
                }
                if (r.detail != null) {
                    SelectionContainer {
                        Text(r.detail, fontSize = 12.sp, color = p.muted, fontFamily = FontFamily.Monospace,
                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.input).border(1.dp, p.line, RoundedCornerShape(10.dp)).padding(10.dp))
                    }
                }
                if (r.ackText != null) {
                    Row(Modifier.fillMaxWidth().padding(top = 12.dp).clickable { ack = !ack }, verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(ack, { ack = it }, colors = CheckboxDefaults.colors(checkedColor = p.bad, uncheckedColor = p.bad, checkmarkColor = Color.White))
                        Text(r.ackText, color = p.bad, fontSize = 14.sp)
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                PButton("Reject", { ask.done(false) }, Modifier.weight(1f), kind = Kind.Ghost, height = 52.dp)
                if (r.danger) {
                    androidx.compose.material3.Button(
                        { ask.done(true) }, Modifier.weight(1f).height(52.dp), enabled = r.ackText == null || ack, shape = RoundedCornerShape(14.dp),
                        colors = androidx.compose.material3.ButtonDefaults.buttonColors(containerColor = p.bad, contentColor = Color.White, disabledContainerColor = p.bad.copy(alpha = .35f), disabledContentColor = Color.White),
                    ) { Text(r.okLabel, fontWeight = FontWeight.Bold, fontSize = 16.sp, maxLines = 1) }
                } else PButton(r.okLabel, { ask.done(true) }, Modifier.weight(1f), enabled = r.ackText == null || ack, height = 52.dp)
            }
        }
    }
}

@Composable
private fun PasswordSheet(host: HostActivity, ask: HostActivity.Ask<String>) {
    val p = LocalPsy.current
    var pw by remember(ask) { mutableStateOf("") }
    var err by remember(ask) { mutableStateOf<String?>(null) }
    var busy by remember(ask) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    fun submit() {
        if (busy) return
        busy = true; err = null
        scope.launch {
            val msg = withContext(Dispatchers.IO) {
                try {
                    if (AppLock.check(host, pw)) null
                    else if (AppLock.waitMs(host) > 0) "Wrong password. Wait ${(AppLock.waitMs(host) + 999) / 1000} s." else "Wrong password."
                } catch (e: Exception) { e.message }
            }
            busy = false
            if (msg == null) ask.done(true) else { err = msg; pw = "" }
        }
    }
    Dialog(onDismissRequest = { ask.done(false) }, properties = DialogProperties(securePolicy = if (host.debuggable) SecureFlagPolicy.SecureOff else SecureFlagPolicy.SecureOn)) {
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(p.panel).border(1.dp, p.line, RoundedCornerShape(18.dp)).padding(20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                PIcon("lock", size = 22.dp); Spacer(Modifier.width(10.dp))
                Text(ask.value, fontSize = 19.sp, fontWeight = FontWeight.Bold, color = p.text)
            }
            Muted("Enter your app password.", Modifier.padding(top = 6.dp))
            Field(pw, { pw = it }, Modifier.fillMaxWidth().padding(top = 10.dp).focusRequester(focus), placeholder = "Password", password = true, onDone = { submit() })
            ErrText(if (busy) "Checking…" else err)
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                PButton("Cancel", { ask.done(false) }, Modifier.weight(1f), kind = Kind.Ghost, height = 48.dp)
                PButton("Confirm", { submit() }, Modifier.weight(1f), busy = busy, busyText = "Checking", height = 48.dp)
            }
        }
    }
    LaunchedEffect(ask) { try { focus.requestFocus() } catch (_: Exception) {} }
}
