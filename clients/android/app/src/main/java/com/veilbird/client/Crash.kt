package com.veilbird.client

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.time.Instant

/**
 * Crash reports: an uncaught exception is written to crash.json as it happens (type, scrubbed message and the
 * app's own frames as Class/method, never values), and native crashes and ANRs come from ApplicationExitInfo.
 * Both are sent as APP_CRASH diagnostics on the next start (Console → 客户端发布 counts them; 运行日志 has the text).
 */
object Crash {
    fun watch(context: Context) {
        val file = File(context.filesDir, "crash.json")
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try { file.writeText(JSONObject().put("at", Instant.now().toString()).put("detail", "${BuildConfig.VERSION_NAME} ${describe(error)}").toString()) } catch (_: Exception) { }
            Journal.add("crash: ${describe(error)}")
            previous?.uncaughtException(thread, error)
        }
    }
    /** "NullPointerException: … at ConnectionService/tick < ..." (dots would read as host names to the scrubber). */
    fun describe(error: Throwable): String {
        val frames = error.stackTrace.filter { it.className.startsWith("com.veilbird") }
            .map { "${it.className.substringAfterLast('.').substringBefore('$')}/${it.methodName}" }.distinct().take(8)
        return "${error.javaClass.simpleName}: ${Journal.scrub(error.message)} at ${frames.joinToString(" < ")}"
    }
    /** Sends what crashed since the last start; runs off the main thread. */
    fun send(context: Context, api: NativeApi) {
        if (api.secret("token") == null) return
        val file = File(context.filesDir, "crash.json")
        if (file.exists()) {
            try { JSONObject(file.readText()).let { api.report("APP_CRASH", detail = it.optString("detail"), at = it.optString("at")) } } catch (_: Exception) { }
            file.delete()
        }
        if (Build.VERSION.SDK_INT < 30) return
        val prefs = context.getSharedPreferences("veilbird", Context.MODE_PRIVATE)
        val since = prefs.getLong("exitsCheckedAt", System.currentTimeMillis())
        val exits = try { context.getSystemService(ActivityManager::class.java).getHistoricalProcessExitReasons(null, 0, 10) } catch (_: Exception) { emptyList() }
        for (exit in exits.filter { it.timestamp > since }) {
            val kind = when (exit.reason) { ApplicationExitInfo.REASON_CRASH_NATIVE -> "native crash"; ApplicationExitInfo.REASON_ANR -> "ANR"; else -> continue }
            api.report("APP_CRASH", detail = "${BuildConfig.VERSION_NAME} $kind ${Journal.scrub(exit.description)}".trim(), at = Instant.ofEpochMilli(exit.timestamp).toString())
        }
        prefs.edit().putLong("exitsCheckedAt", System.currentTimeMillis()).apply()
    }
}
