package com.veilbird.client

import android.content.Context
import java.io.File
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * Diagnostic log of the connection process, opened from a hidden entry (7 taps on the version).
 * Only what the app itself writes: steps, node names, transport names, timings, error codes and
 * error texts scrubbed of addresses (scrub). Never keys, tokens, addresses or visited sites.
 * Two files of 256 KB rotate; lines older than 7 days are dropped, so the log never grows past 512 KB.
 */
object Journal {
    private const val LIMIT = 256 * 1024L
    private const val DAYS = 7L
    private lateinit var current: File
    private lateinit var previous: File

    fun initialize(context: Context) {
        val folder = File(context.filesDir, "logs").apply { mkdirs() }
        current = File(folder, "veilbird.log"); previous = File(folder, "veilbird.1.log")
        val cutoff = System.currentTimeMillis() - DAYS * 86400000
        for (file in listOf(previous, current)) if (file.exists() && file.lastModified() < cutoff) file.delete()
    }

    /**
     * An error text without anything that names a place: URLs, IP addresses, host names and long
     * tokens become "…" (same rule as the server's scrubDetail). At most 200 characters.
     */
    fun scrub(text: String?): String = (text ?: "")
        .replace(Regex("(?i)[a-z][a-z0-9+.-]*://\\S+"), "…")
        .replace(Regex("\\b\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?\\b"), "…")
        .replace(Regex("(?i)\\[?\\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}]?(:\\d+)?"), "…")
        .replace(Regex("(?i)\\b(?:[a-z0-9-]+\\.)+[a-z]{2,}(:\\d+)?\\b"), "…")
        .replace(Regex("[A-Za-z0-9+/=_-]{24,}"), "…")
        .replace(Regex("\\s+"), " ").trim().take(200)

    @Synchronized fun add(message: String) {
        if (!::current.isInitialized) return
        try {
            if (current.length() > LIMIT) { previous.delete(); current.renameTo(previous) }
            current.appendText("${Instant.now().truncatedTo(ChronoUnit.SECONDS)} ${message.replace('\n', ' ')}\n")
        } catch (_: Exception) { }
    }

    /** Oldest first, without lines past the retention window. */
    @Synchronized fun read(): String {
        if (!::current.isInitialized) return ""
        val cutoff = Instant.now().minus(DAYS, ChronoUnit.DAYS)
        return listOf(previous, current).filter { it.exists() }.flatMap { it.readLines() }
            .filter { line -> try { Instant.parse(line.substringBefore(' ')).isAfter(cutoff) } catch (_: Exception) { false } }
            .joinToString("\n")
    }

    @Synchronized fun clear() { if (::current.isInitialized) { previous.delete(); current.delete() } }
}
