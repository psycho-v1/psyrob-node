package com.psyrob.suite.app

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.psyrob.suite.R
import org.json.JSONObject
import java.math.BigDecimal
import java.util.Locale

/** Dark and Day colours. The same tokens the earlier screens used, so the app keeps its look. */
class PsyColors(val dark: Boolean) {
    private fun c(d: Long, l: Long) = Color(if (dark) d else l)
    val bg = c(0xFF071014, 0xFFF3F7F9)
    val panel = c(0xFF0D1B21, 0xFFFFFFFF)
    val panel2 = c(0xFF10232A, 0xFFEEF4F6)
    val line = c(0xFF1D3A44, 0xFFD3E1E6)
    val text = c(0xFFE6FBFF, 0xFF0B1D24)
    val muted = c(0xFF9FBFC7, 0xFF587079)
    val accent = c(0xFF00F0FF, 0xFF0098A8)
    val accent2 = c(0xFF7FF8FF, 0xFF007A88)
    val ok = c(0xFF3EE08F, 0xFF12A05C)
    val warn = c(0xFFFFB648, 0xFFB26A00)
    val bad = c(0xFFFF6B6B, 0xFFD33A3A)
    val onAccent = c(0xFF071014, 0xFFFFFFFF)
    val input = c(0xFF050C0F, 0xFFFFFFFF)
    val nav = c(0xFF091519, 0xFFFFFFFF)
    val heroTop = c(0xFF0F3440, 0xFFD9F3F7)
    val warnBg = c(0xFF2A1D07, 0xFFFFF4E0)
    val warnLine = c(0xFF5C4210, 0xFFF0C987)
    val warnText = c(0xFFFFD9A0, 0xFF6B4300)
    val dangerBg = c(0xFF2A0F0F, 0xFFFDECEC)
    val dangerLine = c(0xFF6B2525, 0xFFF1B3B3)
    val dangerText = c(0xFFFFC9C9, 0xFF8A1F1F)
    val logText = c(0xFFB8D6DC, 0xFF2F4A52)
    val ring = c(0xFF1D3A44, 0xFFB9D4DA)
    val ringOn = c(0xFF00F0FF, 0xFF008C9C)
    val hint = c(0xFF6F8F97, 0xFF8AA0A8)
    val psyLogo = if (dark) R.drawable.psy_logo else R.drawable.psy_logo_day
    val mpsyLogo = if (dark) R.drawable.mpsy_coin else R.drawable.mpsy_coin_day
}

val LocalPsy = staticCompositionLocalOf { PsyColors(true) }

@Composable
fun PsyTheme(dark: Boolean, content: @Composable () -> Unit) {
    val p = remember(dark) { PsyColors(dark) }
    val scheme = if (dark) darkColorScheme(
        primary = p.accent, onPrimary = p.onAccent, background = p.bg, onBackground = p.text, surface = p.panel, onSurface = p.text,
        surfaceVariant = p.panel2, onSurfaceVariant = p.muted, outline = p.line, error = p.bad, secondary = p.accent2, surfaceContainer = p.panel,
        surfaceContainerHigh = p.panel, surfaceContainerHighest = p.panel2,
    ) else lightColorScheme(
        primary = p.accent, onPrimary = p.onAccent, background = p.bg, onBackground = p.text, surface = p.panel, onSurface = p.text,
        surfaceVariant = p.panel2, onSurfaceVariant = p.muted, outline = p.line, error = p.bad, secondary = p.accent2, surfaceContainer = p.panel,
        surfaceContainerHigh = p.panel, surfaceContainerHighest = p.panel2,
    )
    MaterialTheme(colorScheme = scheme) {
        CompositionLocalProvider(LocalPsy provides p, LocalContentColor provides p.text, content = content)
    }
}

// ---------- building blocks ----------

@Composable
fun PIcon(name: String, modifier: Modifier = Modifier, tint: Color = LocalPsy.current.accent, size: Dp = 22.dp) =
    Icon(PsyIcons[name], contentDescription = null, modifier = modifier.size(size), tint = tint)

