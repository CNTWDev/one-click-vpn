package com.veilbird.client

import android.content.Context
import org.json.JSONObject

/**
 * Advanced features, hidden until the person turns them on in Account: favorite locations (listed first on the
 * location page) and a per-location protocol lock. Both are kept on this device only.
 */
object Advanced {
    private const val PREFS = "advanced"
    /** The protocols a location can be locked to; "reality" covers REALITY on 443 and on the spare port. */
    val protocols = listOf("hysteria2", "reality", "xhttp", "wireguard")

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun enabled(context: Context) = prefs(context).getBoolean("on", false)
    fun enable(context: Context, on: Boolean) { prefs(context).edit().putBoolean("on", on).apply() }

    fun favorites(context: Context): Set<String> = if (enabled(context)) prefs(context).getStringSet("favorites", emptySet())!!.toSet() else emptySet()
    fun favorite(context: Context, id: String, on: Boolean) {
        val now = prefs(context).getStringSet("favorites", emptySet())!!.toMutableSet()
        if (on) now.add(id) else now.remove(id)
        prefs(context).edit().putStringSet("favorites", now).apply()
    }

    private fun locks(context: Context) = try { JSONObject(prefs(context).getString("locks", "{}")!!) } catch (_: Exception) { JSONObject() }
    /** The protocol this location is locked to, or "" (automatic); nothing is locked while advanced is off. */
    fun lock(context: Context, id: String): String = if (enabled(context) && id.isNotEmpty()) locks(context).optString(id).takeIf { it in protocols } ?: "" else ""
    fun setLock(context: Context, id: String, protocol: String) {
        val all = locks(context)
        if (protocol.isEmpty()) all.remove(id) else all.put(id, protocol)
        prefs(context).edit().putString("locks", all.toString()).apply()
    }

    /** The transports of a locked location: only those of its protocol, or all of them when none of those is offered. */
    fun apply(transports: List<String>, protocol: String): List<String> {
        if (protocol.isEmpty()) return transports
        val kept = transports.filter { family(it) == protocol }
        return kept.ifEmpty { transports }
    }
    fun family(transport: String) = if (transport == "reality-alt") "reality" else transport
}
