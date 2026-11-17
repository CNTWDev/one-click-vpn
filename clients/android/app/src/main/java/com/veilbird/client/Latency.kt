package com.veilbird.client

import com.veilbird.core.Core
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** One node as measured from this device: median TCP connect time, jitter and failed attempts. */
data class Quality(val latency: Long?, val jitter: Long, val loss: Int, val load: Int?, val users: Int = 0, val lines: Map<String, Long>? = null) {
    /**
     * Lower is better. Jitter and loss hurt more than a few extra milliseconds. Load above half costs 4 ms per
     * percent (a full node +200 ms) and each connected user 1 ms (at most 50), so close nodes win unless busy.
     */
    val score: Long get() = if (latency == null) Long.MAX_VALUE else latency + 2 * jitter + 10L * loss + maxOf(0, (load ?: 0) - 50) * 4L + minOf(users, 50)
    val grade: Int get() = when {
        latency == null -> R.string.quality_unreachable
        score < 150 && loss == 0 -> R.string.quality_good
        score < 300 && loss <= 20 -> R.string.quality_fair
        else -> R.string.quality_poor
    }
}

/** "Automatic" location: the best score from TCP connects to each node's probe ports, measured from this device. */
object Latency {
    /** Last measurement per node id, so the home screen can show it without probing again. */
    val recent = java.util.concurrent.ConcurrentHashMap<String, Quality>()
    private val measuredAt = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private fun users(node: JSONObject) = node.optInt("users", 0).coerceAtLeast(0)
    /**
     * Long enough for one lost SYN to be resent (1 s) and still answer across a long, lossy route; mihomo's own
     * delay test (what Clash apps show) waits 5 s, so a shorter wait called slow but working nodes unreachable.
     */
    private const val TIMEOUT_MS = 3000
    private val connector = Executors.newCachedThreadPool()

    /** Every TCP port the node answers on (REALITY, XHTTP); older servers only send "probe". */
    fun probes(node: JSONObject): List<Pair<String, Int>> {
        val list = node.optJSONArray("probes")?.let { array -> (0 until array.length()).mapNotNull { array.optJSONObject(it) } }
            ?: listOfNotNull(node.optJSONObject("probe"))
        return list.map { it.optString("host") to it.optInt("port") }.filter { (host, port) -> host.isNotEmpty() && port in 1..65535 }.distinct()
    }

    private fun connect(address: InetSocketAddress): Long? = try {
        Socket().use { socket ->
            val started = System.nanoTime()
            socket.connect(address, TIMEOUT_MS)
            (System.nanoTime() - started) / 1_000_000
        }
    } catch (_: Exception) { null }

    /**
     * Connects to every port at once and takes the first answer: a network that blocks one port (often 443)
     * still reaches the node on the other, as the app's own fallback transports would when connecting.
     */
    private fun race(addresses: List<InetSocketAddress>): Long? {
        if (addresses.size == 1) return connect(addresses[0])
        val done = java.util.concurrent.ExecutorCompletionService<Long?>(connector)
        val tasks = addresses.map { address -> done.submit { connect(address) } }
        try {
            for (i in addresses.indices) {
                val finished = done.poll(TIMEOUT_MS + 500L, TimeUnit.MILLISECONDS) ?: return null
                finished.get()?.let { return it }
            }
            return null
        } finally { tasks.forEach { it.cancel(true) } }
    }

    /** The wait for a request through a transport; mihomo's default, which Clash apps show. */
    private const val REAL_TIMEOUT_MS = 5000

    /**
     * The transports a node can offer, in the order the apps show them as "线路 1…4": Hysteria2 (with port
     * hopping), REALITY on 443, REALITY on the node's spare TCP port, XHTTP. Users only see the numbers; the
     * transport names stay in the hidden log. WireGuard is not listed: it cannot be tested before a lease.
     */
    val lineOrder = listOf("hysteria2", "reality", "reality-alt", "xhttp")

    /** The file the speed test downloads through the current connection (repeated for the test's few seconds). */
    const val SPEED_URL = "https://speed.cloudflare.com/__down?bytes=100000000"

    /** Line numbers (1…4) of a node's transports, from its "test" list; empty when the device has none. */
    fun offered(node: JSONObject): Set<String> = node.optJSONArray("test")?.let { array ->
        (0 until array.length()).mapNotNull { array.optJSONObject(it)?.optString("name") }.filter { it in lineOrder }.toSet()
    } ?: emptySet()

    /**
     * A request to the test page through every transport the device has on this node (the server's "test" list,
     * the lines a connect would use): the fastest answer in ms (-1 when none answers) and each transport's result;
     * null when not measured. This is how Clash apps measure: it sees a node reached only over UDP, and one whose
     * port answers but whose transport is blocked after the handshake.
     */
    fun real(id: String, transports: JSONArray): Pair<Long, Map<String, Long>>? = try {
        val input = JSONObject().put("nodes", JSONObject().put(id, transports)).put("url", Transports.TEST_URL).put("timeoutMs", REAL_TIMEOUT_MS)
        JSONObject(Core.test(input.toString())).optJSONObject(id)?.let { result ->
            val lines = result.optJSONObject("lines")
            result.optLong("ms", -1) to (lines?.keys()?.asSequence()?.associateWith { lines.optLong(it, -1) } ?: emptyMap())
        }
    } catch (_: Throwable) { null }

