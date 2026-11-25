package com.veilbird.client

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.VpnService
import android.view.View
import android.widget.RemoteViews
import kotlin.math.roundToInt

/**
 * Home screen widgets: the connect page's globe (2×2) and a status strip (4×1). Both are drawn when the connection
 * changes (ConnectionService calls [Widgets.refresh]), never on a timer, so they cost nothing while nothing happens.
 * A tap connects or disconnects with the saved location and routing; when the app is needed first (signed out,
 * the system VPN permission not given yet) it opens instead.
 */
object Widgets {
    fun refresh(context: Context) {
        val manager = AppWidgetManager.getInstance(context) ?: return
        for ((provider, build) in listOf(GlobeWidget::class.java to ::globe, StripWidget::class.java to ::strip)) {
            val ids = try { manager.getAppWidgetIds(ComponentName(context, provider)) } catch (_: Exception) { IntArray(0) }
            if (ids.isEmpty()) continue
            val views = try { build(context) } catch (e: Exception) { Journal.add("widget: ${e.javaClass.simpleName}"); continue }
            manager.updateAppWidget(ids, views)
        }
    }
    private val connected get() = ConnectionStateStore.active && ConnectionStateStore.since > 0L
    private fun exitName(context: Context): String {
        val s = ConnectionStateStore
        if (s.active && s.node.isNotEmpty()) return s.node
        val saved = context.getSharedPreferences("preferences", Context.MODE_PRIVATE).getString("nodeName", "") ?: ""
        return saved.ifEmpty { L10n.text(R.string.automatic) }
    }
    /** Connect or disconnect without opening the app, when it can. */
    private fun tap(context: Context): PendingIntent {
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        if (ConnectionStateStore.active) return PendingIntent.getService(context, 11, Intent(context, ConnectionService::class.java).setAction("disconnect"), flags)
        val ready = NativeApi(context).secret("token") != null && VpnService.prepare(context) == null
        if (!ready) return PendingIntent.getActivity(context, 12, Intent(context, MainActivity::class.java).putExtra("connect", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), flags)
        val nodeId = context.getSharedPreferences("preferences", Context.MODE_PRIVATE).getString("nodeId", "") ?: ""
        return PendingIntent.getForegroundService(context, 13, Intent(context, ConnectionService::class.java).putExtra("nodeId", nodeId), flags)
    }
    private fun globe(context: Context): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_globe)
        val on = connected
        val name = exitName(context)
        views.setImageViewBitmap(R.id.widget_globe_image, picture(context, 160))
        views.setTextViewText(R.id.widget_title, if (on) name else L10n.text(R.string.exposed_status))
        views.setTextColor(R.id.widget_title, if (on) Palette.accent else Palette.text)
        views.setTextViewText(R.id.widget_detail, if (on) L10n.text(R.string.sealed_status) else L10n.text(R.string.widget_tap))
        views.setTextColor(R.id.widget_detail, Palette.secondary)
        views.setOnClickPendingIntent(R.id.widget_root, tap(context))
        return views
    }
    private fun strip(context: Context): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_strip)
        val on = connected
        val name = exitName(context)
        views.setViewVisibility(R.id.widget_dot, if (on) View.VISIBLE else View.INVISIBLE)
        views.setTextViewText(R.id.widget_title, if (on) "${L10n.text(R.string.sealed_status)} · $name" else L10n.text(R.string.exposed_status))
        views.setTextColor(R.id.widget_title, Palette.text)
        views.setTextViewText(R.id.widget_detail, if (on) L10n.text(R.string.seen_as, name) else name)
        views.setTextColor(R.id.widget_detail, Palette.secondary)
        views.setTextViewText(R.id.widget_action, L10n.text(if (ConnectionStateStore.active) R.string.disconnect_status else R.string.connect_action))
        views.setTextColor(R.id.widget_action, if (ConnectionStateStore.active) Palette.text else Palette.onAccent)
        views.setInt(R.id.widget_action, "setBackgroundResource", if (ConnectionStateStore.active) R.drawable.widget_pill else R.drawable.widget_pill_accent)
        views.setOnClickPendingIntent(R.id.widget_action, tap(context))
        views.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(context, 14, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
        return views
    }
    /** The connect page's globe at rest, drawn into a bitmap [dp] wide. */
    private fun picture(context: Context, dp: Int): Bitmap {
        val px = (dp * context.resources.displayMetrics.density).roundToInt()
        val portrait = Portrait(context).apply {
            settled = true
            val s = ConnectionStateStore
            val exitId = if (s.active) s.nodeId else context.getSharedPreferences("preferences", Context.MODE_PRIVATE).getString("nodeId", "") ?: ""
            val here = if (VisitorPlace.shown(context)) VisitorPlace.spot(context) else null
            val there = Directory.places[exitId]?.let { Spot(it[0], it[1], exitName(context)) }
            origin = here; exit = there
            state = if (connected) LinkState.CONNECTED else LinkState.IDLE
        }
        portrait.measure(View.MeasureSpec.makeMeasureSpec(px, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(px, View.MeasureSpec.EXACTLY))
        portrait.layout(0, 0, px, px)
        val bitmap = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        portrait.draw(Canvas(bitmap))
        return bitmap
    }
}

class GlobeWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) { Widgets.refresh(context) }
}
class StripWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) { Widgets.refresh(context) }
}
