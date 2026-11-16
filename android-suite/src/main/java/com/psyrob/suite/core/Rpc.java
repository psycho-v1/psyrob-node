package com.psyrob.suite.core;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

import org.json.JSONArray;
import org.json.JSONObject;

/** JSON-RPC over HTTPS to a PSYROB node, with the error classes of miner/src/miner.js. */
public final class Rpc {
    /** A failure worth retrying: no answer, a busy node, HTTP 429/5xx, or a web page instead of JSON. */
    public static final class TransientException extends Exception {
        public TransientException(String m) { super(m); }
    }

    private Rpc() {}

    public static Object call(String url, String method, JSONArray params) throws Exception {
        String body = new JSONObject().put("jsonrpc", "2.0").put("id", 1).put("method", method)
            .put("params", params == null ? new JSONArray() : params).toString();
        HttpURLConnection c;
        int status;
        String text;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("User-Agent", "PSYROB-Suite-Android/1.0");
            OutputStream os = c.getOutputStream();
            os.write(body.getBytes(StandardCharsets.UTF_8));
            os.close();
            status = c.getResponseCode();
            InputStream is = status >= 400 ? c.getErrorStream() : c.getInputStream();
            text = is == null ? "" : readAll(is);
            c.disconnect();
        } catch (Exception e) {
            throw new TransientException(method + ": no answer from " + url + " (" + e.getClass().getSimpleName() + ": " + e.getMessage() + ")");
        }
        JSONObject j;
        try { j = new JSONObject(text); } catch (Exception e) {
            throw new TransientException(method + ": " + url + " answered HTTP " + status + " with a web page, not JSON-RPC");
        }
        if (j.has("error") && !j.isNull("error")) {
            JSONObject err = j.getJSONObject("error");
            String msg = method + ": " + err.optString("message", "error");
            if (err.optInt("code") == -32005 || status == 429 || status >= 500) throw new TransientException(msg);
            throw new Exception(msg);
        }
        return j.opt("result");
    }

    /** Plain GET returning the body (explorer statistics). */
    public static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestProperty("User-Agent", "PSYROB-Suite-Android/1.0");
        int status = c.getResponseCode();
        if (status >= 400) { c.disconnect(); throw new Exception("HTTP " + status); }
        String s = readAll(c.getInputStream());
        c.disconnect();
        return s;
    }

    static String readAll(InputStream is) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
        is.close();
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
}
