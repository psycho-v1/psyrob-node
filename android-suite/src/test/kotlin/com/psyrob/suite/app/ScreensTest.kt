package com.psyrob.suite.app

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.core.app.ApplicationProvider
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Renders the main screens in both themes to build/shots so they can be looked at without a phone. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w393dp-h852dp-xxhdpi")
class ScreensTest {
    companion object {
        const val A1 = "0x9F3c2B71c04e5B6aA2d1E8f4C5b7a90D3e61F2a4"
        const val A2 = "0x41aD07c9E2b8F53e6D1a4C7B90e2F8d65A3b1C07"
    }

    @get:Rule val rule = createAndroidComposeRule<MainActivity>()

    private fun prefs(theme: String, wallet: Boolean, password: Boolean = false) {
        val c = ApplicationProvider.getApplicationContext<Context>()
        c.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().putString("theme", theme).putInt("threads", 4).commit()
        val v = c.getSharedPreferences("vault", Context.MODE_PRIVATE).edit()
        if (wallet) v.putString("accounts", JSONArray()
            .put(JSONObject().put("name", "Main wallet").put("address", A1).put("kind", "phrase").put("index", 0))
            .put(JSONObject().put("name", "Miner key").put("address", A2).put("kind", "imported")).toString())
            .putBoolean("hasPhrase", true).putBoolean("backedUp", false).putInt("selected", 0)
        else v.clear()
        v.commit()
        if (!password) c.getSharedPreferences("lock", Context.MODE_PRIVATE).edit().clear().commit()
    }

    private fun fakeAssets() = JSONObject().put("chainId", WalletData.PSYROB_CHAIN).put("address", A1).put("assets", JSONArray()
        .put(JSONObject().put("symbol", "PSY").put("name", "PSY").put("native", true).put("logo", "psy").put("balance", "1284.5307"))
        .put(JSONObject().put("symbol", "M-PSY").put("name", "Mini PSY").put("logo", "mpsy").put("address", WalletData.MPSY_ADDRESS).put("balance", "52000")))

    private fun shot(name: String, dialog: Boolean = false) {
        rule.mainClock.advanceTimeBy(600)
        val img = (if (dialog) rule.onNode(isDialog()) else rule.onRoot()).captureToImage().asAndroidBitmap()
        val dir = File("build/shots").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { img.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun screens(theme: String) {
        rule.mainClock.autoAdvance = false
        val m = rule.activity.model
        rule.runOnUiThread { m.theme = theme; m.locked = false; m.assets = fakeAssets(); m.tab("wallet") }
        shot("$theme-1-wallet")
        rule.runOnUiThread { m.tab("mine") }; shot("$theme-2-mine")
        rule.runOnUiThread { m.go("accounts"); m.editing = 1 }; shot("$theme-3-accounts")
        rule.runOnUiThread { m.editing = -1; m.go("receive") }; shot("$theme-4-receive")
        rule.runOnUiThread { m.tab("settings") }; shot("$theme-5-settings")
        rule.runOnUiThread { m.go("send") }; shot("$theme-6-send")
        rule.runOnUiThread { m.tab("browser") }; shot("$theme-7-dapps")
        rule.runOnUiThread {
            rule.activity.approval = HostActivity.Ask(Approval.Request("Confirm transaction", "https://app.example.org", listOf(
                arrayOf("From", "Main wallet\n$A1"), arrayOf("To (contract or address)", A2), arrayOf("Amount", "12.5 PSY"),
                arrayOf("Network fee (likely / at most)", "0.000021 PSY / 0.000042 PSY"), arrayOf("Network", "PSYROB Network"),
                arrayOf("Pre-sign check", "Simulation passed: the call does not revert.")), "The receiver is a new address you never sent to.", null, "Confirm", false, null))
        }
        shot("$theme-8-approval", dialog = true)
        rule.runOnUiThread { rule.activity.approval = null; m.locked = true }; shot("$theme-9-lock")
    }

    @Test fun dark() { prefs("dark", true); screens("dark") }
    @Test fun day() { prefs("light", true); screens("light") }
    @Test fun welcome() {
        prefs("dark", false)
        rule.mainClock.autoAdvance = false
        rule.runOnUiThread { rule.activity.model.reset("welcome") }
        shot("dark-0-welcome")
        rule.runOnUiThread { rule.activity.model.theme = "light" }
        shot("light-0-welcome")
    }
}
