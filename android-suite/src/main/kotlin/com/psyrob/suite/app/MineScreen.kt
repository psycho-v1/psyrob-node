package com.psyrob.suite.app

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

enum class MineState { Ready, Wait, On }

/**
 * The round PSY button: a glow that pulses while mining, a dashed outer ring that turns (slowly while mining,
 * faster in amber while waiting for the node), and the PSY logo breathing in the middle.
 */
@Composable
fun MineButton(state: MineState, label: String, size: Dp, onClick: () -> Unit) {
    val p = LocalPsy.current
    // animations run only while mining or waiting, so the idle screen does not redraw
    var spin = 0f
    var wave = 0f
    if (state != MineState.Ready) {
        val inf = rememberInfiniteTransition(label = "mine")
        val sp by inf.animateFloat(0f, 360f, infiniteRepeatable(tween(if (state == MineState.On) 14_000 else 3_000, easing = LinearEasing)), label = "spin")
        val wv by inf.animateFloat(0f, 1f, infiniteRepeatable(tween(1_200), RepeatMode.Reverse), label = "pulse")
        spin = sp; wave = wv
    }
    val press = remember { MutableInteractionSource() }
    val pressed by press.collectIsPressedAsState()
    val pressScale by animateFloatAsState(if (pressed) .94f else 1f, label = "press")
    val edge by animateColorAsState(when (state) { MineState.On, MineState.Ready -> p.ringOn; MineState.Wait -> p.warn }, label = "edge")
    val ring = when (state) { MineState.On -> p.ringOn; MineState.Wait -> p.warn; MineState.Ready -> p.ring }
    val glowA = if (state == MineState.On) (if (p.dark) .28f + .25f * wave else .18f + .2f * wave) else 0f
    val logoA by animateFloatAsState(when (state) { MineState.On -> 1f; MineState.Ready -> .95f; MineState.Wait -> .6f }, label = "logoA")
    val breathe = if (state == MineState.On) 1f + .06f * wave else 1f

    Box(
        Modifier.size(size + 24.dp).semantics { contentDescription = label }
            .clip(CircleShape).clickable(press, indication = null, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        // glow
        if (glowA > 0f) Box(Modifier.size(size + 22.dp).alpha(glowA).background(Brush.radialGradient(listOf(p.ringOn.copy(alpha = .9f), Color.Transparent)), CircleShape))
        // dashed outer ring
        Canvas(Modifier.size(size + 20.dp).rotate(spin)) {
            drawCircle(ring, style = Stroke(width = 1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 5.dp.toPx()))))
        }
        // the button disc
        Box(
            Modifier.size(size).scale(pressScale).clip(CircleShape)
                .background(if (p.dark) Brush.radialGradient(listOf(p.panel2, p.bg)) else Brush.radialGradient(listOf(Color.White, Color(0xFFEEF7F9)))),
            contentAlignment = Alignment.Center,
        ) {
            Canvas(Modifier.fillMaxSize()) { drawCircle(edge, style = Stroke(width = 1.5.dp.toPx())) }
            Canvas(Modifier.size(size - 24.dp)) { drawCircle(if (state == MineState.On) p.ringOn.copy(alpha = .35f) else p.line, style = Stroke(width = 1.dp.toPx())) }
            Image(painterResource(p.psyLogo), null, Modifier.size(size * 0.42f).scale(breathe).alpha(logoA))
        }
    }
}

