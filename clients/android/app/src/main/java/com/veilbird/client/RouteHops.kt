package com.veilbird.client

import android.os.SystemClock
import com.veilbird.core.Core
import org.json.JSONArray
import org.json.JSONObject

/** A stop on the route globe between this device and the exit; [faint]: the stretch to it was not measured. */
data class RouteStop(val spot: Spot, val faint: Boolean)

/** One line of the path list (kinds as core.Route: local, city, unknown, gap, exit). */
data class RouteRow(val kind: String, val n: Int, val ms: Int, val name: String, val network: String, val border: Boolean)

/** The measured path of one connection: the globe's stops, the list, and the round trip to the node (0: no answer). */
data class RoutePath(val key: String, val stops: List<RouteStop>, val exitFaint: Boolean, val rows: List<RouteRow>, val ms: Int, val at: Long)

/**
 * The path from this phone to its node, outside the tunnel (the app itself is left out of the VPN), measured once a
 * connection is up: the core traces it (core.Trace), the server places the routers' addresses at city level
 * (route-hops, nothing stored) and the core turns both into stops and rows (core.Route). One measure per connection
 * and node; nothing is kept on disk. When it cannot be measured the globe keeps its straight arc.
 */
object RouteHops {
    @Volatile var path: RoutePath? = null
        private set
    @Volatile private var running = ""

    /** Starts a measure for this connection unless one ran or runs; [done] runs on a background thread. */
    fun measure(api: NativeApi, key: String, probes: String, origin: Spot?, exit: Spot, done: () -> Unit) {
        if (path?.key == key || running == key || probes.isEmpty()) return
        running = key
        Thread {
            try {
                // A moment for the connection to settle (the landing on the globe runs meanwhile).
                Thread.sleep(1500)
                if (running != key) return@Thread
                val trace = JSONObject(Core.trace(probes, 2500))
                if (trace.has("error")) { Journal.add("route: not measured (${Journal.scrub(trace.optString("error"))})"); return@Thread }
                val ips = JSONArray()
                trace.optJSONArray("hops")?.let { hops -> for (i in 0 until hops.length()) hops.optJSONObject(i)?.optString("ip")?.takeIf { it.isNotEmpty() }?.let { ips.put(it) } }
                val places = if (ips.length() == 0) JSONObject().put("hops", JSONArray()) else try { api.request("route-hops", JSONObject().put("ips", ips)) } catch (_: Exception) { JSONObject().put("hops", JSONArray()) }
                val input = JSONObject().put("trace", trace).put("places", places).put("exit", JSONObject().put("lat", exit.lat).put("lon", exit.lon))
                origin?.let { input.put("origin", JSONObject().put("lat", it.lat).put("lon", it.lon)) }
                if (running != key) return@Thread
                path = parse(key, JSONObject(Core.route(input.toString())))
                done()
            } catch (_: Exception) {
            } finally { if (running == key) running = "" }
        }.start()
    }

    /** Forgets the path when the connection ends. */
    fun clear() { path = null; running = "" }

    private fun name(names: JSONObject?): String = names?.let { n -> listOf(L10n.locale.language, "en").firstNotNullOfOrNull { n.optString(it).takeIf { v -> v.isNotBlank() } } } ?: ""

    private fun parse(key: String, route: JSONObject): RoutePath {
        val stops = mutableListOf<RouteStop>()
        route.optJSONArray("points")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.let { p -> stops.add(RouteStop(Spot(p.optDouble("lat"), p.optDouble("lon"), name(p.optJSONObject("names"))), p.optBoolean("faint"))) } }
        val rows = mutableListOf<RouteRow>()
        route.optJSONArray("rows")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.let { r ->
            rows.add(RouteRow(r.optString("kind"), r.optInt("n"), r.optInt("ms"), name(r.optJSONObject("names")), r.optString("network"), r.optBoolean("border"))) } }
        return RoutePath(key, stops, route.optBoolean("exitFaint"), rows, route.optInt("ms"), SystemClock.uptimeMillis())
    }

    /** "Shanghai · 158 ms" for the line under the state; empty when there is nothing between you and the exit. */
    fun via(p: RoutePath?): String {
        if (p == null || p.stops.isEmpty()) return ""
        val names = p.stops.map { it.spot.label }.filter { it.isNotEmpty() }.distinct()
        if (names.isEmpty()) return ""
        val tail = if (p.ms > 0) " · " + L10n.text(R.string.latency_ms, L10n.number(p.ms)) else ""
        return L10n.text(R.string.route_via, names.joinToString(" · ") + tail)
    }

    /** The title and the second line of a row in the path list. */
    fun describe(row: RouteRow, exitName: String): Pair<String, String> = when (row.kind) {
        "local" -> L10n.text(R.string.route_local) to ""
        "gap" -> (if (row.n == 0) L10n.text(R.string.route_gap_end) else if (row.n == 1) L10n.text(R.string.route_gap_one) else L10n.text(R.string.route_gap, L10n.number(row.n))) to ""
        "unknown" -> L10n.text(R.string.route_unknown) to row.network
        "exit" -> exitName to L10n.text(R.string.route_exit)
        else -> row.name to listOf(row.network, if (row.border) L10n.text(R.string.route_border) else "").filter { it.isNotEmpty() }.joinToString(" · ")
    }
}
