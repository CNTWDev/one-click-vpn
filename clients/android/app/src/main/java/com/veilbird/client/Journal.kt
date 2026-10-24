package com.veilbird.client

import android.content.Context
import java.io.File
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * Diagnostic log of the connection process, opened from a hidden entry (7 taps on the version).
 * Only what the app itself writes: steps, node names, transport names, timings and error codes.
 * Never keys, tokens, addresses or visited sites. Two files of 256 KB rotate; lines older than
 * 7 days are dropped, so the log never grows past 512 KB.
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
