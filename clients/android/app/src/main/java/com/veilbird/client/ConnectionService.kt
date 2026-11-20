package com.veilbird.client

import android.app.*
import android.content.Context
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.VpnService
import android.os.PowerManager
import android.os.SystemClock
import com.veilbird.core.Core
import com.wireguard.crypto.KeyPair
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

object ConnectionStateStore {
    @Volatile var active = false
    @Volatile var messageId = R.string.not_connected
    val message: String get() = L10n.text(messageId)
    @Volatile var node = L10n.text(R.string.automatic)
    @Volatile var nodeId = ""
    /** elapsedRealtime of the first working transport; 0 while connecting or disconnected. */
    @Volatile var since = 0L
    /** Bytes per second over the last tick. */
    @Volatile var rxRate = 0L
    @Volatile var txRate = 0L
    /** The location automatic mode gave up on during this connection, for the one-line note on the connect page. */
    @Volatile var switchedFrom = ""
    /** While connecting: 0 picking a route, 1 opening the tunnel, 2 confirming it carries traffic. */
    @Volatile var phase = 0
    /** How many lines (transports) this location offers: the connect page draws one segment each. */
    @Volatile var lines = 0
    /** elapsedRealtime of the next retry while reconnecting (0 when none), and how many rounds have failed. */
    @Volatile var retryAt = 0L
    @Volatile var attempt = 0
    /** Why the last connection ended on its own (an API code, HANDSHAKE_TIMEOUT, LEASE_EXPIRED…); empty after a disconnect by the user. */
    @Volatile var errorCode = ""
    /** Shows a refusal the app found before the service ran (the VPN permission), the same way as one from the service. */
    fun failed(code: String, message: Int) { active = false; since = 0L; errorCode = code; messageId = message }
}

/** Thrown when no transport of a node answers from this network. */
private class Unreachable : Exception()

/**
 * The VPN: Android's tun goes to the embedded mihomo core, which carries traffic over the first
 * transport of the node that answers (see Transports). The app's own sockets stay outside the
 * tun, so the core's connections to nodes and the API calls use the underlying network.
 *
 * Once connected it stays connected until the user disconnects or the account is refused: a lost
 * network or a node that stops answering puts it in "reconnecting" (the tun stays, so the kill switch
 * keeps blocking) and it retries with backoff. Without any network it does not probe at all and waits
 * for Android to report one. Automatic mode moves to the fastest location that answers; a location the
 * user chose is retried. If Android kills the process it restarts the service (START_STICKY), which
 * connects again when the user had left it on.
 */
class ConnectionService : VpnService() {
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private lateinit var api: NativeApi
    private var nodeId = ""
    // Automatic mode only: the next-fastest nodes, tried when the current one cannot be reached.
    private val fallbacks = mutableListOf<String>()
    private val keyPair = KeyPair()
    private var leaseId = ""
    private var leaseReady = false
    private var deadline = 0L
    private var renewAt = 0L
    private var renewedAt = 0L
    @Volatile private var stopping = false
    private var network = ""
    private var transports = listOf<String>()
    private var carrying = ""
    private var nextProbe = 0L
    /** When the last health probe ran, and when the next one tests every transport instead of the one carrying traffic. */
    private var probedAt = 0L
    private var nextFullProbe = 0L
    private var lastNetworkCheck = 0L
    private var failures = 0
    /** The next full probe reports to the server (the connect probe did not test every transport). */
    private var reportNext = false
    private var notified = ""
    /** The account is read again while connected (traffic runs down): soon after connecting, then every few hours. */
    private var accountAt = 0L
    /** "Traffic running low · 0.8 GB left" under the status in the ongoing notification, or empty. */
    @Volatile private var reminder = ""
    /** The user left the location to the app: when it stops answering, the app moves to the fastest one. */
    private var automatic = true
    /** Started by Android (restart after it killed the process, or always-on VPN), not by a tap. */
    private var restored = false
    @Volatile private var started = false
    /** When WireGuard readiness is next asked for while the lease is not ready yet. */
    private var statusAt = 0L
    @Volatile private var online = true
    @Volatile private var networkChanged = false
    private var retry: ScheduledFuture<*>? = null
    private var callback: ConnectivityManager.NetworkCallback? = null
    /** Screen on: the user may be looking, so the state and rates update every 2 s; off, the service wakes far less. */
    @Volatile private var interactive = true
    private var screen: BroadcastReceiver? = null
    private var nextTick: ScheduledFuture<*>? = null
    private val home by lazy { File(filesDir, "core").path }

