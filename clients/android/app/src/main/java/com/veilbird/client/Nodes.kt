package com.veilbird.client

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The location list and this device's measurements as last loaded, kept on the device: the list page shows them at
 * once (also right after launch); a background refresh replaces them and a failed one keeps them. Cleared on sign-out.
 */
object NodeCache {
    /**
     * The list changes rarely and people refresh it by hand: it is loaded once when the app starts, and again when the
     * app comes back after this long (it can stay open for days). Opening the list page does not load it.
     */
    const val RESUME_MS = 6 * 3_600_000L
    private const val PREFS = "node-cache"
    @Volatile private var nodes: JSONArray? = null
    @Volatile var loadedAt = 0L
        private set
    @Volatile private var restored = false

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Reads the saved list and measurements once per process. */
    fun restore(context: Context) {
        if (restored) return
        synchronized(this) {
            if (restored) return
            val prefs = prefs(context)
            nodes = prefs.getString("nodes", null)?.let { try { JSONArray(it) } catch (_: Exception) { null } }
            loadedAt = if (nodes != null) prefs.getLong("at", 0L) else 0L
            nodes?.let { Directory.remember(it) }
            prefs.getString("measured", null)?.let { Latency.restore(it) }
            restored = true
        }
    }
    fun nodes(context: Context): JSONArray? { restore(context); return nodes }
    fun save(context: Context, list: JSONArray) {
        nodes = list; loadedAt = System.currentTimeMillis(); Directory.remember(list)
        prefs(context).edit().putString("nodes", list.toString()).putLong("at", loadedAt).apply()
    }
    fun saveMeasured(context: Context) { prefs(context).edit().putString("measured", Latency.snapshot()).apply() }
    fun clear(context: Context) {
        nodes = null; loadedAt = 0L; restored = true
        Latency.recent.clear(); Latency.forget()
        Directory.nodes.clear(); Directory.probes.clear(); Directory.regions.clear(); Directory.tests.clear()
        prefs(context).edit().clear().apply()
    }
}

internal fun Quality.toJson(): JSONObject = JSONObject().apply {
    put("latency", latency ?: JSONObject.NULL); put("jitter", jitter); put("loss", loss); put("load", load ?: JSONObject.NULL); put("users", users)
    lines?.let { map -> put("lines", JSONObject().apply { map.forEach { (k, v) -> put(k, v) } }) }
}
internal fun qualityFrom(json: JSONObject): Quality = Quality(
    if (json.isNull("latency")) null else json.optLong("latency"), json.optLong("jitter"), json.optInt("loss"),
    if (json.isNull("load")) null else json.optInt("load"), json.optInt("users"),
    json.optJSONObject("lines")?.let { o -> o.keys().asSequence().associateWith { o.optLong(it, -1) } })
