package com.veilbird.client

import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.Editable
import android.text.InputType
import android.text.SpannableString
import android.text.Spanned
import android.text.TextUtils
import android.text.TextWatcher
import android.text.format.DateUtils
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.time.LocalDate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** The locations page: search, automatic choice, measured quality and the routing mode. */
internal fun MainActivity.nodes() {
    val retest = FrameLayout(this).apply {
        background = pressable(Color.TRANSPARENT, 12); contentDescription = L10n.text(R.string.retest_latency); alpha = if (measuring) 0.5f else 1f
        addView(icon(R.drawable.ic_refresh, Palette.secondary, 20), FrameLayout.LayoutParams(20.dp, 20.dp, Gravity.CENTER))
        layoutParams = LinearLayout.LayoutParams(44.dp, 44.dp)
    }
    pageTitle(L10n.text(R.string.locations), retest)
    routingChoice()
    val search = FrameLayout(this).also { add(it) }
    val automatic = selectedId.isEmpty()
    add(row(68).apply {
        background = pressable(Palette.surface, 16).also { if (automatic) ((it as RippleDrawable).getDrawable(0) as GradientDrawable).setStroke(1.dp, Palette.alpha(Palette.accent, 115)) }
        addView(badge(null, R.drawable.ic_sparkle, Palette.accent))
        addView(titles(L10n.text(R.string.automatic), L10n.text(R.string.select_an_available_location_for_you)))
        if (automatic) addView(icon(R.drawable.ic_check, Palette.accent, 20))
        contentDescription = L10n.text(R.string.automatic) + if (automatic) L10n.text(R.string.current_page) else ""
        setOnClickListener { if (!busy) select("", "", "") }
    }, top = 20)
    add(text(L10n.text(R.string.all_locations), 13f, Palette.secondary).apply { setPadding(4.dp, 0, 0, 0) }, top = 20, bottom = 8)
    val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also { add(it) }
    work({ api.request("nodes").getJSONArray("nodes") }) { nodes ->
        Directory.remember(nodes)
        var query = ""
        var ranked: List<Pair<JSONObject, Quality?>> = Latency.unmeasured(nodes).map { (node, _) -> node to Latency.recent[node.getString("id")] }
            .sortedBy { it.second?.score ?: Long.MAX_VALUE }
        if (nodes.length() > 6) search.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; background = rounded(Palette.surface, 12); setPadding(14.dp, 0, 4.dp, 0)
            addView(icon(R.drawable.ic_search, Palette.secondary, 16))
            addView(field(L10n.text(R.string.search_locations_or_regions), kind = InputType.TYPE_TEXT_VARIATION_NORMAL).apply {
                background = null; setPadding(10.dp, 0, 10.dp, 0)
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { query = s.toString(); show(list, ranked, query) }
                    override fun afterTextChanged(s: Editable?) {}
                })
            }, LinearLayout.LayoutParams(0, -1, 1f))
        }, FrameLayout.LayoutParams(-1, 44.dp).apply { topMargin = 20.dp })
        show(list, ranked, query)
        fun measure() {
            if (measuring) return
            measuring = true; retest.alpha = 0.5f; progress?.visibility = View.VISIBLE; show(list, ranked, query)
            Thread {
                val result = try { Latency.rank(nodes) } catch (_: Exception) { null }
                runOnUiThread {
                    measuring = false
                    if (isDestroyed) return@runOnUiThread
                    if (!busy) progress?.visibility = View.INVISIBLE
                    retest.alpha = 1f
                    if (result != null && list.isAttachedToWindow) ranked = result
                    if (list.isAttachedToWindow) show(list, ranked, query)
                }
            }.start()
        }
        retest.setOnClickListener { measure() }
        // Fresh results are kept for the session; opening the page again does not probe every node again.
        // The app is outside its own VPN, so probes measure the direct path even while connected.
        if (ranked.any { it.second == null }) measure()
    }
}
/** Smart (mainland China direct) or global routing; applies from the next connection. */
internal fun MainActivity.routingChoice() {
    val prefs = getSharedPreferences("preferences", MODE_PRIVATE)
    val mode = prefs.getString("routing", "smart")!!
    val choice = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; background = rounded(Palette.surface, 12); setPadding(4.dp, 4.dp, 4.dp, 4.dp) }
    for ((value, title) in listOf("smart" to R.string.routing_smart, "global" to R.string.routing_global)) {
        val selected = value == mode
        choice.addView(text(L10n.text(title), 14f, if (selected) Palette.text else Palette.secondary, 500).apply {
            gravity = Gravity.CENTER; maxLines = 1; background = pressable(if (selected) Palette.selected else Color.TRANSPARENT, 9)
            contentDescription = L10n.text(title) + if (selected) L10n.text(R.string.current_page) else ""
            setOnClickListener {
                if (busy || selected) return@setOnClickListener
                if (ConnectionStateStore.active) { alert(L10n.text(R.string.disconnect_before_changing_routing)); return@setOnClickListener }
                prefs.edit().putString("routing", value).apply(); render()
            }
        }, LinearLayout.LayoutParams(0, 36.dp, 1f).apply { if (value == "global") marginStart = 4.dp })
    }
    add(choice)
    add(text(L10n.text(if (mode == "smart") R.string.routing_smart_detail else R.string.routing_global_detail), 12f, Palette.secondary).apply { setPadding(4.dp, 0, 4.dp, 0) }, top = 8)
}
internal fun MainActivity.show(list: LinearLayout, ranked: List<Pair<JSONObject, Quality?>>, query: String) {
    list.removeAllViews()
    val rows = mutableListOf<View>()
    for ((node, quality) in ranked) {
        val name = node.getString("name"); val region = node.optString("region").takeIf { it.isNotBlank() && it != "null" && it != name } ?: ""
        if (!("$name $region").contains(query, ignoreCase = true)) continue
        val id = node.getString("id"); val code = Directory.code(id, name)
        val unreachable = quality != null && quality.latency == null
        rows.add(row(60).apply {
            addView(badge(code, null, if (unreachable) Palette.faint else Palette.text))
            addView(titles(name, region, if (unreachable) Palette.faint else Palette.text))
            val latency = when {
                quality == null -> if (measuring) "…" else ""
                unreachable -> L10n.text(R.string.quality_unreachable)
                else -> ms(quality)!!
            }
            if (latency.isNotEmpty()) addView(text(latency, 13f, if (unreachable) Palette.faint else Palette.secondary).apply { typeface = Typeface.MONOSPACE }, LinearLayout.LayoutParams(-2, -2).apply { marginStart = 8.dp })
            if (quality != null && !unreachable) addView(SignalBars(this@show).apply {
                level = when (quality.grade) { R.string.quality_good -> 3; R.string.quality_fair -> 2; else -> 1 }
                color = when (quality.grade) { R.string.quality_good -> Palette.accent; R.string.quality_fair -> Palette.fair; else -> Palette.danger }
            }, LinearLayout.LayoutParams(14.dp, 12.dp).apply { marginStart = 8.dp })
            if (id == selectedId) addView(icon(R.drawable.ic_check, Palette.accent, 20), LinearLayout.LayoutParams(20.dp, 20.dp).apply { marginStart = 10.dp })
            contentDescription = name + ", " + (quality?.let { summary(it) } ?: "") + if (id == selectedId) L10n.text(R.string.current_page) else ""
            setOnClickListener { if (!busy) select(id, name, code) }
        })
    }
    when {
        rows.isNotEmpty() -> list.addView(group(rows, inset = 66))
        ranked.isEmpty() -> list.addView(text(L10n.text(R.string.no_locations_available_refresh_later_or_contact_your_administrator), 14f, Palette.secondary).apply { setPadding(4.dp, 4.dp, 4.dp, 4.dp) })
        else -> list.addView(text(L10n.text(R.string.no_matching_locations_try_another_search), 14f, Palette.secondary).apply { setPadding(4.dp, 4.dp, 4.dp, 4.dp) })
    }
}
internal fun MainActivity.select(id: String, name: String, code: String) {
    if (ConnectionStateStore.active) { alert(L10n.text(R.string.disconnect_before_selecting_another_location)); return }
    selectedId = id; selectedName = name; selectedCode = code; page = "connect"; render()
    getSharedPreferences("preferences", MODE_PRIVATE).edit().putString("nodeId", id).putString("nodeName", name).putString("nodeCode", code).apply()
}

/** Builds a page from the cached account at once and refreshes it in the background. */
