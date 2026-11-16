package com.psyrob.suite.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import java.util.Arrays;
import java.util.Locale;

import org.json.JSONObject;

import com.psyrob.suite.R;
import com.psyrob.suite.core.MinerEngine;

/**
 * Keeps PSY mining running while the screen is off or the app is in the background: a foreground service with a
 * partial wake lock and a notification showing the hash rate. Optionally pauses when the phone is not charging.
 */
public final class MinerService extends Service {
    public static final String ACTION_START = "com.psyrob.suite.START";
    public static final String ACTION_STOP = "com.psyrob.suite.STOP";
    private static final String CHANNEL = "mining";
    private static final int NOTE_ID = 1;

    private static volatile MinerEngine engine;
    private static volatile String pausedReason;

    private PowerManager.WakeLock wakeLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Settings settings;

    public static MinerEngine engine() { return engine; }

    public static String pausedReason() { return pausedReason; }

    public static boolean active() { return engine != null; }

    public static void start(Context c) {
        Intent i = new Intent(c, MinerService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
    }

    public static void stop(Context c) {
        c.startService(new Intent(c, MinerService.class).setAction(ACTION_STOP));
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        settings = new Settings(this);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "PSY mining", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shows the hash rate while PSYROB Suite is mining");
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            settings.setWasMining(false);
            shutdown();
            return START_NOT_STICKY;
        }
        goForeground(buildNotification("Starting…"));
        if (engine == null) {
            if (!beginEngine()) { shutdown(); return START_NOT_STICKY; }
            settings.setWasMining(true);
            if (wakeLock == null) {
                wakeLock = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PSYROBSuite:mining");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire();
            }
            handler.post(tick);
        }
        return START_STICKY;
    }

    private boolean beginEngine() {
        Vault w = WalletApi.get(this).vault;
        if (!w.has() || w.watchOnly()) return false;
        byte[] sk = null;
        try {
            sk = w.privateKey();
            engine = new MinerEngine(settings.nodeList(), sk, settings.threads(), MinerEngine.PUBLIC_CHAIN_ID, null);
        } catch (Exception e) {
            return false;
        } finally {
            if (sk != null) Arrays.fill(sk, (byte) 0);
        }
        pausedReason = null;
        if (!settings.chargingOnly() || charging()) engine.start(); else pausedReason = "Paused: waiting for the charger";
        return true;
    }

    private void goForeground(Notification n) {
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTE_ID, n);
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            MinerEngine e = engine;
            if (e == null) return;
            if (settings.chargingOnly()) {
                boolean ch = charging();
                if (!ch && e.isRunning()) { e.stop(); pausedReason = "Paused: not charging"; }
                else if (ch && !e.isRunning()) { pausedReason = null; e.start(); }
            }
            JSONObject s = e.snapshot();
            String text = pausedReason != null ? pausedReason
                : String.format(Locale.US, "%s · %.2f H/s · %d threads · %d blocks", s.optString("status"), s.optDouble("hashrate", 0), s.optInt("threads"), s.optInt("accepted"));
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTE_ID, buildNotification(text));
            handler.postDelayed(this, 5000);
        }
    };

    private boolean charging() {
        Intent b = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (b == null) return true;
        int st = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        return st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL;
    }

    private Notification buildNotification(String text) {
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), piFlags);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, MinerService.class).setAction(ACTION_STOP), piFlags);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_stat_psy).setContentTitle("PSYROB Suite is mining PSY").setContentText(text)
            .setOngoing(true).setOnlyAlertOnce(true).setContentIntent(open)
            .addAction(new Notification.Action.Builder(0, "Stop", stop).build());
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return b.build();
    }

    private void shutdown() {
        handler.removeCallbacks(tick);
        MinerEngine e = engine;
        engine = null;
        pausedReason = null;
        if (e != null) e.destroy();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE); else stopForeground(true);
        stopSelf();
    }

    @Override public void onDestroy() {
        handler.removeCallbacks(tick);
        MinerEngine e = engine;
        engine = null;
        if (e != null) e.destroy();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}
