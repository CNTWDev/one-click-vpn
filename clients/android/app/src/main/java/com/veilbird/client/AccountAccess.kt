package com.veilbird.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.time.Instant

/** The account's access as the server reports it: period end, traffic quota (all nodes together) and whether either is running out. */
data class AccountAccess(val state: String, val until: Instant?, val quotaBytes: Long?, val remainingBytes: Long) {
    val metered get() = quotaBytes != null
    /** Running low: 10% of the traffic or 7 days left, as in the reminder mail (server/access-jobs.ts). */
    val low get() = state == "active" && quotaBytes != null && remainingBytes <= quotaBytes / 10
    val ending get() = state == "active" && until != null && until.toEpochMilli() - System.currentTimeMillis() <= 7 * DAY

    /** The small titles above the two figures: the usual ones, or the reminder in their place (nothing is added, nothing moves). */
    fun trafficTitle() = when {
        state == "exhausted" -> R.string.access_used_title
        low -> R.string.access_low_title
        metered -> R.string.traffic_left
        else -> R.string.last_30_days
    }
    fun untilTitle() = when {
        state == "expired" -> R.string.access_expired_title
        ending -> R.string.access_soon_title
        else -> R.string.valid_until_label
    }
    /** One line for the ongoing notification while connected, or null when nothing is running out. */
    fun line(bytes: (Long) -> String): String? = when {
        low -> L10n.text(R.string.reminder_low_line, bytes(remainingBytes))
        ending -> L10n.text(R.string.reminder_soon_line, L10n.date(until.toString()))
        else -> null
    }

    companion object {
        const val DAY = 86_400_000L
        fun from(account: JSONObject): AccountAccess {
            val access = account.optJSONObject("access") ?: return AccountAccess("active", null, null, 0)
            fun long(key: String) = if (access.isNull(key)) null else access.optString(key).toDoubleOrNull()?.toLong()
            val until = if (access.isNull("until")) null else runCatching { Instant.parse(access.getString("until")) }.getOrNull()
            return AccountAccess(access.optString("state", "active"), until, long("quotaBytes"), long("remainingBytes") ?: 0)
        }
    }
}

/**
 * System notifications before the access runs out: once 7 days before the end, once 1 day before, once at 10% traffic
 * left. A step is remembered only while it still holds: after renewing or adding traffic the steps start over.
 */
object AccessReminders {
    private const val CHANNEL = "account"

    fun check(context: Context, access: AccountAccess) {
        val bytes = { value: Long -> android.text.format.Formatter.formatShortFileSize(context, value) }
        val prefs = context.getSharedPreferences("reminders", Context.MODE_PRIVATE)
        val saved = prefs.getStringSet("sent", emptySet())!!
        val sent = saved.filter { (it.startsWith("low:") && access.low) || (it.startsWith("end") && access.ending && it.endsWith(":${access.until}")) }.toMutableSet()
        val due = mutableListOf<Triple<Int, String, Int>>()
        if (access.ending) {
            val left = access.until!!.toEpochMilli() - System.currentTimeMillis()
            val end = access.until.toString()
            // Opened with less than a day left: the 7-day step counts as done, one notification is enough.
            val keys = if (left <= AccountAccess.DAY) listOf("end1:$end", "end7:$end") else listOf("end7:$end")
            if (keys[0] !in sent) { sent += keys; due += Triple(R.string.reminder_soon_title, L10n.text(R.string.reminder_soon_body, L10n.date(end)), 2) }
        }
        if (access.low) {
            val key = "low:${access.quotaBytes}"
            if (key !in sent) { sent += key; due += Triple(R.string.reminder_low_title, L10n.text(R.string.reminder_low_body, bytes(access.remainingBytes), bytes(access.quotaBytes!!)), 3) }
        }
        if (sent != saved) prefs.edit().putStringSet("sent", sent).apply()
        if (due.isEmpty()) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, L10n.text(R.string.reminder_channel), NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        for ((title, body, id) in due) manager.notify(id, Notification.Builder(context, CHANNEL).setContentTitle(L10n.text(title)).setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body)).setSmallIcon(R.drawable.ic_stat_mark).setContentIntent(open).setAutoCancel(true).build())
    }
}
