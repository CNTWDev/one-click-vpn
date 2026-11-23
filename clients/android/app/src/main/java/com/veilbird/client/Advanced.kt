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

    /** The person's routing rules as typed (one per line); the core reads them (clients/core/rules.go). */
    fun rulesText(context: Context): String = prefs(context).getString("rules", "")!!
    fun saveRules(context: Context, text: String) { prefs(context).edit().putString("rules", text).apply() }
    /** The lines the core will use; none while advanced is off. */
    fun rules(context: Context): List<String> = if (enabled(context)) rulesText(context).lines().map { it.trim() }.filter { ruleState(it) == 1 } else emptyList()
    private val ruleTypes = setOf("DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6")
    private val cidr = Regex("^[0-9A-Fa-f:.]+/[0-9]{1,3}$")
    /** 1 a rule, 0 blank or a comment, -1 a line the core cannot read; the same reading as rules.go. */
    fun ruleState(line: String): Int {
        val parts = line.substringBefore('#').split(',').map { it.trim() }.filter { it.isNotEmpty() }
        if (parts.isEmpty()) return 0
        val (value, ip) = when {
            parts.size >= 3 && parts[0].uppercase() in ruleTypes -> parts[1] to parts[0].uppercase().startsWith("IP")
            parts.size == 2 -> parts[0] to ('/' in parts[0])
            else -> return -1
        }
        if (value.any { it.isWhitespace() }) return -1
        if (ip) return if (cidr.matches(value)) 1 else -1
        return if (value.trimStart('+').trimStart('.').isNotEmpty()) 1 else -1
    }
}