    /**
     * TCP connects give jitter and loss; the request through the transports, when the device has them, decides
     * whether the node answers and its latency. Devices that never connected (no "test" list) keep the TCP result.
     */
    fun measure(node: JSONObject, attempts: Int = 5): Quality {
        val transports = node.optJSONArray("test")?.takeIf { it.length() > 0 }
        val pending = transports?.let { list -> connector.submit<Pair<Long, Map<String, Long>>?> { real(node.optString("id"), list) } }
        val tcp = measureTcp(node, attempts)
        val (delay, lines) = pending?.let { try { it.get(REAL_TIMEOUT_MS + 3000L, TimeUnit.MILLISECONDS) } catch (_: Exception) { null } } ?: return tcp
        if (lines.isNotEmpty()) Journal.add("lines: ${node.optString("name")} " + lines.entries.joinToString(", ") { (name, ms) -> if (ms >= 0) "$name $ms ms" else "$name no answer" })
        if (delay < 0) return Quality(null, 0, 100, tcp.load, tcp.users, lines)
        return if (tcp.latency != null) tcp.copy(latency = delay, lines = lines) else Quality(delay, 0, 0, tcp.load, tcp.users, lines)
    }

    /**
     * Tells the server which lines answered on this network (the block alerts in Console read it). A node's
     * failures count only when some line somewhere answered, so a phone without internet reports nothing.
     */
    fun report(context: android.content.Context, api: NativeApi, ranked: List<Pair<JSONObject, Quality>>) {
        val measured = ranked.mapNotNull { (node, quality) -> quality.lines?.takeIf { it.isNotEmpty() }?.let { node.optString("id") to it } }
        if (measured.none { (_, lines) -> lines.values.any { it >= 0 } }) return
        val network = Transports.networkKey(context)
        Thread {
            val batch = measured.take(19)
            batch.forEachIndexed { i, (id, lines) ->
                api.report("TRANSPORT_PROBE", id, lines.entries.joinToString(",") { (name, ms) -> "$name=" + if (ms >= 0) "ok" else "fail" }, network, send = i == batch.lastIndex)
            }
        }.start()
    }

    private fun measureTcp(node: JSONObject, attempts: Int): Quality {
        val load = if (node.isNull("load")) null else node.optInt("load", -1).takeIf { it in 0..100 }
        val users = users(node)
        val addresses = probes(node).mapNotNull { (host, port) ->
            try { InetSocketAddress(host, port).takeIf { !it.isUnresolved } } catch (_: Exception) { null }
        }
        if (addresses.isEmpty()) return Quality(null, 0, 100, load, users)
        // DNS is resolved once above, so every attempt is a plain round trip.
        val samples = mutableListOf<Long>()
        for (attempt in 0 until attempts) {
            // Two misses in a row with nothing answered: the node is down, stop waiting on it.
            if (attempt == 2 && samples.isEmpty()) return Quality(null, 0, 100, load, users)
            race(addresses)?.let { samples.add(it) }
        }
        val loss = (attempts - samples.size) * 100 / attempts
        if (samples.isEmpty()) return Quality(null, 0, loss, load, users)
        val sorted = samples.sorted()
        val jitter = if (samples.size < 2) 0 else samples.zipWithNext { a, b -> kotlin.math.abs(a - b) }.average().toLong()
        return Quality(sorted[sorted.size / 2], jitter, loss, load, users)
    }

    /**
     * Best first; unmeasured nodes follow in the server's least-loaded order. A node measured less than reuseMs ago
     * keeps that result (with the current load), so connecting right after the location list does not probe again.
     */
    fun rank(nodes: JSONArray, attempts: Int = 5, reuseMs: Long = 0): List<Pair<JSONObject, Quality>> {
        val list = (0 until nodes.length()).map { nodes.getJSONObject(it) }
        if (list.isEmpty()) return emptyList()
        val pool = Executors.newFixedThreadPool(minOf(16, list.size))
        try {
            val pending = list.map { node -> pool.submit<Quality> {
                val id = node.optString("id"); val known = recent[id]; val at = measuredAt[id] ?: 0L
                val load = if (node.isNull("load")) null else node.optInt("load", -1).takeIf { it in 0..100 }
                if (known != null && System.currentTimeMillis() - at < reuseMs) known.copy(load = load, users = users(node))
                else measure(node, attempts).also { measuredAt[id] = System.currentTimeMillis() }
            } }
            return list.zip(pending.map { task -> try { task.get(25, TimeUnit.SECONDS) } catch (_: Exception) { Quality(null, 0, 100, null) } })
                .onEach { (node, quality) -> recent[node.getString("id")] = quality }
                .sortedBy { it.second.score }
        } finally { pool.shutdownNow() }
    }

    /** The server's order, unmeasured: used while connected, when probes would run through the tunnel. */
    fun unmeasured(nodes: JSONArray): List<Pair<JSONObject, Quality?>> =
        (0 until nodes.length()).map { nodes.getJSONObject(it) to null }
}
