package com.psyrob.suite.core;

import java.math.BigInteger;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The PSY miner, a port of miner/src/miner.js in psyrob-node: block templates over JSON-RPC, nonce search on
 * worker threads (Argon2d, 32 MiB per attempt on the public network), a fresh miner signature per attempt, and
 * submission with retry. Every template is checked before any thread signs it.
 */
public final class MinerEngine {
    public interface Listener { void onLog(String line); }

    public static final long PUBLIC_CHAIN_ID = 87870L;
    private static final long SUBMIT_RETRY_MS = 30000;
    private static final long REFRESH_MS = 20000;
    private static final long POLL_MS = 2000;

    private final List<String> urls;
    private final byte[] sk;
    public final String address;
    public final int threads;
    private final Long expectChainId;
    private final Listener listener;

    private volatile boolean running;
    private volatile int gen; // start() generation: threads of an earlier start() end even if mining restarts
    private volatile Job job;
    private int at; // node in use
    private String tipKey;
    private Thread control;
    private final List<Thread> workers = new ArrayList<Thread>();
    private final ExecutorService submitter = Executors.newSingleThreadExecutor();
    private final Map<String, String> submitted = new HashMap<String, String>();

    public final AtomicLong attempts = new AtomicLong();
    private final long[] threadAttempts;
    public volatile int found, accepted, rejected;
    private final LinkedList<JSONObject> blocks = new LinkedList<JSONObject>();
    private final LinkedList<String> logLines = new LinkedList<String>();
    private volatile String status = "Stopped";
    private volatile double hashrate;
    private volatile long startedAt;
    private volatile long chainHeight = -1, latencyMs = -1, dagBlueScore = -1;
    private volatile long chainIdSeen = -1;

    public MinerEngine(List<String> urls, byte[] sk, int threads, Long expectChainId, Listener listener) {
        this.urls = new ArrayList<String>();
        for (String u : urls) { String s = u.trim(); while (s.endsWith("/")) s = s.substring(0, s.length() - 1); if (s.length() > 0) this.urls.add(s); }
        if (this.urls.isEmpty()) throw new IllegalArgumentException("no node address");
        this.sk = sk.clone();
        this.address = Hex.with0x(Secp256k1.address(sk));
        this.threads = Math.max(1, threads);
        this.threadAttempts = new long[this.threads];
        this.expectChainId = expectChainId;
        this.listener = listener;
    }

    public boolean isRunning() { return running; }

    private String url() { return urls.get(at); }

    void log(String s) {
        synchronized (logLines) {
            logLines.addFirst(new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(new java.util.Date()) + "  " + s);
            while (logLines.size() > 150) logLines.removeLast();
        }
        if (listener != null) listener.onLog(s);
    }

    /** Check the Argon2d code and the signature code before mining (the node's own self-test vectors). */
    public static void selfTest() {
        Argon2d a = new Argon2d();
        String got = Hex.encode(a.hash(Hex.decode("03"), Hex.decode("505359524f422d506f572d7633"), 8, 1));
        if (!got.equals("96b9fbacbb1e7fb20b4741653fd2debcb07d3e339cb3c04b63be597a721bb914")) throw new IllegalStateException("Argon2d self-test failed");
        got = Hex.encode(a.hash(Hex.decode("ec366b8df1c36bdb926a0404b04204bba1af2bdfc76ed3f48e8fbe01c92ab354c2e1777b8b9b92f4e625401a353686827134b149db3c150dd7c01911313d60e9492be7a121c3e43d6a17b5c2b2d9a7a165756f3fdbf7c2e4e5aa22cc06ebd789b03a0926f520c1cc3c6715eb133ce977be5d821ab09d1a63f55fc26acafbf5"),
            Hex.decode("505359524f422d506f572d7634"), 16, 1));
        if (!got.equals("0061094311c876d50093c660192fde9c25bd8671f8dba65e1aad8cb597339cf3")) throw new IllegalStateException("Argon2d self-test failed");
        byte[] k = new byte[32]; k[0] = 0x11; k[31] = 7;
        byte[] d = Keccak256.hash(new byte[] { 0 });
        if (!Hex.encode(Secp256k1.recoverAddress(d, Secp256k1.sign(d, k))).equals("fec8ff2009e61b52b5fd8b74b7adb27bbfc1ec9d")) throw new IllegalStateException("signature self-test failed");
    }

    public synchronized void start() {
        if (running) return;
        running = true;
        final int g = ++gen;
        startedAt = System.currentTimeMillis();
        status = "Starting";
        control = new Thread(new Runnable() { public void run() { controlLoop(g); } }, "psy-control");
        control.start();
    }

