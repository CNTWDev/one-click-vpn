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

/** The account page and what opens from it: usage, devices, the hidden log, language. */
internal fun MainActivity.withAccount(build: (JSONObject) -> Unit) {
    val shown = accountData?.also { build(it) }
    val forPage = page
    if (shown == null) { work({ api.request("account") }) { data -> accountData = data; if (page == forPage) build(data) }; return }
    Thread {
        val data = try { api.request("account") } catch (_: Exception) { null } ?: return@Thread
        runOnUiThread { val changed = data.toString() != accountData?.toString(); accountData = data; if (changed && !isDestroyed && page == forPage && !busy) render() }
    }.start()
}
internal fun MainActivity.account() {
    pageTitle(L10n.text(R.string.account))
    withAccount { data ->
        val email = data.optString("email"); val name = data.optString("name").ifBlank { email }
        add(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(4.dp, 0, 4.dp, 0)
            addView(text(name.take(1).uppercase(L10n.locale), 18f, Palette.accent, 600).apply {
                gravity = Gravity.CENTER; background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Palette.raised) }
            }, LinearLayout.LayoutParams(48.dp, 48.dp).apply { marginEnd = 14.dp })
            addView(LinearLayout(this@account).apply {
                orientation = LinearLayout.VERTICAL
                addView(text(email, 16f, Palette.text, 500).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
                addView(text(L10n.text(R.string.account_valid_until, L10n.date(data.optString("expiresAt"))), 13f, Palette.secondary), LinearLayout.LayoutParams(-2, -2).apply { topMargin = 4.dp })
            }, LinearLayout.LayoutParams(0, -2, 1f))
        }, top = 4)
        usageCard(data)
        val updateValue = update?.let { L10n.text(R.string.update_available, it.version) } ?: L10n.text(R.string.up_to_date)
        add(group(listOf(
            settingRow(L10n.text(R.string.authorized_devices), "${L10n.number(data.optInt("used"))} / ${L10n.number(data.optInt("limit"))}") { page = "devices"; render() },
            settingRow(L10n.text(R.string.language), currentLanguage().second) { chooseLanguage() },
            settingRow(L10n.text(R.string.check_for_updates), updateValue) { update?.let { installUpdate(it) } ?: checkForUpdate(announce = true) },
        )), top = 20)
        add(text(L10n.text(R.string.sign_out), 15f, Palette.danger).apply {
            gravity = Gravity.CENTER; background = pressable(Palette.surface, 16)
            setOnClickListener {
                if (busy) return@setOnClickListener
                if (ConnectionStateStore.active) { alert(L10n.text(R.string.disconnect_the_vpn_before_signing_out)); return@setOnClickListener }
                work({ try { api.request("logout", JSONObject()) } finally { api.saveSecret("token", null) } }) { page = "connect"; render() }
            }
        }, height = 54.dp, top = 16)
        // The diagnostic log has no visible entry: seven taps on the version open it.
        var taps = 0; var firstTap = 0L
        add(text("TRACKNOTHING " + BuildConfig.VERSION_NAME, 13f, Palette.faint).apply {
            typeface = Pixel.font(this@account); letterSpacing = 0.12f
            gravity = Gravity.CENTER; setPadding(0, 16.dp, 0, 8.dp)
            setOnClickListener {
                val now = SystemClock.elapsedRealtime()
                if (now - firstTap > 4000) { taps = 0; firstTap = now }
                if (++taps >= 7) { taps = 0; page = "logs"; render() }
            }
        }, top = 4)
    }
}
/** 30-day total, a bar per day, and the download / upload split. */
internal fun MainActivity.usageCard(data: JSONObject) {
    val traffic = data.optJSONObject("traffic") ?: return
    val down = traffic.optString("downloadBytes", "0").toLongOrNull() ?: 0; val up = traffic.optString("uploadBytes", "0").toLongOrNull() ?: 0
    val card = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; background = rounded(Palette.surface, 16); setPadding(16.dp, 18.dp, 16.dp, 16.dp) }
    card.addView(LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(text(L10n.text(R.string.traffic_30_days), 13f, Palette.secondary), LinearLayout.LayoutParams(0, -2, 1f))
        addView(text(L10n.text(R.string.daily), 12f, Palette.secondary))
    })
    // "143 GB": the number large, its unit small and muted.
    val total = bytes(down + up); val split = total.indexOfLast { it.isWhitespace() || it == ' ' }
    val styled = SpannableString(total)
    if (split > 0) {
        styled.setSpan(AbsoluteSizeSpan(16, true), split, total.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        styled.setSpan(ForegroundColorSpan(Palette.secondary), split, total.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    card.addView(text(styled, 42f).apply { typeface = Pixel.font(this@usageCard) }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 14.dp })
    val perDay = HashMap<String, Long>()
    traffic.optJSONArray("days")?.let { days -> for (i in 0 until days.length()) days.optJSONObject(i)?.let { perDay[it.optString("day")] = it.optString("bytes", "0").toLongOrNull() ?: 0 } }
    if (perDay.isNotEmpty()) {
        val today = LocalDate.now()
        card.addView(UsageBars(this).apply { values = (29 downTo 0).map { perDay[today.minusDays(it.toLong()).toString()] ?: 0L }; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO },
            LinearLayout.LayoutParams(-1, 58.dp).apply { topMargin = 14.dp })
    }
    card.addView(LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(text(L10n.text(R.string.download_amount, bytes(down)), 13f, Palette.secondary), LinearLayout.LayoutParams(-2, -2).apply { marginEnd = 20.dp })
        addView(text(L10n.text(R.string.upload_amount, bytes(up)), 13f, Palette.secondary))
    }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 14.dp })
    add(card, top = 20)
}
internal fun MainActivity.devices() {
    subPageTitle(L10n.text(R.string.authorized_devices)) { page = "account"; render() }
    withAccount { data ->
        add(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.BOTTOM; setPadding(4.dp, 0, 4.dp, 0)
            addView(text(L10n.text(R.string.devices_used, L10n.number(data.optInt("used")), L10n.number(data.optInt("limit"))), 13f, Palette.secondary), LinearLayout.LayoutParams(-2, -2).apply { marginEnd = 12.dp })
            addView(text(L10n.text(R.string.devices_join_automatically), 12f, Palette.secondary).apply { gravity = Gravity.END }, LinearLayout.LayoutParams(0, -2, 1f))
        }, top = 8, bottom = 10)
        val devices = data.getJSONArray("devices")
        val rows = mutableListOf<View>()
        for (i in 0 until devices.length()) {
            val d = devices.getJSONObject(i)
            if (d.getString("status") == "revoked") continue
            val platform = d.optString("platform"); val mobile = platform.lowercase() in listOf("android", "ios", "ipados")
            val seen = d.optString("lastSeenAt").takeIf { it.isNotBlank() && it != "null" }?.let { value ->
                try { DateUtils.getRelativeTimeSpanString(java.time.Instant.parse(value).toEpochMilli(), System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString() } catch (_: Exception) { null }
            }
            val detail = listOfNotNull(platformName(platform), if (d.getBoolean("isCurrent")) L10n.text(R.string.this_device).trim().removePrefix("·").trim() else seen).joinToString(" · ")
            rows.add(row(68).apply {
                setPadding(16.dp, 8.dp, 8.dp, 8.dp)
                addView(FrameLayout(this@devices).apply {
                    background = rounded(Palette.raised, 10)
                    addView(icon(if (mobile) R.drawable.ic_phone else R.drawable.ic_laptop, if (d.getBoolean("isCurrent")) Palette.accent else Palette.secondary, 18), FrameLayout.LayoutParams(18.dp, 18.dp, Gravity.CENTER))
                }, LinearLayout.LayoutParams(36.dp, 36.dp).apply { marginEnd = 14.dp })
                addView(titles(d.getString("name"), detail))
                if (d.getString("status") == "revoking") addView(text(L10n.text(R.string.revoking_short), 14f, Palette.faint).apply { setPadding(12.dp, 0, 12.dp, 0) })
                else addView(text(L10n.text(R.string.revoke_short), 14f, Palette.danger).apply {
                    gravity = Gravity.CENTER; setPadding(12.dp, 0, 12.dp, 0); background = pressable(Color.TRANSPARENT, 10)
                    contentDescription = L10n.text(R.string.revoke_access) + ": " + d.getString("name")
                    setOnClickListener { if (!busy) revoke(d) }
                }, LinearLayout.LayoutParams(-2, 40.dp))
                background = rounded(Color.TRANSPARENT, 0)
            })
        }
        if (rows.isEmpty()) add(text(L10n.text(R.string.no_authorized_devices_yet_they_appear_after_their_first), 14f, Palette.secondary).apply { setPadding(4.dp, 0, 4.dp, 0) })
        else add(group(rows, inset = 66))
        add(text(L10n.text(R.string.revoke_release_hint), 12f, Palette.secondary).apply { setPadding(4.dp, 0, 4.dp, 0) }, top = 12)
    }
}
internal fun MainActivity.platformName(value: String) = when (value.lowercase()) { "android" -> "Android"; "ios" -> "iOS"; "ipados" -> "iPadOS"; "macos" -> "macOS"; "windows" -> "Windows"; "" -> null; else -> value }
internal fun MainActivity.revoke(device: JSONObject) {
    AlertDialog.Builder(this).setTitle(L10n.text(R.string.revoke_this_device_s_access)).setMessage(L10n.text(R.string.this_device_will_no_longer_be_able_to_connect))
        .setNegativeButton(L10n.text(R.string.cancel), null).setPositiveButton(L10n.text(R.string.revoke_access)) { _, _ ->
            work({ api.action("revoke", JSONObject().put("enrollmentId", device.getString("id"))); api.request("account") }) { data ->
                accountData = data
                if (device.getBoolean("isCurrent") && ConnectionStateStore.active) startService(Intent(this, ConnectionService::class.java).setAction("disconnect"))
                render()
            }
        }.show()
}
internal fun MainActivity.logs() {
    val log = Journal.read()
    subPageTitle(L10n.text(R.string.logs_title)) { page = "account"; render() }
    add(text(L10n.text(R.string.logs_detail), 13f, Palette.secondary).apply { setPadding(4.dp, 0, 4.dp, 0) }, bottom = 12)
    val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    for ((title, action) in listOf<Pair<Int, () -> Unit>>(
        R.string.copy_action to {
            getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("TrackNothing", log))
            Toast.makeText(this, L10n.text(R.string.copied), Toast.LENGTH_SHORT).show()
        },
        R.string.share_action to { startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, log), null)) },
        R.string.clear_action to { Journal.clear(); render() },
    )) actions.addView(text(L10n.text(title), 14f, if (title == R.string.clear_action) Palette.danger else Palette.text, 500).apply {
        gravity = Gravity.CENTER; maxLines = 1; background = pressable(Palette.surface, 12)
        isEnabled = log.isNotEmpty() || title == R.string.clear_action; alpha = if (isEnabled) 1f else 0.4f
        setOnClickListener { action() }
    }, LinearLayout.LayoutParams(0, 44.dp, 1f).apply { if (title != R.string.clear_action) marginEnd = 8.dp })
    add(actions, bottom = 12)
    // Newest first: the last attempt is what someone opening the log is looking for.
    add(TextView(this).apply {
        text = if (log.isEmpty()) L10n.text(R.string.logs_empty) else log.lines().reversed().joinToString("\n")
        textSize = 11f; typeface = Typeface.MONOSPACE; setTextColor(Palette.text); setTextIsSelectable(true)
        background = rounded(Palette.surface, 12); setPadding(12.dp, 10.dp, 12.dp, 10.dp)
    })
}

