package com.veilbird.client

import android.content.Context
import android.os.SystemClock
import org.json.JSONObject

/**
 * One connection session, summed up for the staged-rollout health check (Console → 客户端发布):
 * whether it connected, how long that took, the line it ended up on, how often it fell back and how often the
 * working tunnel stopped answering. Sent as one CONNECT_SESSION diagnostic when the session ends; never an
 * address, a node name or traffic. Kept in preferences so a session cut short by Android killing the process
 * is still sent on the next start (without its duration, which is then unknown).
 */
object Session {
    private const val KEY = "session"
    private var state = JSONObject()

    private fun prefs(context: Context) = context.getSharedPreferences("preferences", Context.MODE_PRIVATE)
    private fun save(context: Context) { prefs(context).edit().putString(KEY, state.toString()).apply() }

    /** A new attempt (a tap, the tile, always-on or a restart); a session still open from a killed process is sent first. */
    @Synchronized fun start(context: Context, api: NativeApi, network: String) {
        prefs(context).getString(KEY, null)?.let { left -> try { send(api, JSONObject(left).put("outcome", if (JSONObject(left).optBoolean("up")) "lost" else "cancelled"), 0) } catch (_: Exception) { } }
        state = JSONObject().put("net", network.substringBefore(':')).put("fallbacks", 0).put("drops", 0)
        save(context)
    }
    /** The tunnel carries traffic for the first time in this session. */
    @Synchronized fun connected(context: Context, ms: Long, line: String, preferred: String) {
        if (state.optBoolean("up")) return
        state.put("up", true).put("ms", ms).put("line", line).put("upAt", SystemClock.elapsedRealtime())
        if (line.isNotEmpty() && line != preferred) state.put("fallbacks", state.optInt("fallbacks") + 1)
        save(context)
    }
    /** Automatic mode gave up on a location while connecting. */
    @Synchronized fun movedNode(context: Context) { state.put("fallbacks", state.optInt("fallbacks") + 1); save(context) }
    /** A working tunnel stopped answering on a network that is still there. */
    @Synchronized fun dropped(context: Context) { if (state.optBoolean("up")) { state.put("drops", state.optInt("drops") + 1); save(context) } }
    /** The session ends: [failed] when it never connected because of an error, otherwise the user or the app stopped it. */
    @Synchronized fun end(context: Context, api: NativeApi, failed: Boolean) {
        if (!prefs(context).contains(KEY)) return
        val up = state.optBoolean("up")
        val seconds = if (up) (SystemClock.elapsedRealtime() - state.optLong("upAt")) / 1000 else 0
        prefs(context).edit().remove(KEY).apply()
        send(api, state.put("outcome", if (up) "ok" else if (failed) "failed" else "cancelled"), seconds)
    }
    private fun send(api: NativeApi, s: JSONObject, seconds: Long) {
        val detail = listOf("outcome=${s.optString("outcome")}", "ms=${s.optLong("ms", -1)}", "line=${s.optString("line").ifEmpty { "-" }}",
            "fallbacks=${s.optInt("fallbacks")}", "drops=${s.optInt("drops")}", "seconds=$seconds", "net=${s.optString("net").ifEmpty { "unknown" }}").joinToString(" ")
        Thread { api.report("CONNECT_SESSION", detail = detail) }.start()
    }
}
