package com.psyrob.suite.app;

import android.app.Activity;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.view.View;

/** Day and night colours for the native parts (confirmation sheets, dApp browser bar, system bars). Mirrors app.css. */
final class Theme {
    final boolean dark;
    final int bg, panel, line, text, muted, accent, onAccent, bad, warnBg, warnLine, warnText, input, hint;

    private Theme(boolean d) {
        dark = d;
        bg = c(d, "#071014", "#f3f7f9"); panel = c(d, "#0d1b21", "#ffffff"); line = c(d, "#1d3a44", "#d3e1e6");
        text = c(d, "#e6fbff", "#0b1d24"); muted = c(d, "#9fbfc7", "#587079"); accent = c(d, "#00f0ff", "#0098a8");
        onAccent = c(d, "#071014", "#ffffff"); bad = c(d, "#ff6b6b", "#d33a3a"); warnBg = c(d, "#2a1d07", "#fff4e0");
        warnLine = c(d, "#5c4210", "#f0c987"); warnText = c(d, "#ffd9a0", "#6b4300"); input = c(d, "#050c0f", "#ffffff"); hint = c(d, "#6f8f97", "#8aa0a8");
    }
    private static int c(boolean d, String dark, String light) { return Color.parseColor(d ? dark : light); }

    /** "system" (default), "dark" or "light". */
    static String choice(Context ctx) { return ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).getString("theme", "system"); }
    static void setChoice(Context ctx, String t) {
        if (!"dark".equals(t) && !"light".equals(t)) t = "system";
        ctx.getSharedPreferences("settings", Context.MODE_PRIVATE).edit().putString("theme", t).apply();
    }
    static boolean isDark(Context ctx) {
        String t = choice(ctx);
        if ("dark".equals(t)) return true;
        if ("light".equals(t)) return false;
        return (ctx.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) != Configuration.UI_MODE_NIGHT_NO;
    }
    static Theme of(Context ctx) { return new Theme(isDark(ctx)); }

    /** Status and navigation bar colours, with dark icons on the light theme. */
    static void bars(Activity a) {
        Theme t = of(a);
        a.getWindow().setStatusBarColor(t.bg);
        a.getWindow().setNavigationBarColor(t.bg);
        View v = a.getWindow().getDecorView();
        int f = v.getSystemUiVisibility();
        if (Build.VERSION.SDK_INT >= 23) f = t.dark ? f & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR : f | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= 26) f = t.dark ? f & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : f | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        v.setSystemUiVisibility(f);
    }
}
