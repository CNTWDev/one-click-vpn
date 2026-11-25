package com.veilbird.client

import android.content.Context
import com.veilbird.core.Core
import org.json.JSONArray

/**
 * Keeps AI services on a steady exit. ChatGPT, Claude and Gemini refuse some countries (the server marks such locations
 * "ai": false) and flag accounts whose exit keeps changing, so automatic mode keeps people who used AI in the last week
 * off refused locations, and moves inside the same country while AI is in use (ConnectionService.moveToFastest).
 */
object AIExit {
    private const val KEY = "aiSeenAt"
    private const val WEEK = 7 * 86400000L
    private var noted = 0L
    private fun prefs(context: Context) = context.getSharedPreferences("preferences", Context.MODE_PRIVATE)
    /** AI services went through the tunnel in the last week. */
    fun recent(context: Context) = System.currentTimeMillis() - prefs(context).getLong(KEY, 0L) < WEEK
    /** Called on the tunnel's tick: remembers (at most every 5 minutes) that AI is in use. */
    fun note(context: Context) {
        val now = System.currentTimeMillis()
        if (now - noted < 300000 || !Core.aiActive(60)) return
        noted = now; prefs(context).edit().putLong(KEY, now).apply()
    }
    /** The locations automatic mode may pick: without those AI services refuse, for people who use AI (unless none is left). */
    fun usable(context: Context, nodes: JSONArray): JSONArray {
        if (!recent(context)) return nodes
        val kept = JSONArray()
        for (i in 0 until nodes.length()) nodes.getJSONObject(i).let { if (!(it.has("ai") && !it.isNull("ai") && !it.optBoolean("ai", true))) kept.put(it) }
        return if (kept.length() == 0) nodes else kept
    }
}
