package com.psyrob.suite.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import com.psyrob.suite.core.Hex;

/**
 * App password. Only a salted PBKDF2-HMAC-SHA256 hash is stored. The app locks when it is opened and after it has been
 * in the background longer than the chosen time; while locked the native side refuses every wallet call.
 */
final class AppLock {
    static final int MIN_LEN = 6;
    private static final int ITER = 120_000;
    private static volatile boolean unlocked = false;
    private static int started = 0;
    private static long hiddenAt = 0;

    private AppLock() {}

    private static SharedPreferences p(Context c) { return c.getApplicationContext().getSharedPreferences("lock", Context.MODE_PRIVATE); }

    static boolean enabled(Context c) { return p(c).contains("hash"); }
    static boolean locked(Context c) { return enabled(c) && !unlocked; }
    /** Seconds in the background before the app locks: 0 = as soon as it is left. */
    static int timeout(Context c) { return p(c).getInt("timeout", 0); }
    static void setTimeout(Context c, int s) { p(c).edit().putInt("timeout", Math.max(0, Math.min(s, 3600))).apply(); }

    /** Call from every activity's onStart / onStop. */
    static synchronized void onStart(Context c) {
        if (started == 0 && hiddenAt != 0 && SystemClock.elapsedRealtime() - hiddenAt >= timeout(c) * 1000L) unlocked = false;
        started++;
    }
    static synchronized void onStop() { started = Math.max(0, started - 1); if (started == 0) hiddenAt = SystemClock.elapsedRealtime(); }
    static void lockNow() { unlocked = false; }

    /** Milliseconds until another try is allowed after too many wrong passwords. */
    static long waitMs(Context c) { return Math.max(0, p(c).getLong("until", 0) - System.currentTimeMillis()); }

    static boolean check(Context c, String pw) throws Exception {
        if (!enabled(c)) return true;
        long w = waitMs(c);
        if (w > 0) throw new Exception("Too many wrong passwords. Try again in " + ((w + 999) / 1000) + " s.");
        SharedPreferences s = p(c);
        boolean ok = MessageDigest.isEqual(hash(pw, Hex.decode(s.getString("salt", "")), s.getInt("iter", ITER)), Hex.decode(s.getString("hash", "")));
        if (ok) { s.edit().putInt("fails", 0).putLong("until", 0).apply(); return true; }
        int f = s.getInt("fails", 0) + 1;
        long until = f >= 5 ? System.currentTimeMillis() + Math.min(3_600_000L, 30_000L << Math.min(f - 5, 7)) : 0;
        s.edit().putInt("fails", f).putLong("until", until).apply();
        return false;
    }

    static void unlock(Context c, String pw) throws Exception {
        if (!check(c, pw)) throw new Exception(waitMs(c) > 0 ? "Wrong password. Too many tries: wait " + ((waitMs(c) + 999) / 1000) + " s." : "Wrong password.");
        unlocked = true;
    }

    static void set(Context c, String current, String pw) throws Exception {
        if (enabled(c) && !check(c, current == null ? "" : current)) throw new Exception("The current password is wrong.");
        if (pw == null || pw.length() < MIN_LEN) throw new Exception("Use at least " + MIN_LEN + " characters.");
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        p(c).edit().putString("salt", Hex.encode(salt)).putInt("iter", ITER).putString("hash", Hex.encode(hash(pw, salt, ITER))).putInt("fails", 0).putLong("until", 0).apply();
        unlocked = true;
    }

    static void remove(Context c, String current) throws Exception {
        if (!check(c, current == null ? "" : current)) throw new Exception("The current password is wrong.");
        clear(c);
    }

    /** After the wallet is deleted ("forgot password"). */
    static void clear(Context c) { p(c).edit().clear().apply(); unlocked = false; }

    static byte[] hash(String pw, byte[] salt, int iter) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(pw.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        mac.update(salt);
        mac.update(new byte[] { 0, 0, 0, 1 });
        byte[] u = mac.doFinal(), out = u.clone();
        for (int i = 1; i < iter; i++) { u = mac.doFinal(u); for (int j = 0; j < out.length; j++) out[j] ^= u[j]; }
        return out;
    }

    /**
     * Password sheet (call from a background thread) for sensitive actions such as showing the recovery phrase.
     * Returns true without asking when no password is set.
     */
    static boolean confirm(Activity a, String title) {
        if (!enabled(a)) return true;
        if (!(a instanceof Approval.Host) || a.isFinishing()) return false;
        return ((Approval.Host) a).confirmPassword(title);
    }
}