    public synchronized void stop() {
        if (!running) return;
        running = false;
        status = "Stopped";
        job = null;
        if (control != null) control.interrupt();
        for (Thread w : workers) w.interrupt();
        workers.clear();
        hashrate = 0;
        log("mining stopped");
    }

    private boolean alive(int g) { return running && gen == g; }

    private void controlLoop(final int g) {
        try {
            selfTest();
        } catch (Exception e) {
            status = "Error"; log(e.getMessage()); running = false; return;
        }
        // find a node on the right network
        while (alive(g)) {
            try { checkNode(url()); break; } catch (Exception e) {
                status = "Waiting for node";
                log(e.getMessage());
                if (!failover(e.getMessage())) sleep(5000);
            }
        }
        if (!alive(g)) return;
        log("mining for " + address + " via " + url() + "; " + threads + " thread(s), Argon2d native");
        final BigInteger base = new BigInteger(1, randomBytes(6));
        for (int i = 0; i < threads; i++) {
            final int idx = i;
            Thread w = new Thread(new Runnable() { public void run() { workerLoop(idx, base, g); } }, "psy-worker-" + i);
            w.setPriority(Thread.MIN_PRIORITY);
            workers.add(w);
            w.start();
        }
        long lastSample = System.currentTimeMillis(), lastCount = attempts.get();
        long jobAt = 0;
        while (alive(g)) {
            try {
                long t0 = System.currentTimeMillis();
                JSONObject info = (JSONObject) Rpc.call(url(), "psy_dagInfo", null);
                latencyMs = System.currentTimeMillis() - t0;
                chainHeight = info.optLong("chainHeight", -1);
                dagBlueScore = info.optLong("blueScore", -1);
                JSONArray tips = info.optJSONArray("tips");
                List<String> tl = new ArrayList<String>();
                if (tips != null) for (int i = 0; i < tips.length(); i++) tl.add(tips.getString(i));
                java.util.Collections.sort(tl);
                String key = tl.toString();
                if (job == null || !key.equals(tipKey) || System.currentTimeMillis() - jobAt > REFRESH_MS) {
                    tipKey = key;
                    if (newJob()) jobAt = System.currentTimeMillis();
                }
            } catch (Rpc.TransientException e) {
                status = "Node unreachable";
                log("poll: " + e.getMessage());
                failover(e.getMessage());
            } catch (Exception e) {
                log("poll: " + e.getMessage());
            }
            long now = System.currentTimeMillis();
            if (now - lastSample >= POLL_MS) {
                long c = attempts.get();
                double r = (c - lastCount) * 1000.0 / (now - lastSample);
                hashrate = hashrate == 0 ? r : hashrate * 0.7 + r * 0.3;
                lastSample = now; lastCount = c;
            }
            sleep(POLL_MS);
        }
    }

    private JSONObject checkNode(String u) throws Exception {
        JSONObject info = (JSONObject) Rpc.call(u, "psy_dagInfo", null);
        long cid = Hex.quantity(info.get("chainId")).longValue();
        chainIdSeen = cid;
        if (expectChainId != null && cid != expectChainId) throw new Exception(u + " is on chain " + cid + ", not " + expectChainId);
        return info;
    }

    private boolean failover(String reason) {
        if (urls.size() < 2) return false;
        for (int i = 1; i <= urls.size(); i++) {
            int a = (at + i) % urls.size();
            try {
                checkNode(urls.get(a));
                if (a != at) log("switching to " + urls.get(a) + " (" + reason + ")");
                at = a;
                return true;
            } catch (Exception ignored) { }
        }
        return false;
    }

    /** Ask for a template; returns true when a new job was published to the threads. */
    private boolean newJob() {
        Object t;
        try {
            t = Rpc.call(url(), "psy_getBlockTemplate", new JSONArray().put(address));
        } catch (Exception e) {
            if (e.getMessage() != null && e.getMessage().contains("still syncing")) { status = "Node is syncing"; return false; }
            status = "No template";
            log("template: " + e.getMessage());
            return false;
        }
        try {
            Job j = Job.fromTemplate((JSONObject) t, url());
            j.check(address, expectChainId);
            job = j;
            status = "Mining";
            synchronized (submitted) { while (submitted.size() > 64) submitted.remove(submitted.keySet().iterator().next()); }
            return true;
        } catch (Exception e) {
            job = null;
            status = "Template refused";
            log(e.getMessage());
            return false;
        }
    }

