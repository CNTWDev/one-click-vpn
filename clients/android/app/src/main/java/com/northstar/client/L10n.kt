package com.northstar.client

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

class NorthstarApplication : Application() {
    override fun onCreate() { super.onCreate(); L10n.initialize(this) }
}
object L10n {
    private lateinit var app: Context
    fun initialize(context: Context) { app = context.applicationContext }
    val preference: String get() = if (Build.VERSION.SDK_INT >= 33) app.getSystemService(LocaleManager::class.java).applicationLocales.toLanguageTags().ifEmpty { "system" } else app.getSharedPreferences("language", Context.MODE_PRIVATE).getString("preference", "system")!!
    val locale: Locale get() {
        val chosen = preference
        if (chosen != "system") return Locale.forLanguageTag(chosen)
        val system = if (Build.VERSION.SDK_INT >= 33) app.getSystemService(LocaleManager::class.java).systemLocales else android.content.res.Resources.getSystem().configuration.locales
        for (i in 0 until system.size()) if (system[i].language in listOf("en", "zh", "ru")) return system[i]
        return Locale.ENGLISH
    }
    private val localized: Context get() = app.createConfigurationContext(Configuration(app.resources.configuration).apply { setLocale(L10n.locale) })
    fun text(id: Int, vararg args: Any): String = localized.getString(id, *args)
    fun select(value: String) {
        require(value in listOf("system", "en", "zh", "ru"))
        if (Build.VERSION.SDK_INT >= 33) app.getSystemService(LocaleManager::class.java).applicationLocales = if (value == "system") LocaleList.getEmptyLocaleList() else LocaleList.forLanguageTags(value)
        else app.getSharedPreferences("language", Context.MODE_PRIVATE).edit().putString("preference", value).apply()
    }
    fun number(value: Number): String = NumberFormat.getNumberInstance(locale).format(value)
    fun date(value: String?): String {
        if (value.isNullOrBlank() || value == "null") return text(R.string.no_expiry)
        return try { DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale).withZone(ZoneId.systemDefault()).format(Instant.parse(value)) } catch (_: Exception) { value }
    }
}
