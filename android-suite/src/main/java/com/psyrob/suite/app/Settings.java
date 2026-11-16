package com.psyrob.suite.app;

import android.app.ActivityManager;
import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.List;

/** User settings, with defaults for the public PSYROB network (chain 87870). */
public final class Settings {
    public static final String DEFAULT_NODE = "https://rpc.psyrob.com";
    public static final String EXPLORER = "https://explorer.psyrob.com";
    private final SharedPreferences p;
    private final Context ctx;

    public Settings(Context c) { ctx = c.getApplicationContext(); p = ctx.getSharedPreferences("settings", Context.MODE_PRIVATE); }

    public String nodes() { return p.getString("nodes", DEFAULT_NODE); }

    public List<String> nodeList() {
        List<String> out = new ArrayList<String>();
        for (String s : nodes().split("[,\\s]+")) if (s.trim().length() > 0) out.add(s.trim());
        if (out.isEmpty()) out.add(DEFAULT_NODE);
        return out;
    }

    public int threads() { return Math.max(1, Math.min(p.getInt("threads", defaultThreads()), maxThreads())); }

    public boolean chargingOnly() { return p.getBoolean("chargingOnly", false); }

    public boolean keepScreenOn() { return p.getBoolean("keepScreenOn", false); }

    public boolean autoResume() { return p.getBoolean("autoResume", true); }

    public boolean wasMining() { return p.getBoolean("wasMining", false); }

    public void setWasMining(boolean b) { p.edit().putBoolean("wasMining", b).apply(); }

    public void save(String nodes, int threads, boolean chargingOnly, boolean keepScreenOn, boolean autoResume) {
        p.edit().putString("nodes", nodes == null || nodes.trim().isEmpty() ? DEFAULT_NODE : nodes.trim())
            .putInt("threads", Math.max(1, Math.min(threads, maxThreads())))
            .putBoolean("chargingOnly", chargingOnly).putBoolean("keepScreenOn", keepScreenOn).putBoolean("autoResume", autoResume).apply();
    }

    public int cores() { return Math.max(1, Runtime.getRuntime().availableProcessors()); }

    /** Each thread needs 32 MiB of Argon2d memory; keep a margin below the app's memory limit. */
    public int maxThreads() {
        long heapMb = Runtime.getRuntime().maxMemory() / (1024 * 1024);
        int byMem = (int) Math.max(1, (heapMb - 64) / 40);
        return Math.max(1, Math.min(cores(), byMem));
    }

    public int defaultThreads() { return Math.max(1, Math.min(maxThreads(), cores() / 2)); }

    public long deviceMemoryMb() {
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        return mi.totalMem / (1024 * 1024);
    }
}
