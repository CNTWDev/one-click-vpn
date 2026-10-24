package com.veilbird.client

import android.app.*
import android.content.Intent
import android.net.VpnService
import android.os.SystemClock
import com.veilbird.core.Core
import com.wireguard.crypto.KeyPair
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.concurrent.Executors
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
}

/** Thrown when no transport of a node answers from this network. */
private class Unreachable : Exception()

/**
 * The VPN: Android's tun goes to the embedded mihomo core, which carries traffic over the first
 * transport of the node that answers (see Transports). The app's own sockets stay outside the
 * tun, so the core's connections to nodes and the API calls use the underlying network.
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
    private var stopping = false
    private var network = ""
    private var transports = listOf<String>()
    private var carrying = ""
    private var lastProbe = 0L
    private var lastNetworkCheck = 0L
    private var failures = 0
    private var notified = ""
    private val home by lazy { File(filesDir, "core").path }

    override fun onCreate() {
        super.onCreate(); api = NativeApi(this)
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("vpn", L10n.text(R.string.vpn_connection), NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "disconnect") { worker.execute { stopConnection(R.string.disconnected) }; return START_NOT_STICKY }
        if (ConnectionStateStore.active) return START_NOT_STICKY
        startForeground(1, notification(L10n.text(R.string.connecting)))
        ConnectionStateStore.active = true; ConnectionStateStore.messageId = R.string.authorizing_and_connecting
        ConnectionStateStore.since = 0L; ConnectionStateStore.rxRate = 0L; ConnectionStateStore.txRate = 0L
        // Always-on VPN starts the service without extras: use the location chosen in the app.
        nodeId = intent?.getStringExtra("nodeId") ?: getSharedPreferences("preferences", MODE_PRIVATE).getString("nodeId", "")!!
        worker.execute {
            try {
                network = Transports.networkKey(this)
                Journal.add("connect: start, network ${network}, routing ${routing()}")
                if (nodeId.isEmpty()) chooseFastest()
                connect()
                worker.scheduleWithFixedDelay({ tick() }, 2, 2, TimeUnit.SECONDS)
                api.report("")
            } catch (e: Exception) { fail(e) }
        }
        return START_NOT_STICKY
    }
    override fun onRevoke() { worker.execute { stopConnection(R.string.disconnected) } }
    private fun routing() = getSharedPreferences("preferences", MODE_PRIVATE).getString("routing", "smart")!!
    private fun code(e: Exception) = when (e) { is ApiFailure -> e.code; is Unreachable -> "HANDSHAKE_TIMEOUT"; else -> "CONNECT_FAILED" }
    private fun fail(e: Exception) {
        Journal.add("connect: failed ${code(e)}" + if (e !is ApiFailure && e !is Unreachable) " (${e.javaClass.simpleName})" else "")
        api.report(code(e), nodeId)
        stopConnection(if (e is Unreachable) R.string.this_location_is_not_responding_try_another else friendlyResource(e))
    }
    /** Measured before the tunnel exists; if the list cannot be loaded the server picks the least-loaded node. */
    private fun chooseFastest() {
        val ranked = try { Latency.rank(api.request("nodes").getJSONArray("nodes"), attempts = 3) } catch (_: Exception) { emptyList() }
        ranked.take(3).forEach { (node, quality) -> Journal.add("probe: ${node.optString("name")} ${quality.latency?.let { "${it} ms" } ?: "no answer"}, jitter ${quality.jitter} ms, loss ${quality.loss}%") }
        nodeId = ranked.firstOrNull()?.first?.getString("id") ?: ""
        fallbacks.clear(); fallbacks.addAll(ranked.drop(1).take(2).map { it.first.getString("id") })
    }
    /** Connects to nodeId; in automatic mode a node that cannot be used is replaced by the next fastest one. */
    private fun connect() {
        while (true) {
            try { bringUp(); return } catch (e: Exception) {
                val replaceable = e is Unreachable || (e as? ApiFailure)?.code in listOf("NODE_UNAVAILABLE", "NODE_FULL")
                if (!replaceable || !nextNode(code(e))) throw e
            }
        }
    }
    private fun nextNode(code: String): Boolean {
        if (fallbacks.isEmpty()) return false
        Journal.add("switch: ${ConnectionStateStore.node} failed ($code), trying the next location")
        api.report(code, nodeId)
        nodeId = fallbacks.removeAt(0); ConnectionStateStore.messageId = R.string.authorizing_and_connecting
        ConnectionStateStore.since = 0L; ConnectionStateStore.rxRate = 0L; ConnectionStateStore.txRate = 0L
        return true
    }
    private fun bringUp() {
        val started = SystemClock.elapsedRealtime()
        val lease = acquire(initial = true)
        val proxies = listOf(Transports.wireguard(lease, keyPair.privateKey.toBase64())) +
            lease.optJSONArray("proxies").let { list -> (0 until (list?.length() ?: 0)).map { list!!.getJSONObject(it) } }
            .filter { it.optString("name") in Transports.ladder }
        val blocked = Transports.blocked(this, network)
        transports = Transports.order(proxies.map { it.getString("name") }, blocked)
        Journal.add("node: ${ConnectionStateStore.node}, transports ${transports.joinToString(" > ")}" + if (blocked.isNotEmpty()) " (blocked here before: ${blocked.joinToString()})" else "")
        Core.stop()
        val tun = Builder().setSession("TrackNothing").setMtu(1500)
            .addAddress("198.18.0.1", 30).addAddress("fdfe:dcba:9876::1", 126)
            .addRoute("0.0.0.0", 0).addRoute("::", 0).addDnsServer("198.18.0.2")
            .addDisallowedApplication(packageName)
            .apply { if (android.os.Build.VERSION.SDK_INT >= 29) setMetered(false) }
            .establish() ?: throw ApiFailure("VPN_PERMISSION_REQUIRED")
        // mihomo owns the descriptor from here and closes it on stop.
        Core.start(home, Transports.config(proxies, transports, tun.detachFd(), routing() == "smart"))
        if (!probe(initial = true)) {
            // WireGuard waits for the node to add this device; give it the rest of the readiness window.
            while (!leaseReady && SystemClock.elapsedRealtime() - started < 15000) { Thread.sleep(1000); leaseReady = status() }
            if (!leaseReady || !probe(initial = true)) throw Unreachable()
        }
        ConnectionStateStore.messageId = R.string.connected_status; ConnectionStateStore.since = SystemClock.elapsedRealtime()
        Journal.add("connect: ready in ${SystemClock.elapsedRealtime() - started} ms via ${carrying.ifEmpty { "?" }}")
    }
    /** All transports at once; true when at least one answers. Failures are remembered only when another transport worked. */
    private fun probe(initial: Boolean = false): Boolean {
        val results = Transports.parseProbe(Core.probe(transports.joinToString(","), Transports.TEST_URL, 5000))
        lastProbe = SystemClock.elapsedRealtime()
        val working = results.filterValues { it >= 0 }.keys
        // WireGuard cannot answer before the node has applied this device; that is not a block.
        val failed = results.filterValues { it < 0 }.keys.filter { it != "wireguard" || leaseReady }
        if (initial || failed.isNotEmpty()) Journal.add("probe: " + transports.joinToString(", ") { name -> results[name]?.takeIf { it >= 0 }?.let { "$name $it ms" } ?: "$name no answer" })
        if (working.isNotEmpty()) Transports.remember(this, network, failed, working)
        updateCarrying()
        return working.isNotEmpty()
    }
    private fun updateCarrying() {
        val now = Core.now(Transports.GROUP)
        if (now.isNotEmpty() && now != carrying) { if (carrying.isNotEmpty()) Journal.add("transport: $carrying -> $now"); carrying = now }
    }
    private fun status(): Boolean = try { api.request("status/$leaseId").getBoolean("ready") } catch (_: Exception) { false }
    /**
     * A lease for this device on nodeId. A first connection with other transports waits briefly for
     * WireGuard to be ready; without them it waits up to 15 s. Renewals only check readiness.
     */
    private fun acquire(initial: Boolean = false): JSONObject {
        val input = JSONObject().put("publicKey", keyPair.publicKey.toBase64())
        if (nodeId.isNotEmpty()) input.put("nodeId", nodeId)
        val lease = api.action("connect", input)
        nodeId = lease.getString("nodeId"); ConnectionStateStore.nodeId = nodeId
        val remaining = (Instant.parse(lease.getString("expiresAt")).toEpochMilli() - System.currentTimeMillis()).coerceAtMost(300000)
        if (remaining <= 0) throw ApiFailure("ACCESS_EXPIRED")
        deadline = SystemClock.elapsedRealtime() + remaining; renewAt = SystemClock.elapsedRealtime() + 90000
        ConnectionStateStore.node = lease.getString("nodeName")
        leaseId = lease.getString("leaseId"); leaseReady = lease.optBoolean("ready")
        if (!initial) { if (!leaseReady) leaseReady = status(); return lease }
        val spare = (lease.optJSONArray("proxies")?.length() ?: 0) > 0
        for (attempt in 0 until if (spare) 3 else 15) {
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
        try {
            val now = SystemClock.elapsedRealtime()
            // After Doze the lease may already have lapsed: one renewal attempt before closing the tunnel.
            if (now >= renewAt || now >= deadline) {
                try { acquire() } catch (e: ApiFailure) {
                    if (e.code in listOf("AUTH_REQUIRED", "DEVICE_REVOKED", "MEMBERSHIP_EXPIRED", "ACCOUNT_UNAVAILABLE", "MANAGED_ACCESS_REQUIRED", "CLIENT_UPDATE_REQUIRED")) { fail(e); return }
                    Journal.add("lease: renewal failed (${e.code}), retrying"); renewAt = now + 15000
                } catch (_: Exception) { renewAt = now + 15000 }
                if (SystemClock.elapsedRealtime() >= deadline) { Journal.add("lease: expired"); api.report("LEASE_RENEWAL_FAILED", nodeId); stopConnection(R.string.connection_authorization_expired_connect_again); return }
            } else if (!leaseReady) {
                // WireGuard became usable: test it now so traffic moves to the lightest transport without waiting for the next round.
                if (status()) { leaseReady = true; Journal.add("lease: WireGuard ready"); probe() }
            }
            if (now - lastNetworkCheck > 30000) {
                lastNetworkCheck = now
                val current = Transports.networkKey(this)
                if (current != network) { Journal.add("network: changed to $current"); network = current; lastProbe = 0 }
            }
            if (now - lastProbe > 30000) {
                if (probe()) failures = 0
                else if (++failures >= 2) {
                    Journal.add("probe: no transport answers")
                    if (nextNode("HANDSHAKE_TIMEOUT")) { try { connect(); failures = 0 } catch (e: Exception) { fail(e) }; return }
                    api.report("HANDSHAKE_TIMEOUT", nodeId); stopConnection(R.string.this_location_is_not_responding_try_another); return
                }
                ConnectionStateStore.messageId = if (failures == 0) R.string.connected_status else R.string.confirming_connection_status
            } else updateCarrying()
            Core.rate().split(' ').let { (up, down) -> ConnectionStateStore.txRate = up.toLong(); ConnectionStateStore.rxRate = down.toLong() }
            val text = ConnectionStateStore.message
            if (text != notified) { notified = text; getSystemService(NotificationManager::class.java).notify(1, notification(text)) }
        } catch (e: Exception) { Journal.add("tunnel: error ${e.javaClass.simpleName}"); api.report("TUNNEL_ERROR", nodeId); stopConnection(R.string.connection_interrupted_try_again) }
    }
    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, ConnectionService::class.java).setAction("disconnect"), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, "vpn").setContentTitle("TrackNothing").setContentText(text).setSmallIcon(android.R.drawable.ic_lock_lock).setContentIntent(open).setOngoing(true).addAction(Notification.Action.Builder(null, L10n.text(R.string.disconnect_status), stop).build()).build()
    }
    private fun stopConnection(message: Int) {
        if (stopping) return
        stopping = true
        try { Core.stop() } catch (_: Exception) { }
        Journal.add("disconnect: ${resources.getResourceEntryName(message)}")
        ConnectionStateStore.active = false; ConnectionStateStore.messageId = message
        ConnectionStateStore.since = 0L; ConnectionStateStore.rxRate = 0L; ConnectionStateStore.txRate = 0L
        try { api.action("disconnect", JSONObject()) } catch (_: Exception) { }
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    override fun onDestroy() {
        worker.shutdownNow()
        try { Core.stop() } catch (_: Exception) { }
        ConnectionStateStore.active = false; super.onDestroy()
    }
}
