package com.veilbird.client

import android.app.Application
import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

class VeilbirdApplication : Application() {
    override fun onCreate() { super.onCreate(); L10n.initialize(this); Journal.initialize(this); Crash.watch(this) }
    // The system language or the app's own (Android 13+) changed: look the language up again.
    override fun onConfigurationChanged(newConfig: Configuration) { super.onConfigurationChanged(newConfig); L10n.forget() }
}
object L10n {
    private lateinit var app: Context
    fun initialize(context: Context) { app = context.applicationContext }
    val preference: String get() = if (Build.VERSION.SDK_INT >= 33) app.getSystemService(LocaleManager::class.java).applicationLocales.toLanguageTags().ifEmpty { "system" } else app.getSharedPreferences("language", Context.MODE_PRIVATE).getString("preference", "system")!!
    /**
     * The language and a context for it, looked up once and kept: the lookup asks the system (LocaleManager) and
     * builds a configuration context, and pages read a few hundred strings. Cleared by [select] and on configuration
     * changes (the system language or, on Android 13+, the app's own).
     */
    @Volatile private var cached: Pair<Locale, Context>? = null
    fun forget() { cached = null }
    private fun current(): Pair<Locale, Context> = cached ?: resolve().let { chosen ->
        (chosen to app.createConfigurationContext(Configuration(app.resources.configuration).apply { setLocale(chosen) })).also { cached = it }
    }
    val locale: Locale get() = current().first
    private fun resolve(): Locale {
        val chosen = preference
        if (chosen != "system") return Locale.forLanguageTag(chosen)
        val system = if (Build.VERSION.SDK_INT >= 33) app.getSystemService(LocaleManager::class.java).systemLocales else android.content.res.Resources.getSystem().configuration.locales
        for (i in 0 until system.size()) if (system[i].language in listOf("en", "zh", "ru")) return system[i]
        return Locale.ENGLISH
    }
    private val localized: Context get() = current().second
    fun text(id: Int, vararg args: Any): String = localized.getString(id, *args)
    fun select(value: String) {
        require(value in listOf("system", "en", "zh", "ru"))
        if (Build.VERSION.SDK_INT >= 33) app.getSystemService(LocaleManager::class.java).applicationLocales = if (value == "system") LocaleList.getEmptyLocaleList() else LocaleList.forLanguageTags(value)
        else app.getSharedPreferences("language", Context.MODE_PRIVATE).edit().putString("preference", value).apply()
        forget()
    }
    /**
     * The items of release notes in the app's language. Notes from clients/CHANGELOG.md have "### zh/en/ru" blocks
     * of "- " items; notes typed in Console without blocks count for every language. English is the fallback.
     */
    fun notes(text: String): List<String> {
        val blocks = mutableMapOf<String, MutableList<String>>()
        var block = ""
        for (line in text.lines()) {
            val heading = Regex("^###\\s*([a-zA-Z]{2})\\s*$").find(line.trim())
            if (heading != null) { block = heading.groupValues[1].lowercase(); continue }
            val item = line.trim().removePrefix("- ").removePrefix("* ").removePrefix("• ").trim()
            if (item.isNotEmpty()) blocks.getOrPut(block) { mutableListOf() }.add(item)
        }
        return blocks[locale.language] ?: blocks["en"] ?: blocks[""] ?: emptyList()
    }
    fun number(value: Number): String = NumberFormat.getNumberInstance(locale).format(value)
    /** A day of the usage chart ("2026-11-22") as the locale writes a short month and day such as "Nov 22" */
    fun day(value: String): String = try {
        DateTimeFormatter.ofPattern(android.text.format.DateFormat.getBestDateTimePattern(locale, "MMMd"), locale).format(java.time.LocalDate.parse(value))
    } catch (_: Exception) { value }
    fun date(value: String?): String {
        if (value.isNullOrBlank() || value == "null") return text(R.string.no_expiry)
        return try { DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale).withZone(ZoneId.systemDefault()).format(Instant.parse(value)) } catch (_: Exception) { value }
    }
}