@Composable
fun MineScreen(m: Model, s: Snap) {
    val p = LocalPsy.current
    @Suppress("UNUSED_VARIABLE") val c = m.clock
    val mm: JSONObject? = MinerService.engine()?.snapshot()
    val mining = mm?.optBoolean("running") == true
    val net = m.netStats ?: JSONObject()
    val diff: Double? = mm?.optDouble("expectedAttempts")?.takeIf { !it.isNaN() && it > 0 } ?: net.optString("difficulty").toDoubleOrNull()
    val hr = if (mining) mm!!.optDouble("hashrate", 0.0) else 0.0
    val paused = MinerService.pausedReason()
    val active = MinerService.active()
    val state = if (mining && mm!!.optString("status") == "Mining") MineState.On else if (active) MineState.Wait else MineState.Ready
    val status = when {
        paused != null -> paused
        mining -> if (mm!!.optString("status") == "Mining") "Mining PSY on ${mm.optInt("threads")} thread${if (mm.optInt("threads") > 1) "s" else ""}" else mm.optString("status")
        else -> "Not mining"
    }
    val statusColor = when { paused != null -> p.warn; mining && mm!!.optString("status") == "Mining" -> p.ok; mining -> p.warn; else -> p.muted }
    val label = if (active) "Tap to stop mining" else "Tap to start mining"

    PCard {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            MineButton(state, label, 200.dp) {
                if (MinerService.active()) { MinerService.stop(m.act); m.clock++ }
                else when {
                    !s.hasWallet -> m.act.toast("Create or import a wallet first.")
                    s.watchOnly -> m.act.toast("The selected account is watch-only. Mining needs an account with its key on this phone.")
                    else -> { m.act.askNotifications(); MinerService.start(m.act); m.clock++ }
                }
            }
            Text(label, color = p.muted, fontSize = 13.sp, modifier = Modifier.padding(top = 4.dp))
            Row(verticalAlignment = Alignment.Bottom, modifier = Modifier.padding(top = 8.dp)) {
                Text(fmtRate(hr), fontSize = 38.sp, fontWeight = FontWeight.Bold, color = p.text)
                Text(" H/s", fontSize = 16.sp, color = p.muted, modifier = Modifier.padding(bottom = 7.dp))
            }
            Text(status, color = statusColor, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
            Muted("Rewards go to ${s.account.optString("name")} · ${short(s.address)}", Modifier.padding(top = 6.dp), size = 12)
        }
    }

    PCard {
        CardTitle("This phone")
        val cells = listOf(
            "Attempts" to fmtInt(mm?.optLong("attempts") ?: 0L), "Uptime" to fmtUp(mm?.optLong("uptimeSec") ?: 0L),
            "Blocks found" to fmtInt(mm?.optLong("found") ?: 0L), "Accepted" to fmtInt(mm?.optLong("accepted") ?: 0L),
            "Threads" to (mm?.optInt("threads") ?: m.settings.threads()).toString(), "Rejected" to fmtInt(mm?.optLong("rejected") ?: 0L),
        )
        cells.chunked(2).forEach { row ->
            Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { (k, v) ->
                    Column(Modifier.weight(1f).clip(RoundedCornerShape(12.dp)).background(p.panel2).padding(10.dp)) {
                        Muted(k, size = 12); Text(v, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = p.text)
                    }
                }
            }
        }
    }

    PCard {
        CardTitle("PSYROB Network")
        val height = mm?.optLong("chainHeight", -1)?.takeIf { it >= 0 } ?: net.optLong("chainHeight", -1)
        val nr = if (net.has("attemptsPerSecond")) net.optDouble("attemptsPerSecond") else Double.NaN
        Kv("Chain height", fmtInt(height))
        Kv("Network rate", if (nr.isNaN()) "–" else fmtInt(nr) + " H/s")
        Kv("Difficulty", if (diff != null) fmtInt(diff) + " attempts" else "–")
        Kv("Your share", if (hr > 0 && !nr.isNaN() && nr > 0) String.format(java.util.Locale.US, "%.2f %%", 100 * hr / (nr + hr)) else "–")
        Kv("Expected time per block", if (hr > 0 && diff != null) fmtDur(diff / hr) else "–")
        Kv("Node", mm?.optString("node") ?: m.settings.nodes().split(Regex("[\\s,]+")).first())
    }

    PCard {
        CardTitle("Your blocks")
        val blocks = mm?.optJSONArray("blocks")?.objects() ?: emptyList()
        if (blocks.isEmpty()) Muted("No blocks yet. Finding one takes luck: see the expected time per block above.")
        val tf = remember { DateFormat.getTimeInstance(DateFormat.MEDIUM) }
        blocks.take(20).forEachIndexed { i, b ->
            if (i > 0) Divider()
            val h = b.optString("hash")
            Item(
                if (h.isNotEmpty()) h.take(18) + "…" else "blue score " + b.optString("blueScore"),
                tf.format(Date(b.optLong("at"))) + (b.optString("reason").takeIf { it.isNotEmpty() }?.let { " · $it" } ?: ""),
                onClick = if (h.isNotEmpty()) ({ m.open(Settings.EXPLORER + "/block/" + h) }) else null,
                trailing = { Badge(b.optString("status"), b.optString("status")) },
            )
        }
    }

    PCard {
        CardTitle("Log")
        val log = mm?.optJSONArray("log")
        val text = if (log != null && log.length() > 0) (0 until log.length()).joinToString("\n") { log.optString(it) }
        else "Tap the PSY button to start. The log shows templates, found blocks and node messages."
        Text(text, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = p.logText, lineHeight = 15.sp,
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.input).padding(10.dp))
    }
}

