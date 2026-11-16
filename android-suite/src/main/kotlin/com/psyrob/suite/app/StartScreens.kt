package com.psyrob.suite.app

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** A button's background job: busy flag and error text for the screen. */
class Action(private val scope: CoroutineScope) {
    var busy by mutableStateOf(false)
    var err by mutableStateOf<String?>(null)
    fun run(block: suspend () -> Unit) {
        if (busy) return
        busy = true; err = null
        scope.launch {
            try { block() } catch (e: Exception) { err = e.message ?: e.toString() } finally { busy = false }
        }
    }
}

@Composable
fun rememberAction(): Action { val sc = rememberCoroutineScope(); return remember { Action(sc) } }

/** The PSY logo on its disc: dark disc at night, white disc by day. */
@Composable
fun HeroLogo(size: Dp = 120.dp) {
    val p = LocalPsy.current
    Box(
        Modifier.size(size).clip(CircleShape).background(if (p.dark) p.panel2 else Color.White).border(1.dp, p.line, CircleShape),
        contentAlignment = Alignment.Center,
    ) { Image(painterResource(p.psyLogo), "PSY", Modifier.size(size * 0.74f)) }
}

@Composable
fun WelcomeScreen(m: Model) {
    val a = rememberAction()
    PCard(Modifier.padding(top = 24.dp)) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            HeroLogo()
            Spacer(Modifier.height(14.dp))
            Text("Welcome to PSYROB Suite", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = LocalPsy.current.text, textAlign = TextAlign.Center)
            Spacer(Modifier.height(8.dp))
            Muted("A self-custody wallet for PSYROB Network and other EVM networks, a dApp browser, and a PSY miner. Your keys stay on this phone.", size = 14)
            Spacer(Modifier.height(16.dp))
            PButton("Create a new wallet", { a.run { val ph = m.io { m.api.vault.create() }; m.reset("backup", mapOf("phrase" to ph, "first" to true)) } }, busy = a.busy, busyText = "Creating", icon = "plus")
            Spacer(Modifier.height(10.dp))
            PButton("Restore with recovery phrase", { m.go("restore") }, kind = Kind.Ghost, icon = "restore")
            Spacer(Modifier.height(10.dp))
            PButton("Import a private key", { m.go("importFirst") }, kind = Kind.Ghost, icon = "key")
            ErrText(a.err)
        }
    }
}

@Composable
fun RestoreScreen(m: Model, s: Snap) {
    var phrase by remember { mutableStateOf("") }
    val a = rememberAction()
    PageHead("Restore from recovery phrase") { m.back() }
    PCard {
        Muted("Enter the 12 or 24 words of a wallet you already have. Account 1 (m/44'/60'/0'/0/0) is restored; add more accounts later.")
        Spacer(Modifier.height(10.dp))
        Field(phrase, { phrase = it }, singleLine = false, minLines = 4, placeholder = "word1 word2 word3 …")
        ErrText(a.err)
        Spacer(Modifier.height(12.dp))
        PButton("Restore", {
            val fresh = !s.hasWallet
            a.run {
                val ok = m.io {
                    if (m.api.vault.has() && !m.confirm("Replace this wallet?", "All accounts on this phone are replaced by the wallet of the recovery phrase. Back up the current phrase and keys first.", "Replace")) false
                    else { if (MinerService.active()) MinerService.stop(m.act); m.api.vault.restore(phrase); true }
                }
                if (ok) { if (fresh) m.afterOnboard() else { m.assets = null; m.tab("wallet") } }
            }
        }, busy = a.busy, busyText = "Restoring")
    }
}

@Composable
fun ImportKeyScreen(m: Model, s: Snap, first: Boolean) {
    var key by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    val a = rememberAction()
    PageHead("Import a private key") { m.back() }
    PCard {
        Muted("Paste a 64-character hex private key, for example the key of the desktop PSYROB miner. It is stored encrypted by the Android Keystore.")
        Spacer(Modifier.height(10.dp))
        Field(key, { key = it }, singleLine = false, minLines = 3, placeholder = "0x…", mono = true, password = false)
        Field(name, { name = it.take(32) }, label = "Account name (optional)", placeholder = "e.g. Miner key")
        ErrText(a.err)
        Spacer(Modifier.height(12.dp))
        PButton("Import", {
            a.run {
                m.io {
                    val addr = m.api.vault.importKey(key.trim())
                    renameNew(m, addr, name)
                }
                key = ""
                if (first || !s.hasWallet) m.afterOnboard() else { m.assets = null; m.tab("wallet") }
            }
        }, busy = a.busy, busyText = "Importing")
    }
}

/** Gives a just-added account the name the user typed. */
fun renameNew(m: Model, address: String, name: String) {
    if (name.isBlank()) return
    val i = m.api.vault.accounts().objects().indexOfFirst { it.optString("address").equals(address, true) }
    if (i >= 0) m.api.vault.rename(i, name.trim())
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun BackupScreen(m: Model, phrase: String, first: Boolean) {
    val p = LocalPsy.current
    val words = phrase.split(" ").filter { it.isNotBlank() }
    val a = rememberAction()
    PageHead("Your recovery phrase", if (first) null else ({ m.back() }))
    PCard {
        NoteBox("Write these ${words.size} words on paper, in order, and keep them offline. Anyone with them can take your funds. PSYROB Suite will never ask for them again.", danger = true)
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), maxItemsInEachRow = 3) {
            words.forEachIndexed { i, w ->
                Row(
                    Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).background(p.input).border(1.dp, p.line, RoundedCornerShape(10.dp)).padding(horizontal = 8.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("${i + 1}", color = p.muted, fontSize = 11.sp, modifier = Modifier.width(20.dp))
                    Text(w, color = p.text, fontSize = 14.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold)
                }
            }
        }
        Spacer(Modifier.height(14.dp))
        PButton("I wrote it down", { a.run { m.io { m.api.vault.setBackedUp() }; if (first) m.afterOnboard() else m.tab("wallet") } }, icon = "check", busy = a.busy)
    }
}