    private void workerLoop(int idx, BigInteger base, int g) {
        Argon2d argon = new Argon2d();
        Job.Attempt res = new Job.Attempt();
        Job mine = null;
        BigInteger nonce = BigInteger.ZERO, step = BigInteger.valueOf(threads);
        BigInteger mask = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE);
        while (alive(g)) {
            Job j = job;
            if (j == null) { sleep(250); continue; }
            if (j != mine) { mine = j; nonce = base.add(BigInteger.valueOf(idx)); }
            try {
                j.attempt(nonce, sk, argon, res);
            } catch (OutOfMemoryError oom) {
                log("not enough memory for thread " + (idx + 1) + "; use fewer threads");
                return;
            }
            attempts.incrementAndGet();
            threadAttempts[idx]++;
            if (res.ok && running) {
                final Job fj = j;
                final String nonceHex = "0x" + nonce.toString(16);
                final String sigHex = Hex.with0x(res.sig);
                submitter.execute(new Runnable() { public void run() { submit(fj, nonceHex, sigHex); } });
            }
            nonce = nonce.add(step).and(mask);
        }
    }

    private void submit(Job j, String nonceHex, String sigHex) {
        synchronized (submitted) {
            String st = submitted.get(j.id);
            if ("pending".equals(st) || "added".equals(st)) return;
            submitted.put(j.id, "pending");
        }
        found++;
        JSONObject rec = new JSONObject();
        try { rec.put("at", System.currentTimeMillis()).put("blueScore", j.blueScore).put("status", "pending"); } catch (Exception ignored) { }
        synchronized (blocks) { blocks.addFirst(rec); while (blocks.size() > 100) blocks.removeLast(); }
        log("block found (blue score " + j.blueScore + "), submitting");
        // fetch the next template at once; the threads keep hashing meanwhile
        if (job == j) newJob();
        long until = System.currentTimeMillis() + SUBMIT_RETRY_MS;
        for (long wait = 500; ; wait = Math.min(wait * 2, 4000)) {
            try {
                JSONObject r = (JSONObject) Rpc.call(j.nodeUrl, "psy_submitBlock", new JSONArray().put(j.id).put(nonceHex).put(sigHex));
                String st = r.optString("status");
                String hash = r.optString("hash");
                if ("added".equals(st)) accepted++; else if (!"known".equals(st)) rejected++;
                synchronized (rec) { rec.put("status", st).put("hash", hash); }
                synchronized (submitted) { submitted.put(j.id, "added".equals(st) || "known".equals(st) ? "added" : "failed"); }
                log("block " + (hash.length() > 18 ? hash.substring(0, 18) + "…" : hash) + " " + st);
                return;
            } catch (Exception e) {
                boolean transientErr = e instanceof Rpc.TransientException;
                if (!transientErr || System.currentTimeMillis() + wait > until || !running) {
                    rejected++;
                    synchronized (submitted) { submitted.put(j.id, "failed"); }
                    try { synchronized (rec) { rec.put("status", "refused").put("reason", e.getMessage()); } } catch (Exception ignored) { }
                    log("submit refused: " + e.getMessage());
                    return;
                }
                sleep(wait);
            }
        }
    }

    /** Everything the screen and the notification show. */
    public JSONObject snapshot() {
        JSONObject o = new JSONObject();
        try {
            Job j = job;
            o.put("running", running).put("status", status).put("address", address).put("threads", threads)
                .put("node", url()).put("hashrate", hashrate).put("attempts", attempts.get())
                .put("found", found).put("accepted", accepted).put("rejected", rejected)
                .put("uptimeSec", running ? (System.currentTimeMillis() - startedAt) / 1000 : 0)
                .put("chainHeight", chainHeight).put("blueScore", dagBlueScore).put("latencyMs", latencyMs).put("chainId", chainIdSeen);
            if (j != null) o.put("jobBlueScore", j.blueScore).put("expectedAttempts", j.expectedAttempts()).put("memoryKiB", j.memoryKiB);
            JSONArray per = new JSONArray();
            for (long n : threadAttempts) per.put(n);
            o.put("threadAttempts", per);
            JSONArray bl = new JSONArray();
            synchronized (blocks) { for (JSONObject b : blocks) synchronized (b) { bl.put(new JSONObject(b.toString())); } }
            o.put("blocks", bl);
            JSONArray lg = new JSONArray();
            synchronized (logLines) { for (String s : logLines) lg.put(s); }
            o.put("log", lg);
        } catch (Exception ignored) { }
        return o;
    }

    private static byte[] randomBytes(int n) { byte[] b = new byte[n]; new SecureRandom().nextBytes(b); return b; }

    private static void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) { } }

    /** Wipe the key copy when the engine is thrown away. */
    public void destroy() { stop(); submitter.shutdownNow(); Arrays.fill(sk, (byte) 0); }
}
