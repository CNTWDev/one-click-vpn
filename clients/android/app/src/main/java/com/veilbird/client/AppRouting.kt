package com.veilbird.client

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Drawable
import android.net.VpnService

/**
 * Per-app routing: every app through the tunnel (the default), only the selected apps, or every app except the
 * selected ones. Android applies it to the tun itself (allowed / disallowed applications), so apps left out never
 * reach the core. Read when the tunnel is built: changes apply from the next connection, like the routing mode.
 */
object AppRouting {
    const val ALL = "all"
    const val ONLY = "only"
    const val EXCEPT = "except"

    data class App(val packageName: String, val label: String, val icon: Drawable?)

    private fun prefs(context: Context) = context.getSharedPreferences("preferences", Context.MODE_PRIVATE)
    fun mode(context: Context): String = prefs(context).getString("appMode", ALL)!!.takeIf { it in listOf(ALL, ONLY, EXCEPT) } ?: ALL
    fun apps(context: Context): Set<String> = prefs(context).getStringSet("apps", emptySet())!!.toSet()
    fun setMode(context: Context, mode: String) = prefs(context).edit().putString("appMode", mode).apply()
    fun setApps(context: Context, apps: Set<String>) = prefs(context).edit().putStringSet("apps", apps.toSet()).apply()

    /**
     * Applies the choice to the tun being built. "Only" with none of the selected apps still installed falls back
     * to every app, so the tunnel never ends up carrying this app's own traffic or nothing at all.
     */
    fun apply(context: Context, builder: VpnService.Builder): String {
        val mode = mode(context)
        val apps = apps(context) - context.packageName
        if (mode == ONLY && apps.isNotEmpty()) {
            val added = apps.count { try { builder.addAllowedApplication(it); true } catch (_: PackageManager.NameNotFoundException) { false } }
            if (added > 0) return "only $added"
        }
        builder.addDisallowedApplication(context.packageName)
        if (mode == EXCEPT && apps.isNotEmpty()) {
            val added = apps.count { try { builder.addDisallowedApplication(it); true } catch (_: PackageManager.NameNotFoundException) { false } }
            return "except $added"
        }
        return ALL
    }

    /** Apps with a launcher icon (what a person recognises), this one left out, sorted by name. Slow: off the UI thread. */
    fun launchable(context: Context): List<App> {
        val pm = context.packageManager
        @Suppress("DEPRECATION")
        val activities = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
        return activities.map { it.activityInfo.applicationInfo }.distinctBy { it.packageName }
            .filter { it.packageName != context.packageName }
            .map { App(it.packageName, pm.getApplicationLabel(it).toString(), try { pm.getApplicationIcon(it) } catch (_: Exception) { null }) }
            .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.label })
    }
}
