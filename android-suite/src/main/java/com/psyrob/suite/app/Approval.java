package com.psyrob.suite.app;

import android.app.Activity;

import java.util.ArrayList;
import java.util.List;

/**
 * The wallet's own confirmation sheet for connections, transactions and signatures. It is drawn natively (Compose,
 * in its own secure window) outside the web page, so a site cannot fake or hide it. The activity draws it: see Host.
 */
public final class Approval {

    private Approval() {}

    /** One confirmation: rows = [label, value] pairs; with ackText the confirm button stays locked until it is ticked. */
    public static final class Request {
        public final String title, origin, warning, detail, okLabel, ackText;
        public final List<String[]> rows;
        public final boolean danger;
        Request(String title, String origin, List<String[]> rows, String warning, String detail, String okLabel, boolean danger, String ackText) {
            this.title = title; this.origin = origin; this.rows = rows == null ? new ArrayList<String[]>() : rows; this.warning = warning;
            this.detail = detail; this.okLabel = okLabel; this.danger = danger; this.ackText = ackText;
        }
    }

    /** Implemented by every activity of the app. Both calls block the calling (background) thread until the user answers. */
    public interface Host {
        boolean approve(Request r);
        boolean confirmPassword(String title);
    }

    /** Show the sheet and wait for the answer. Call from a background thread. Returns true when the user confirmed. */
    public static boolean ask(Activity a, String title, String origin, List<String[]> rows, String warning, String detail, String okLabel, boolean danger) {
        return ask(a, title, origin, rows, warning, detail, okLabel, danger, null);
    }

    public static boolean ask(Activity a, String title, String origin, List<String[]> rows, String warning, String detail, String okLabel, boolean danger, String ackText) {
        if (!(a instanceof Host) || a.isFinishing()) return false;
        return ((Host) a).approve(new Request(title, origin, rows, warning, detail, okLabel, danger, ackText));
    }
}