    override fun onCreate() {
        super.onCreate(); api = NativeApi(this)
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("vpn", L10n.text(R.string.vpn_connection), NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Not queued behind the worker: a tap while still connecting cancels the attempt at once.
        if (intent?.action == "disconnect") { wanted(this, false); Thread { stopConnection(R.string.disconnected) }.start(); return START_NOT_STICKY }
        if (ConnectionStateStore.active) return START_STICKY
        // A restart after Android killed the process comes without an intent: only if the user had left the VPN on.
        if (intent == null && !wanted(this)) { stopSelf(); return START_NOT_STICKY }
        startForeground(1, notification(L10n.text(R.string.connecting)))
        restored = intent == null || intent.action == VpnService.SERVICE_INTERFACE
        wanted(this, true)
        ConnectionStateStore.active = true; ConnectionStateStore.messageId = R.string.authorizing_and_connecting
        ConnectionStateStore.since = 0L; ConnectionStateStore.rxRate = 0L; ConnectionStateStore.txRate = 0L; ConnectionStateStore.switchedFrom = ""
        ConnectionStateStore.phase = 0; ConnectionStateStore.retryAt = 0L; ConnectionStateStore.attempt = 0; ConnectionStateStore.errorCode = ""
        // Always-on VPN, the tile and a restart start the service without extras: use the location chosen in the app.
        nodeId = intent?.getStringExtra("nodeId") ?: getSharedPreferences("preferences", MODE_PRIVATE).getString("nodeId", "")!!
        automatic = nodeId.isEmpty()
        api.attempt = java.util.UUID.randomUUID().toString().replace("-", "").take(16)
        watchNetwork(); watchScreen()
        worker.execute { begin(0) }
        return START_STICKY
    }
    /**
     * The first connection. One the user started reports its failure and stops; one Android started (the user
     * had left the VPN on) keeps trying with backoff, and at once when a network appears.
     */
    private fun begin(attempt: Int) {
        if (stopping) return
        try {
            network = Transports.networkKey(this); online = Transports.online(this); networkChanged = false
            // The attempt id is also the request id of this attempt's lines in Console → 运行日志.
            Journal.add("connect: start ${api.attempt}, network ${network}, routing ${routing()}" + if (restored) ", restored" else "")
            ConnectionStateStore.phase = 0
            if (automatic) { nodeId = ""; chooseFastest() }
            connect()
            ConnectionStateStore.retryAt = 0L; ConnectionStateStore.attempt = 0
            started = true
            accountAt = SystemClock.elapsedRealtime() + 20000
            scheduleTick(TICK)
            api.report("")
        } catch (e: Exception) {
            // Without a network a tap waits for one too, instead of failing at once.
            if ((!restored && online) || stopping || fatal(e)) { fail(e); return }
            val delay = RETRY[minOf(attempt, RETRY.size - 1)]
            ConnectionStateStore.retryAt = SystemClock.elapsedRealtime() + delay; ConnectionStateStore.attempt = attempt + 1
            Journal.add("connect: failed ${code(e)}, retrying in ${delay / 1000} s")
            ConnectionStateStore.messageId = if (online) R.string.reconnecting_status else R.string.waiting_for_network
            retry = worker.schedule({ begin(attempt + 1) }, delay, TimeUnit.MILLISECONDS)
        }
    }
    /**
     * The tick runs on the worker and schedules the next one itself: every 2 s while the screen is on, or while
     * the connection is being repaired; with the screen off and the connection working, every TICK_IDLE.
     * Network and screen events bring the next tick forward, so waking less never delays a reconnect.
     */
    private fun scheduleTick(delay: Long) {
        if (stopping) return
        nextTick?.cancel(false)
        nextTick = try {
            worker.schedule({ try { tick() } finally { scheduleTick(if (interactive || failures > 0 || !online) TICK else TICK_IDLE) } }, delay, TimeUnit.MILLISECONDS)
        } catch (_: java.util.concurrent.RejectedExecutionException) { null }
    }
    /** From any thread: run the next tick soon instead of at the end of an idle wait. */
    private fun tickSoon(delay: Long) {
        if (!started || stopping) return
        try { worker.execute { scheduleTick(delay) } } catch (_: java.util.concurrent.RejectedExecutionException) { }
    }
    private fun watchScreen() {
        if (screen != null) return
        interactive = getSystemService(PowerManager::class.java).isInteractive
        val watcher = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                interactive = intent.action == Intent.ACTION_SCREEN_ON
                // Back on: a health probe that is overdue by the screen-on interval runs right away.
                if (interactive) tickSoon(0)
            }
        }
        val filter = IntentFilter().apply { addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_SCREEN_OFF) }
        try {
            if (android.os.Build.VERSION.SDK_INT >= 33) registerReceiver(watcher, filter, RECEIVER_NOT_EXPORTED) else registerReceiver(watcher, filter)
            screen = watcher
        } catch (_: Exception) { }
    }
    /** Android reports the network the app uses outside the VPN; the next tick (within a second) acts on it. */
    private fun watchNetwork() {
        if (callback != null) return
        val watcher = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { changed() }
            override fun onLost(network: Network) { changed() }
            private fun changed() {
                networkChanged = true
                tickSoon(1000)
                // Still waiting for a first connection: try now instead of at the end of the backoff.
                if (!started && !stopping && Transports.online(this@ConnectionService) && retry?.cancel(false) == true) {
                    Journal.add("network: available, retrying now"); retry = worker.schedule({ begin(0) }, 2, TimeUnit.SECONDS)
                }
            }
        }
        try { getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(watcher); callback = watcher } catch (_: Exception) { }
    }
    override fun onRevoke() { wanted(this, false); worker.execute { stopConnection(R.string.disconnected) } }
    private fun routing() = getSharedPreferences("preferences", MODE_PRIVATE).getString("routing", "smart")!!
    private fun code(e: Exception) = when (e) { is ApiFailure -> e.code; is Unreachable -> "HANDSHAKE_TIMEOUT"; else -> "CONNECT_FAILED" }
    /** Refusals that retrying cannot fix: the account, this device, or the VPN permission. */
    private fun fatal(e: Exception) = (e as? ApiFailure)?.code in FATAL
    private fun fail(e: Exception) {
        if (stopping) { Journal.add("connect: cancelled"); return }
        wanted(this, false)
        // Unexpected errors keep their (scrubbed) text: a class name alone like "proxyerror" says too little.
        val detail = if (e !is ApiFailure && e !is Unreachable) listOf(e.javaClass.simpleName, Journal.scrub(e.message)).filter { it.isNotEmpty() }.joinToString(": ") else ""
        Journal.add("connect: failed ${code(e)}" + if (detail.isNotEmpty()) " ($detail)" else "")
        api.report(code(e), nodeId, detail)
        ConnectionStateStore.errorCode = code(e)
        stopConnection(if (e is Unreachable) R.string.this_location_is_not_responding_try_another else friendlyResource(e))
    }
    /** Measured before the tunnel exists; if the list cannot be loaded the server picks the least-loaded node. */
    private fun chooseFastest() {
        // Measurements from the last minute (the location list) are reused, so connecting does not probe again.
        // The list this loads is saved too: the location page then opens with it, already fresh.
        NodeCache.restore(this)
        val ranked = try {
            val nodes = api.request("nodes").getJSONArray("nodes"); NodeCache.save(this, nodes)
            Latency.rank(nodes, attempts = 3, reuseMs = 60000, settleMs = SETTLE).also { NodeCache.saveMeasured(this) }
        } catch (_: Exception) { emptyList() }
        ranked.take(3).forEach { (node, quality) -> Journal.add("probe: ${node.optString("name")} ${quality.latency?.let { "${it} ms" } ?: "no answer"}, jitter ${quality.jitter} ms, loss ${quality.loss}%") }
        nodeId = ranked.firstOrNull()?.first?.getString("id") ?: ""
        fallbacks.clear(); fallbacks.addAll(ranked.drop(1).take(2).map { it.first.getString("id") })
    }
    /** Connects to nodeId; in automatic mode a node that cannot be used is replaced by the next fastest one. */
    private fun connect() {
        while (true) {
            try { bringUp(); return } catch (e: Exception) {
                if (stopping) throw e
                val replaceable = e is Unreachable || (e as? ApiFailure)?.code in listOf("NODE_UNAVAILABLE", "NODE_FULL")
                if (!replaceable || !nextNode(code(e))) throw e
            }
        }
    }
    private fun nextNode(code: String): Boolean {
        if (fallbacks.isEmpty()) return false
        Journal.add("switch: ${ConnectionStateStore.node} failed ($code), trying the next location")
        ConnectionStateStore.switchedFrom = ConnectionStateStore.node
        api.report(code, nodeId)
        nodeId = fallbacks.removeAt(0); ConnectionStateStore.messageId = R.string.authorizing_and_connecting
        ConnectionStateStore.since = 0L; ConnectionStateStore.rxRate = 0L; ConnectionStateStore.txRate = 0L
        return true
    }
    private fun bringUp() {
        val started = SystemClock.elapsedRealtime()
        ConnectionStateStore.phase = 1
        val lease = acquire(initial = true)
        val proxies = listOf(Transports.wireguard(lease, keyPair.privateKey.toBase64())) +
            lease.optJSONArray("proxies").let { list -> (0 until (list?.length() ?: 0)).map { list!!.getJSONObject(it) } }
            .filter { it.optString("name") in Transports.ladder }
        val blocked = Transports.blocked(this, network)
        transports = Transports.order(proxies.map { it.getString("name") }, blocked)
        ConnectionStateStore.lines = transports.size
        Journal.add("node: ${ConnectionStateStore.node}, transports ${transports.joinToString(" > ")}" + if (blocked.isNotEmpty()) " (blocked here before: ${blocked.joinToString()})" else "")
        Core.stop()
        val tun = Builder().setSession("TrackNothing").setMtu(1500)
            .addAddress("198.18.0.1", 30).addAddress("fdfe:dcba:9876::1", 126)
            .addRoute("0.0.0.0", 0).addRoute("::", 0).addDnsServer("198.18.0.2")
            .apply { if (android.os.Build.VERSION.SDK_INT >= 29) setMetered(false) }
            // This app stays outside the tun (its own API calls and the core's dials); per-app routing may leave out more.
            .also { Journal.add("apps: " + AppRouting.apply(this, it)) }
            .establish() ?: throw ApiFailure("VPN_PERMISSION_REQUIRED")
        // mihomo owns the descriptor from here and closes it on stop.
        Core.run(home, Transports.options(proxies, transports, tun.detachFd(), routing() == "smart"))
        if (stopping) { Core.stop(); throw ApiFailure("CANCELLED") }
        ConnectionStateStore.phase = 2
        if (!probe(initial = true)) {
            // WireGuard waits for the node to add this device; give it the rest of the readiness window.
            while (!leaseReady && SystemClock.elapsedRealtime() - started < 15000) { Thread.sleep(1000); leaseReady = status() }
            if (!leaseReady || !probe(initial = true)) throw Unreachable()
        }
        if (stopping) { Core.stop(); throw ApiFailure("CANCELLED") }
        ConnectionStateStore.messageId = R.string.connected_status; ConnectionStateStore.since = SystemClock.elapsedRealtime()
        Journal.add("connect: ready in ${SystemClock.elapsedRealtime() - started} ms via ${carrying.ifEmpty { "?" }}")
        // The connect probe stopped at the first transport: test them all shortly, off the connect path, for the
        // transport memory and the report to the server.
        probedAt = SystemClock.elapsedRealtime(); nextProbe = probedAt + FULL_PROBE; nextFullProbe = 0; reportNext = true
    }
    /**
     * All transports at once; true when at least one answers. Failures are remembered only when another transport worked.
     * The connect probe (initial) returns as soon as traffic has a transport (Core.probeFirst); the others are not waited for.
     */
    private fun probe(initial: Boolean = false, report: Boolean = false): Boolean {
        val names = transports.joinToString(",")
        val results = Transports.parseProbe(if (initial) Core.probeFirst(names, Transports.GROUP, Transports.TEST_URL, 5000) else Core.probe(names, Transports.TEST_URL, 5000))
        val working = results.filterValues { it >= 0 }.keys
        // WireGuard cannot answer before the node has applied this device; that is not a block.
        val failed = results.filterValues { it < 0 }.keys.filter { it != "wireguard" || leaseReady }
        if (initial || failed.isNotEmpty()) Journal.add("probe: " + transports.joinToString(", ") { name -> results[name]?.let { if (it >= 0) "$name $it ms" else "$name no answer" } ?: "$name not waited for" })
        if (working.isNotEmpty()) Transports.remember(this, network, failed, working)
        // Tells the server which of this node's ports answer from here (Console: 云防火墙); off the connect path.
        if ((report || reportNext) && !initial && working.isNotEmpty()) {
            reportNext = false
            val summary = (working.map { "$it=ok" } + failed.map { "$it=fail" }).joinToString(",")
            val node = nodeId; val key = network
            Thread { api.report("TRANSPORT_PROBE", node, summary, key) }.start()
        }
        updateCarrying()
        return working.isNotEmpty()
    }
    /**
     * The round while connected. Usually one request through the transport carrying traffic; every transport
     * (for the transport memory, and so the fallback group can return to a better one) after connecting, on a new
     * network, while repairing, and every FULL_EVERY. When the carrying one does not answer, all are tested at once,
     * so the group can move to another before this counts as a missed round.
     */
    private fun healthy(): Boolean {
        val now = SystemClock.elapsedRealtime()
        val current = carrying
        if (failures == 0 && current.isNotEmpty() && current in transports && now < nextFullProbe) {
            val answered = Transports.parseProbe(Core.probe(current, Transports.TEST_URL, 5000))[current]?.let { it >= 0 } == true
            if (answered) { updateCarrying(); return true }
            Journal.add("probe: $current no answer, testing every transport")
        }
        nextFullProbe = now + FULL_EVERY
        return probe()
    }
    private fun updateCarrying() {
        val now = Core.now(Transports.GROUP)
        if (now.isNotEmpty() && now != carrying) { if (carrying.isNotEmpty()) Journal.add("transport: $carrying -> $now"); carrying = now }
    }
    private fun status(): Boolean = try { api.request("status/$leaseId").getBoolean("ready") } catch (_: Exception) { false }
    /**
     * A lease for this device on nodeId. A first connection with other transports does not wait for WireGuard
     * (they carry traffic until it is ready; tick switches then); without them it waits up to 15 s.
     */
    private fun acquire(initial: Boolean = false): JSONObject {
        val input = JSONObject().put("publicKey", keyPair.publicKey.toBase64())
        if (nodeId.isNotEmpty()) input.put("nodeId", nodeId)
        val lease = api.action("connect", input)
        nodeId = lease.getString("nodeId"); ConnectionStateStore.nodeId = nodeId
        val remaining = (Instant.parse(lease.getString("expiresAt")).toEpochMilli() - System.currentTimeMillis()).coerceAtMost(300000)
        if (remaining <= 0) throw ApiFailure("ACCESS_EXPIRED")
        deadline = SystemClock.elapsedRealtime() + remaining; renewAt = SystemClock.elapsedRealtime() + RENEW; renewedAt = SystemClock.elapsedRealtime()
        ConnectionStateStore.node = lease.getString("nodeName")
        leaseId = lease.getString("leaseId"); leaseReady = lease.optBoolean("ready")
        if (!initial) { if (!leaseReady) leaseReady = status(); return lease }
        val spare = (lease.optJSONArray("proxies")?.length() ?: 0) > 0
        for (attempt in 0 until if (spare) 0 else 15) {
            if (leaseReady) break
            if (SystemClock.elapsedRealtime() >= deadline) throw ApiFailure("ACCESS_EXPIRED")
            Thread.sleep(1000); leaseReady = status()
        }
        if (!leaseReady && !spare) throw ApiFailure("NODE_UNAVAILABLE")
        Journal.add("lease: ${if (leaseReady) "WireGuard ready" else "WireGuard pending, starting on the other transports"}")
        return lease
    }
    private fun tick() {
        if (stopping) return
        val now = SystemClock.elapsedRealtime()
        try {
            // Android's network callback, with a 30 s check as a safety net (some changes keep the same default network).
            if (networkChanged || now - lastNetworkCheck > 30000) { lastNetworkCheck = now; networkChanged = false; checkNetwork(now) }
            // A refusal (account, device, quota) closes the tunnel. When the server cannot be reached the tunnel
            // stays while it still carries traffic, up to OFFLINE_GRACE after the last renewal; probes decide.
            if (online && now >= renewAt) {
                val again = now + if (now - renewedAt < 300000) 15000 else 60000
                try { acquire() } catch (e: ApiFailure) {
                    if (e.code in FATAL) { fail(e); return }
                    Journal.add("lease: renewal failed (${e.code}), retrying"); renewAt = again
                } catch (_: Exception) { renewAt = again }
            } else if (online && !leaseReady && now >= statusAt) {
                // WireGuard became usable: test it now so the fallback group can count on it without waiting for the next round.
                // Every tick for the first minute (it is usually ready within seconds), then once a minute: a node whose
                // WireGuard never applies must not cost a request every 2 s for as long as the VPN stays on.
                statusAt = now + if (now - ConnectionStateStore.since < 60000) 0 else 60000
                if (status()) { leaseReady = true; Journal.add("lease: WireGuard ready"); probe(report = true) }
            }
            if (SystemClock.elapsedRealtime() - renewedAt >= OFFLINE_GRACE) { Journal.add("lease: expired"); api.report("LEASE_RENEWAL_FAILED", nodeId); wanted(this, false); ConnectionStateStore.errorCode = "LEASE_EXPIRED"; stopConnection(R.string.connection_authorization_expired_connect_again); return }
            if (!online) {
                // Nothing to reach: no probes (they would only drain the battery) until Android reports a network.
                ConnectionStateStore.messageId = R.string.waiting_for_network
            } else if (now >= nextProbe || (interactive && failures == 0 && now - probedAt >= HEALTHY)) {
                probedAt = now
                if (healthy()) {
                    if (failures >= 2) Journal.add("reconnect: ${ConnectionStateStore.node} answers again via ${carrying.ifEmpty { "?" }}")
                    failures = 0; nextProbe = SystemClock.elapsedRealtime() + if (interactive) HEALTHY else HEALTHY_IDLE
                } else missed()
                ConnectionStateStore.messageId = message()
            } else updateCarrying()
            ConnectionStateStore.attempt = failures; ConnectionStateStore.retryAt = if (failures > 0) nextProbe else 0L
            Core.rate().split(' ').let { (up, down) -> ConnectionStateStore.txRate = up.toLong(); ConnectionStateStore.rxRate = down.toLong() }
        } catch (e: Exception) {
            // Never a reason to give up: count it as a failed round and try again later.
            val detail = listOf(e.javaClass.simpleName, Journal.scrub(e.message)).filter { it.isNotEmpty() }.joinToString(": ")
            Journal.add("tunnel: error $detail")
            if (failures == 0) api.report("TUNNEL_ERROR", nodeId, detail)
            failures++; nextProbe = SystemClock.elapsedRealtime() + backoff(); ConnectionStateStore.messageId = message()
        }
        if (online && SystemClock.elapsedRealtime() >= accountAt) checkAccount()
        val text = ConnectionStateStore.message
        if (text + reminder != notified) { notified = text + reminder; getSystemService(NotificationManager::class.java).notify(1, notification(text)) }
    }
    /** Online state, transport memory key, and a clean start on a new network: old connections would hang. */
    private fun checkNetwork(now: Long) {
        val wasOnline = online; online = Transports.online(this)
        val current = Transports.networkKey(this)
        if (current == network && online == wasOnline) return
        Journal.add(if (online) "network: changed to $current" else "network: none")
        network = current
        if (!online) return
        try { Core.reset() } catch (_: Exception) { }
        // Retry right away and restart the backoff; a renewal that failed meanwhile is due now too.
        nextProbe = 0; nextFullProbe = 0; failures = minOf(failures, 1)
        if (now - renewedAt > 90000) renewAt = 0
    }
    /** A round where no transport answered while the device has a network. */
    private fun missed() {
        failures++; nextProbe = SystemClock.elapsedRealtime() + backoff()
        if (failures < 2) return
        if (failures == 2) { Journal.add("probe: no transport answers, reconnecting"); api.report("HANDSHAKE_TIMEOUT", nodeId) }
        if (automatic) moveToFastest()
    }
    /** Automatic mode: measures every location now and moves to the fastest one that answers, if it is another. */
    private fun moveToFastest() {
        val ranked = try { Latency.rank(api.request("nodes").getJSONArray("nodes"), attempts = 1, settleMs = SETTLE) } catch (_: Exception) { emptyList() }
        val best = ranked.firstOrNull { it.second.latency != null }?.first ?: run { Journal.add("switch: no location answers, retrying"); return }
        val id = best.getString("id")
        if (id == nodeId) return
        Journal.add("switch: ${ConnectionStateStore.node} failed (HANDSHAKE_TIMEOUT), moving to ${best.optString("name")}")
        val from = ConnectionStateStore.node; val previous = nodeId
        nodeId = id
        try {
            bringUp(); ConnectionStateStore.switchedFrom = from
            failures = 0
        } catch (e: Exception) {
            if (fatal(e)) { fail(e); return }
            // The lease request did not reach the server: the tunnel still runs on the previous location.
            if (e !is Unreachable) nodeId = previous
            Journal.add("switch: failed ${code(e)}, retrying")
        }
    }
    private fun backoff() = RETRY[minOf(maxOf(failures - 1, 0), RETRY.size - 1)]
    private fun message() = when {
        !online -> R.string.waiting_for_network
        failures == 0 -> R.string.connected_status
        failures == 1 -> R.string.confirming_connection_status
        automatic -> R.string.reconnecting_status
        else -> R.string.location_retrying
    }
    /** Traffic left and the end date, for the reminder line and the once-per-step notifications. */
    private fun checkAccount() {
        accountAt = SystemClock.elapsedRealtime() + try {
            val access = AccountAccess.from(api.request("account"))
            reminder = access.line { android.text.format.Formatter.formatShortFileSize(this, it) } ?: ""
            AccessReminders.check(this, access)
            ACCOUNT_CHECK
        } catch (_: Exception) { 600000L }
    }
    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, ConnectionService::class.java).setAction("disconnect"), PendingIntent.FLAG_IMMUTABLE)
        // Something is running out: the status becomes the title and the reminder the line under it, in amber.
        val line = reminder
        val (title, body) = if (line.isEmpty()) "TrackNothing" to text else text to android.text.SpannableString(line).apply { setSpan(android.text.style.ForegroundColorSpan(Palette.fair), 0, length, 0) }
        return Notification.Builder(this, "vpn").setContentTitle(title).setContentText(body).setSmallIcon(R.drawable.ic_stat_mark).setContentIntent(open).setOngoing(true).addAction(Notification.Action.Builder(null, L10n.text(R.string.disconnect_status), stop).build()).build()
    }
    @Synchronized private fun stopConnection(message: Int) {
        if (stopping) return
        stopping = true
        retry?.cancel(false); nextTick?.cancel(false)
        screen?.let { try { unregisterReceiver(it) } catch (_: Exception) { } }; screen = null
        callback?.let { try { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } catch (_: Exception) { } }; callback = null
        try { Core.stop() } catch (_: Exception) { }
        Journal.add("disconnect: ${resources.getResourceEntryName(message)}")
        ConnectionStateStore.active = false; ConnectionStateStore.messageId = message
        ConnectionStateStore.since = 0L; ConnectionStateStore.rxRate = 0L; ConnectionStateStore.txRate = 0L
        try { api.action("disconnect", JSONObject()) } catch (_: Exception) { }
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    companion object {
        /** Keep a working tunnel this long when the server cannot be reached to renew the lease; the node keeps the lease as long. */
        private const val OFFLINE_GRACE = 12 * 3600 * 1000L
        /** Probe interval while the connection works; the core's fallback group reacts to failed dials in between. */
        private const val HEALTHY = 120000L
        /** The same with the screen off: phones are mostly idle then, and each probe wakes the radio. */
        private const val HEALTHY_IDLE = 300000L
        /** How often a working connection tests every transport rather than only the one carrying traffic. */
        private const val FULL_EVERY = 30 * 60000L
        /** Tick interval with the screen on, and with it off while the connection works. */
        private const val TICK = 2000L
        private const val TICK_IDLE = 20000L
        /** Lease renewal after a successful one. The server's lease lasts 300 s; failures retry every 15 s. */
        private const val RENEW = 150000L
        /** How often the account is read again while connected. */
        private const val ACCOUNT_CHECK = 3 * 3600 * 1000L
        /** After connecting, when every transport is tested (the connect probe stops at the first that works). */
        private const val FULL_PROBE = 10000L
        /** Connecting in automatic mode stops measuring locations this long after the first one answered. */
        private const val SETTLE = 1500L
        /** Waits between retries while nothing answers; the last repeats for as long as the user leaves the VPN on. */
        private val RETRY = longArrayOf(5000, 15000, 30000, 60000, 300000)
        private val FATAL = setOf("AUTH_REQUIRED", "DEVICE_REVOKED", "DEVICE_LIMIT_REACHED", "MEMBERSHIP_EXPIRED", "QUOTA_EXHAUSTED", "ACCOUNT_UNAVAILABLE", "MANAGED_ACCESS_REQUIRED", "CLIENT_UPDATE_REQUIRED", "VPN_PERMISSION_REQUIRED")
        /** Status lines shown in place of the rates while connected. */
        val NOTICES = setOf(R.string.confirming_connection_status, R.string.reconnecting_status, R.string.waiting_for_network, R.string.location_retrying)
        /** Whether the user left the VPN on: read when Android restarts the service after killing the process. */
        fun wanted(context: Context): Boolean = context.getSharedPreferences("preferences", Context.MODE_PRIVATE).getBoolean("vpnWanted", false)
        fun wanted(context: Context, on: Boolean) { context.getSharedPreferences("preferences", Context.MODE_PRIVATE).edit().putBoolean("vpnWanted", on).apply() }
    }
    override fun onDestroy() {
        worker.shutdownNow()
        try { Core.stop() } catch (_: Exception) { }
        ConnectionStateStore.active = false; super.onDestroy()
    }
}