// ---- Language: native names, no flags; a bottom sheet after sign-in and before it.
internal val MainActivity.languages get() = listOf("system" to L10n.text(R.string.language_system), "zh" to "简体中文", "en" to "English", "ru" to "Русский")
internal fun MainActivity.currentLanguage() = L10n.preference.substringBefore('-').let { code -> languages.firstOrNull { it.first == code } ?: languages[0] }
internal fun MainActivity.shortLanguageName() = when (L10n.locale.language) { "zh" -> "简体中文"; "ru" -> "Русский"; else -> "English" }
internal fun MainActivity.chooseLanguage() {
    val current = currentLanguage().first
    sheet(L10n.text(R.string.language), languages.map { it.second }, languages.indexOfFirst { it.first == current }) { which ->
        if (languages[which].first != current) { L10n.select(languages[which].first); if (Build.VERSION.SDK_INT < 33) recreate() }
    }
}
internal fun MainActivity.sheet(title: String, options: List<String>, checked: Int, onPick: (Int) -> Unit) {
    val dialog = Dialog(this).apply { requestWindowFeature(Window.FEATURE_NO_TITLE) }
    val box = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(20.dp, 10.dp, 20.dp, 28.dp)
        background = GradientDrawable().apply { setColor(Palette.surface); val r = 24.dp.toFloat(); cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f) }
    }
    box.addView(View(this).apply { background = rounded(Color.rgb(46, 58, 48), 2) }, LinearLayout.LayoutParams(36.dp, 4.dp).apply { gravity = Gravity.CENTER_HORIZONTAL })
    box.addView(text(title, 17f, Palette.text, 600).apply { setPadding(4.dp, 0, 0, 0); accessibilityHeading() }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 18.dp; bottomMargin = 14.dp })
    box.addView(group(options.mapIndexed { i, option ->
        row().apply {
            addView(text(option, 15f).apply { maxLines = 1 }, LinearLayout.LayoutParams(0, -2, 1f))
            if (i == checked) addView(icon(R.drawable.ic_check, Palette.accent, 20))
            contentDescription = option + if (i == checked) L10n.text(R.string.current_page) else ""
            setOnClickListener { dialog.dismiss(); onPick(i) }
        }
    }, color = Color.rgb(27, 36, 29)))
    dialog.setContentView(box)
    dialog.show()
    dialog.window?.apply {
        setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); setGravity(Gravity.BOTTOM)
        setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND); setDimAmount(0.6f)
        @Suppress("DEPRECATION") navigationBarColor = Palette.surface
    }
}
