package com.veilbird.client

import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** One node as measured from this device: median TCP connect time, jitter and failed attempts. */
data class Quality(val latency: Long?, val jitter: Long, val loss: Int, val load: Int?) {
    /** Lower is better. Jitter and loss hurt more than a few extra milliseconds; a busy node is a last resort. */
    val score: Long get() = if (latency == null) Long.MAX_VALUE else latency + 2 * jitter + 10L * loss + if ((load ?: 0) >= 85) 150 else 0
    val grade: Int get() = when {
        latency == null -> R.string.quality_unreachable
        score < 150 && loss == 0 -> R.string.quality_good
        score < 300 && loss <= 20 -> R.string.quality_fair
        else -> R.string.quality_poor
    }
}

/** "Automatic" location: the best score from TCP connects to each node's probe port, measured from this device. */
object Latency {
    /** Last measurement per node id, so the home screen can show it without probing again. */
    val recent = java.util.concurrent.ConcurrentHashMap<String, Quality>()

    fun measure(node: JSONObject, attempts: Int = 5): Quality {
        val load = if (node.isNull("load")) null else node.optInt("load", -1).takeIf { it in 0..100 }
        val probe = node.optJSONObject("probe") ?: return Quality(null, 0, 100, load)
        val host = probe.optString("host"); val port = probe.optInt("port")
        if (host.isEmpty() || port !in 1..65535) return Quality(null, 0, 100, load)
        val address = try { InetSocketAddress(host, port).takeIf { !it.isUnresolved } } catch (_: Exception) { null } ?: return Quality(null, 0, 100, load)
        // DNS is resolved once above, so every attempt is a plain round trip.
        val samples = mutableListOf<Long>()
        for (attempt in 0 until attempts) {
            // Two misses in a row with nothing answered: the node is down, stop waiting on it.
            if (attempt == 2 && samples.isEmpty()) return Quality(null, 0, 100, load)
            try {
                Socket().use { socket ->
                    val started = System.nanoTime()
                    socket.connect(address, 1500)
                    samples.add((System.nanoTime() - started) / 1_000_000)
                }
            } catch (_: Exception) { }
        }
        val loss = (attempts - samples.size) * 100 / attempts
        if (samples.isEmpty()) return Quality(null, 0, loss, load)
        val sorted = samples.sorted()
        val jitter = if (samples.size < 2) 0 else samples.zipWithNext { a, b -> kotlin.math.abs(a - b) }.average().toLong()
        return Quality(sorted[sorted.size / 2], jitter, loss, load)
    }

    /** Best first; unmeasured nodes follow in the server's least-loaded order. */
    fun rank(nodes: JSONArray, attempts: Int = 5): List<Pair<JSONObject, Quality>> {
        val list = (0 until nodes.length()).map { nodes.getJSONObject(it) }
        if (list.isEmpty()) return emptyList()
        val pool = Executors.newFixedThreadPool(minOf(16, list.size))
        try {
            val pending = list.map { node -> pool.submit<Quality> { measure(node, attempts) } }
            return list.zip(pending.map { task -> try { task.get(10, TimeUnit.SECONDS) } catch (_: Exception) { Quality(null, 0, 100, null) } })
                .onEach { (node, quality) -> recent[node.getString("id")] = quality }
                .sortedBy { it.second.score }
        } finally { pool.shutdownNow() }
    }

    /** The server's order, unmeasured: used while connected, when probes would run through the tunnel. */
    fun unmeasured(nodes: JSONArray): List<Pair<JSONObject, Quality?>> =
        (0 until nodes.length()).map { nodes.getJSONObject(it) to null }
}