/** A round icon button with a label for screen readers. */
@Composable
fun IconBtn(name: String, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, tint: Color = LocalPsy.current.accent, size: Dp = 40.dp, enabled: Boolean = true) {
    Box(
        modifier
            .size(size)
            .clip(CircleShape)
            .clickable(enabled = enabled, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { PIcon(name, tint = if (enabled) tint else tint.copy(alpha = .35f), size = size * 0.55f) }
}

@Composable
fun PCard(modifier: Modifier = Modifier, padding: PaddingValues = PaddingValues(16.dp), content: @Composable ColumnScope.() -> Unit) {
    val p = LocalPsy.current
    Column(
        modifier
            .fillMaxWidth()
            .padding(bottom = 12.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(p.panel)
            .border(1.dp, p.line, RoundedCornerShape(16.dp))
            .padding(padding),
        content = content,
    )
}

@Composable
fun CardTitle(t: String) = Text(t, fontSize = 16.sp, fontWeight = FontWeight.Bold, color = LocalPsy.current.text, modifier = Modifier.padding(bottom = 8.dp))

@Composable
fun Section(t: String) = Text(t.uppercase(), fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp, color = LocalPsy.current.muted,
    modifier = Modifier.padding(start = 4.dp, top = 6.dp, bottom = 8.dp))

@Composable
fun Muted(t: String, modifier: Modifier = Modifier, size: Int = 13) = Text(t, color = LocalPsy.current.muted, fontSize = size.sp, modifier = modifier, lineHeight = (size + 5).sp)

@Composable
fun ErrText(t: String?) { if (!t.isNullOrEmpty()) Text(t, color = LocalPsy.current.bad, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp)) }

enum class Kind { Primary, Ghost, Danger }

@Composable
fun PButton(
    text: String, onClick: () -> Unit, modifier: Modifier = Modifier.fillMaxWidth(), kind: Kind = Kind.Primary,
    icon: String? = null, busy: Boolean = false, busyText: String? = null, enabled: Boolean = true, height: Dp = 50.dp,
) {
    val p = LocalPsy.current
    val shape = RoundedCornerShape(14.dp)
    val inner: @Composable RowScope.() -> Unit = {
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = LocalContentColor.current)
            Spacer(Modifier.width(8.dp)); Text(busyText ?: "Working", fontWeight = FontWeight.Bold, fontSize = 15.sp)
        } else {
            if (icon != null) { PIcon(icon, tint = LocalContentColor.current, size = 20.dp); Spacer(Modifier.width(8.dp)) }
            Text(text, fontWeight = FontWeight.Bold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
    when (kind) {
        Kind.Primary -> Button(onClick, modifier.heightIn(min = height), enabled = enabled && !busy, shape = shape,
            colors = ButtonDefaults.buttonColors(containerColor = p.accent, contentColor = p.onAccent, disabledContainerColor = p.accent.copy(alpha = .35f), disabledContentColor = p.onAccent),
            content = inner)
        Kind.Ghost -> OutlinedButton(onClick, modifier.heightIn(min = height), enabled = enabled && !busy, shape = shape, border = BorderStroke(1.dp, p.line),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = p.accent, disabledContentColor = p.accent.copy(alpha = .35f)), content = inner)
        Kind.Danger -> OutlinedButton(onClick, modifier.heightIn(min = height), enabled = enabled && !busy, shape = shape, border = BorderStroke(1.dp, p.dangerLine),
            colors = ButtonDefaults.outlinedButtonColors(containerColor = p.dangerBg, contentColor = p.bad, disabledContentColor = p.bad.copy(alpha = .35f)), content = inner)
    }
}

@Composable
fun LinkBtn(text: String, onClick: () -> Unit, icon: String? = null, color: Color = LocalPsy.current.accent, enabled: Boolean = true) {
    TextButton(onClick, enabled = enabled, contentPadding = PaddingValues(horizontal = 4.dp, vertical = 2.dp)) {
        if (icon != null) { PIcon(icon, tint = color, size = 18.dp); Spacer(Modifier.width(6.dp)) }
        Text(text, color = if (enabled) color else color.copy(alpha = .4f), fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
    }
}

@Composable
fun Field(
    value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier.fillMaxWidth(), label: String? = null, placeholder: String? = null,
    password: Boolean = false, singleLine: Boolean = true, minLines: Int = 1, keyboard: KeyboardType = KeyboardType.Text, mono: Boolean = false,
    onDone: (() -> Unit)? = null, trailing: (@Composable () -> Unit)? = null,
) {
    val p = LocalPsy.current
    var shown by remember { mutableStateOf(false) }
    if (label != null) Text(label, color = p.muted, fontSize = 13.sp, modifier = Modifier.padding(top = 12.dp, bottom = 6.dp))
    OutlinedTextField(
        value = value, onValueChange = onChange, modifier = modifier, singleLine = singleLine, minLines = minLines,
        placeholder = placeholder?.let { { Text(it, color = p.hint, fontSize = 15.sp) } },
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = p.text, fontSize = 15.sp, fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default),
        visualTransformation = if (password && !shown) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            keyboardType = if (password) KeyboardType.Password else keyboard, autoCorrectEnabled = false,
            imeAction = if (onDone != null) ImeAction.Done else ImeAction.Default,
        ),
        keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
        trailingIcon = when {
            password -> ({ IconBtn(if (shown) "eye-off" else "eye", if (shown) "Hide password" else "Show password", { shown = !shown }) })
            trailing != null -> trailing
            else -> null
        },
        shape = RoundedCornerShape(12.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = p.input, unfocusedContainerColor = p.input, focusedBorderColor = p.accent, unfocusedBorderColor = p.line,
            cursorColor = p.accent, focusedTextColor = p.text, unfocusedTextColor = p.text,
        ),
    )
}

/** A list row: optional leading content, a title with a sub line, optional trailing content. */
@Composable
fun Item(
    title: String, sub: String? = null, onClick: (() -> Unit)? = null, lead: (@Composable () -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null, subMono: Boolean = false, titleContent: (@Composable () -> Unit)? = null,
) {
    val p = LocalPsy.current
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(vertical = 10.dp, horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (lead != null) { lead(); Spacer(Modifier.width(12.dp)) }
        Column(Modifier.weight(1f)) {
            if (titleContent != null) titleContent() else Text(title, color = p.text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (sub != null) Text(sub, color = p.muted, fontSize = 12.5.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, fontFamily = if (subMono) FontFamily.Monospace else FontFamily.Default)
        }
        if (trailing != null) { Spacer(Modifier.width(8.dp)); trailing() }
    }
}

@Composable
fun Divider() = Box(Modifier.fillMaxWidth().height(1.dp).background(LocalPsy.current.line.copy(alpha = .6f)))

@Composable
fun Badge(text: String, status: String = "") {
    val p = LocalPsy.current
    val c = when (status) { "ok", "accepted", "confirmed", "success" -> p.ok; "pending", "submitting", "revoking" -> p.warn; "failed", "rejected", "error" -> p.bad; else -> p.muted }
    Text(text, color = c, fontSize = 11.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier.border(1.dp, c.copy(alpha = .6f), RoundedCornerShape(20.dp)).padding(horizontal = 8.dp, vertical = 2.dp))
}

@Composable
fun Tag(text: String) {
    val p = LocalPsy.current
    Text(text, color = p.warn, fontSize = 10.sp, fontWeight = FontWeight.Bold,
        modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(p.warnBg).padding(horizontal = 6.dp, vertical = 1.dp))
}

@Composable
fun NoteBox(text: String, danger: Boolean = false, content: (@Composable ColumnScope.() -> Unit)? = null) {
    val p = LocalPsy.current
    Column(
        Modifier.fillMaxWidth().padding(bottom = 12.dp).clip(RoundedCornerShape(12.dp)).background(if (danger) p.dangerBg else p.warnBg)
            .border(1.dp, if (danger) p.dangerLine else p.warnLine, RoundedCornerShape(12.dp)).padding(12.dp),
    ) {
        Text(text, color = if (danger) p.dangerText else p.warnText, fontSize = 14.sp, lineHeight = 19.sp)
        content?.invoke(this)
    }
}

@Composable
fun Kv(k: String, v: String) {
    val p = LocalPsy.current
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(k, color = p.muted, fontSize = 14.sp)
        Spacer(Modifier.width(12.dp))
        Text(v, color = p.text, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun SwitchRow(title: String, sub: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    val p = LocalPsy.current
    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, color = p.text, fontSize = 15.sp)
            if (sub != null) Muted(sub, size = 12)
        }
        Switch(checked, onChange, colors = SwitchDefaults.colors(checkedThumbColor = p.onAccent, checkedTrackColor = p.accent, uncheckedTrackColor = p.input, uncheckedBorderColor = p.line, uncheckedThumbColor = p.muted))
    }
}

@Composable
fun PageHead(title: String, onBack: (() -> Unit)?) {
    Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        if (onBack != null) { IconBtn("chevron-left", "Back", onBack, size = 40.dp); Spacer(Modifier.width(4.dp)) }
        Text(title, fontSize = 20.sp, fontWeight = FontWeight.Bold, color = LocalPsy.current.text)
    }
}

/** A deterministic two-colour disc from the address, so accounts are easy to tell apart. */
@Composable
fun Avatar(address: String?, size: Dp = 40.dp) {
    val a = (address ?: "0x000000000").lowercase(Locale.ROOT)
    val h1 = (a.drop(2).take(3).toIntOrNull(16) ?: 0) % 360
    val h2 = (a.drop(5).take(3).toIntOrNull(16) ?: 0) % 360
    Box(Modifier.size(size).clip(CircleShape).background(Brush.linearGradient(listOf(Color.hsl(h1.toFloat(), .7f, .45f), Color.hsl(h2.toFloat(), .75f, .30f)))))
}

/** Token mark: the PSY and M-PSY logos, otherwise the first letters of the symbol. */
@Composable
fun Coin(t: JSONObject, size: Dp = 38.dp) {
    val p = LocalPsy.current
    when (t.optString("logo")) {
        "psy" -> Box(Modifier.size(size).clip(CircleShape).background(if (p.dark) p.input else Color.White).border(1.dp, if (p.dark) p.line else Color(0xFF008C9C), CircleShape), contentAlignment = Alignment.Center) {
            Image(painterResource(p.psyLogo), "PSY", Modifier.size(size * 0.72f))
        }
        "mpsy" -> Image(painterResource(p.mpsyLogo), "M-PSY", Modifier.size(size).clip(CircleShape))
        else -> Box(Modifier.size(size).clip(CircleShape).background(p.panel2).border(1.dp, p.line, CircleShape), contentAlignment = Alignment.Center) {
            Text(t.optString("symbol", "?").take(3), color = p.accent, fontWeight = FontWeight.Bold, fontSize = 12.sp)
        }
    }
}

// ---------- formatting ----------

fun short(a: String?): String = if (a == null || a.length < 12) a ?: "–" else a.take(6) + "…" + a.takeLast(4)

fun fmtInt(n: Double?): String = if (n == null || n.isNaN() || n < 0) "–" else String.format(Locale.US, "%,d", Math.round(n))
fun fmtInt(n: Long?): String = if (n == null || n < 0) "–" else String.format(Locale.US, "%,d", n)

fun fmtAmt(s: String?): String {
    if (s == null) return "…"
    val n = s.toBigDecimalOrNull() ?: return s
    if (n.signum() == 0) return "0"
    if (n < BigDecimal("0.000001")) return "<0.000001"
    val d = n.toDouble()
    return String.format(Locale.US, if (d >= 1000) "%,.2f" else "%,.6f", d).trimEnd('0').trimEnd('.')
}

fun fmtRate(h: Double): String = when { h >= 100 -> String.format(Locale.US, "%.0f", h); h >= 10 -> String.format(Locale.US, "%.1f", h); else -> String.format(Locale.US, "%.2f", h) }

fun fmtDur(s: Double): String = when {
    s.isNaN() || s.isInfinite() || s <= 0 -> "–"
    s < 90 -> "${Math.round(s)} s"
    s < 5400 -> "${Math.round(s / 60)} min"
    s < 172800 -> String.format(Locale.US, "%.1f h", s / 3600)
    else -> String.format(Locale.US, "%.1f days", s / 86400)
}

fun fmtUp(s: Long): String = String.format(Locale.US, "%d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60)

fun org.json.JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