@Composable
fun LockScreen(m: Model, s: Snap) {
    val p = LocalPsy.current
    var pw by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    val wait = AppLock.waitMs(m.act)
    var err by remember { mutableStateOf(if (wait > 0) "Too many wrong passwords. Try again in ${(wait + 999) / 1000} s." else null) }
    val focus = remember { FocusRequester() }
    fun unlock() {
        if (busy) return
        busy = true; err = null
        scope.launch {
            try {
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { AppLock.unlock(m.act, pw) }
                m.assets = null; m.checkLock()
            } catch (e: Exception) { err = e.message; pw = "" }
            busy = false
        }
    }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        HeroLogo(110.dp)
        Spacer(Modifier.height(18.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            PIcon("lock", size = 24.dp); Spacer(Modifier.width(8.dp))
            Text("PSYROB Suite is locked", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = p.text)
        }
        Muted("Enter your app password to open the wallet.", Modifier.padding(top = 6.dp, bottom = 14.dp))
        Column(Modifier.widthIn(max = 380.dp)) {
            Field(pw, { pw = it }, Modifier.fillMaxWidth().focusRequester(focus), placeholder = "Password", password = true, onDone = { unlock() })
            ErrText(err)
            Spacer(Modifier.height(14.dp))
            PButton("Unlock", { unlock() }, busy = busy, busyText = "Checking", icon = "lock")
            Spacer(Modifier.height(10.dp))
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                LinkBtn("Forgot password?", {
                    scope.launch {
                        val done = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                            if (!m.confirm("Forgot your password?", "The only way back in is to delete the wallet from this phone and restore it from your recovery phrase or private keys. Without them, the funds are lost.", "Delete wallet")) false
                            else { if (MinerService.active()) MinerService.stop(m.act); m.api.vault.wipe(); AppLock.clear(m.act); true }
                        }
                        if (done) { m.assets = null; m.locked = false; m.reset("welcome") }
                    }
                })
            }
        }
    }
    LaunchedEffect(Unit) { try { focus.requestFocus() } catch (_: Exception) {} }
}

@Composable
fun PasswordScreen(m: Model, s: Snap, first: Boolean) {
    val change = s.lockEnabled
    var cur by remember { mutableStateOf("") }
    var n by remember { mutableStateOf("") }
    var r by remember { mutableStateOf("") }
    val a = rememberAction()
    val rm = rememberAction()
    fun save() {
        if (n.length < AppLock.MIN_LEN) { a.err = "Use at least ${AppLock.MIN_LEN} characters."; return }
        if (n != r) { a.err = "The two passwords are not the same."; return }
        a.run {
            m.io { AppLock.set(m.act, if (change) cur else null, n) }
            m.act.toast(if (change) "Password updated" else "Password set")
            m.tab(if (first) "wallet" else "settings")
        }
    }
    PageHead(if (first) "Protect your wallet" else if (change) "Change app password" else "Set app password", if (first) null else ({ m.back() }))
    PCard {
        Muted(
            if (first) "Set an app password. PSYROB Suite asks for it every time it is opened, and before it shows your recovery phrase or private keys."
            else "The password is asked when the app opens, after it was in the background, and before secrets are shown. It is stored only as a salted hash on this phone.",
        )
        if (change) Field(cur, { cur = it }, label = "Current password", password = true)
        Field(n, { n = it }, label = if (change) "New password" else "Password", placeholder = "At least ${AppLock.MIN_LEN} characters", password = true)
        Field(r, { r = it }, label = "Repeat it", password = true, onDone = { save() })
        ErrText(a.err)
        Spacer(Modifier.height(14.dp))
        PButton(if (change) "Update password" else "Set password", { save() }, busy = a.busy, busyText = "Saving", icon = "lock")
        if (first) Box(Modifier.fillMaxWidth().padding(top = 8.dp), contentAlignment = Alignment.Center) { LinkBtn("Skip for now", { m.tab("wallet") }) }
        Spacer(Modifier.height(10.dp))
        Muted("If you forget it, the only way back in is to delete the wallet from this phone and restore it with your recovery phrase.", size = 12)
    }
    if (change) PCard {
        CardTitle("Turn off")
        Muted("Enter the current password above, then remove it. The app then opens without a password.")
        Spacer(Modifier.height(12.dp))
        PButton("Remove password", {
            if (cur.isEmpty()) { rm.err = "Enter the current password first."; return@PButton }
            rm.run { m.io { AppLock.remove(m.act, cur) }; m.act.toast("Password removed"); m.tab("settings") }
        }, kind = Kind.Danger, icon = "trash", busy = rm.busy, busyText = "Removing")
        ErrText(rm.err)
    }
}
