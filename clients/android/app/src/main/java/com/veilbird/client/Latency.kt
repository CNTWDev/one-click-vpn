package com.veilbird.client

import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** "Automatic" location: the lowest TCP connect time to each node's probe port, measured from this device. */
object Latency {
    /** Best of two connects in milliseconds; null when the node has no probe or does not answer. */
    fun measure(node: JSONObject): Long? {
        val probe = node.optJSONObject("probe") ?: return null
        val host = probe.optString("host"); val port = probe.optInt("port")
        if (host.isEmpty() || port !in 1..65535) return null
        var best: Long? = null
        // The first attempt may include DNS; the second is the plain round trip.
        repeat(2) {
            try {
                Socket().use { socket ->
                    val started = System.nanoTime()
                    socket.connect(InetSocketAddress(host, port), 1500)
                    val elapsed = (System.nanoTime() - started) / 1_000_000
                    best = minOf(best ?: elapsed, elapsed)
                }
            } catch (_: Exception) { }
        }
        return best
    }

    /** Fastest first; unmeasured nodes follow in the server's least-loaded order. */
    fun rank(nodes: JSONArray): List<Pair<JSONObject, Long?>> {
        val list = (0 until nodes.length()).map { nodes.getJSONObject(it) }
        if (list.isEmpty()) return emptyList()
        val pool = Executors.newFixedThreadPool(minOf(8, list.size))
        try {
            val pending = list.map { node -> pool.submit<Long?> { measure(node) } }
            return list.zip(pending.map { try { it.get(5, TimeUnit.SECONDS) } catch (_: Exception) { null } })
                .sortedBy { it.second ?: Long.MAX_VALUE }
        } finally { pool.shutdownNow() }
    }
}
