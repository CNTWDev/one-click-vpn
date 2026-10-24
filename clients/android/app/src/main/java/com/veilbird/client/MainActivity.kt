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

class MainActivity : Activity() {
    private lateinit var api: NativeApi
    private lateinit var updater: Updater
    private var update: UpdateInfo? = null
    private var announcement = ""
    private lateinit var content: LinearLayout
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private var selectedId = ""
    private var selectedName = ""
    private var selectedCode = ""
    private var page = "connect"
    private var busy = false
    private var visible = false
    private var progress: ProgressBar? = null
    private var lastView = ""
    // The last account summary, so pages show usage at once and refresh it quietly.
    private var accountData: JSONObject? = null
    // Connect page views that the once-a-second refresh updates.
    private var ring: ConnectRing? = null
    private var stateTitle: TextView? = null
    private var stateDot: View? = null
    private var stateDetail: TextView? = null
    private var nodeTitle: TextView? = null
    private var nodeDetail: TextView? = null
    private var nodeBadge: FrameLayout? = null
    private val refresh = object : Runnable {
        override fun run() { showState(); if (visible) handler.postDelayed(this, 1000) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); api = NativeApi(this); updater = Updater(this, api)
        val settings = getSharedPreferences("preferences", MODE_PRIVATE)
        selectedId = settings.getString("nodeId", "")!!; selectedName = settings.getString("nodeName", "")!!; selectedCode = settings.getString("nodeCode", "")!!
        @Suppress("DEPRECATION") window.apply { statusBarColor = Palette.ground; navigationBarColor = Palette.ground; decorView.systemUiVisibility = 0 }
        render(); checkForUpdate()
        // The Quick Settings tile could not start the VPN from the background: connect now that the app is open.
        if (intent?.getBooleanExtra("connect", false) == true && api.secret("token") != null && !ConnectionStateStore.active) toggleConnection()
    }
    override fun onResume() { super.onResume(); visible = true; handler.post(refresh) }
    override fun onPause() { visible = false; handler.removeCallbacks(refresh); super.onPause() }
    override fun onDestroy() { executor.shutdown(); super.onDestroy() }
    @Deprecated("Back handling for API 26+")
    override fun onBackPressed() {
        when (page) {
            "devices", "logs" -> { page = "account"; render() }
            "nodes", "account" -> { page = "connect"; render() }
            else -> super.onBackPressed()
        }
    }

    // ---- Building blocks: one radius scale (12 controls, 16 cards), one palette, one type scale.
    private val Int.dp get() = (this * resources.displayMetrics.density).toInt()
    private fun rounded(color: Int, radius: Int) = GradientDrawable().apply { setColor(color); cornerRadius = radius.dp.toFloat() }
    private fun pressable(color: Int, radius: Int): Drawable =
        RippleDrawable(ColorStateList.valueOf(Palette.alpha(Palette.text, 22)), if (color == Color.TRANSPARENT) null else rounded(color, radius), rounded(Color.WHITE, radius))
    private fun TextView.weight(value: Int) = apply {
        typeface = when {
            Build.VERSION.SDK_INT >= 28 -> Typeface.create(Typeface.DEFAULT, value, false)
            value >= 600 -> Typeface.DEFAULT_BOLD
            value >= 500 -> Typeface.create("sans-serif-medium", Typeface.NORMAL)
            else -> Typeface.DEFAULT
        }
    }
    private fun text(value: CharSequence, size: Float, color: Int = Palette.text, weight: Int = 400) = TextView(this).apply {
        text = value; textSize = size; setTextColor(color); weight(weight); includeFontPadding = false
        if (size >= 24) letterSpacing = -0.015f
        setLineSpacing(3.dp.toFloat(), 1f)
    }
    private fun icon(res: Int, color: Int, size: Int = 20) = ImageView(this).apply {
        setImageResource(res); imageTintList = ColorStateList.valueOf(color); scaleType = ImageView.ScaleType.FIT_CENTER
        layoutParams = LinearLayout.LayoutParams(size.dp, size.dp)
    }
    private fun add(view: View, height: Int = -2, top: Int = 0, bottom: Int = 0, width: Int = -1, gravity: Int = -1) =
        view.also { content.addView(it, LinearLayout.LayoutParams(width, height).apply { topMargin = top.dp; bottomMargin = bottom.dp; if (gravity != -1) this.gravity = gravity }) }
    private fun spacer(weight: Float) = add(View(this), height = 0).apply { (layoutParams as LinearLayout.LayoutParams).weight = weight }
    private fun row(minHeight: Int = 54) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = minHeight.dp; setPadding(16.dp, 8.dp, 16.dp, 8.dp)
    }
    /** A 36dp tile with a two-letter country code or an icon. */
    private fun badge(code: String?, iconRes: Int? = null, tint: Int = Palette.text) = FrameLayout(this).apply {
        background = rounded(Palette.raised, 10)
        fillBadge(this, code, iconRes, tint)
        layoutParams = LinearLayout.LayoutParams(36.dp, 36.dp).apply { marginEnd = 14.dp }
    }
    private fun fillBadge(badge: FrameLayout, code: String?, iconRes: Int?, tint: Int) {
        badge.removeAllViews()
        if (iconRes != null) badge.addView(icon(iconRes, tint, 18), FrameLayout.LayoutParams(18.dp, 18.dp, Gravity.CENTER))
        else badge.addView(text(code ?: "", 13f, tint, 600).apply { gravity = Gravity.CENTER }, FrameLayout.LayoutParams(-1, -1))
    }
    /** Title with an optional second line, filling the space between a badge and trailing views. */
    private fun titles(title: String, detail: String = "", titleColor: Int = Palette.text): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(text(title, 15f, titleColor, 500).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
        addView(text(detail, 13f, Palette.secondary).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END; visibility = if (detail.isEmpty()) View.GONE else View.VISIBLE },
            LinearLayout.LayoutParams(-2, -2).apply { topMargin = 3.dp })
        layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
    }
    /** A card of rows separated by hairlines; the line starts after the badge when rows have one. */
    private fun group(rows: List<View>, inset: Int = 16, color: Int = Palette.surface) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; background = rounded(color, 16); clipToOutline = true
        rows.forEachIndexed { i, row ->
            if (i > 0) addView(View(this@MainActivity).apply { setBackgroundColor(Palette.hairline) }, LinearLayout.LayoutParams(-1, 1).apply { marginStart = inset.dp })
            row.background = row.background ?: pressable(Color.TRANSPARENT, 0)
            addView(row, LinearLayout.LayoutParams(-1, -2))
        }
    }
    private fun chevron() = icon(R.drawable.ic_chevron_right, Palette.secondary, 16)
    private fun settingRow(title: String, value: String, onClick: () -> Unit) = row().apply {
        addView(text(title, 15f).apply { maxLines = 1 }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(text(value, 14f, Palette.secondary).apply { maxLines = 1 }, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = 8.dp })
        addView(chevron()); contentDescription = "$title: $value"
        setOnClickListener { if (!busy) onClick() }
    }
    private fun pageTitle(title: String, trailing: View? = null) {
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(4.dp, 0, 0, 0) }
        header.addView(text(title, 28f, Palette.text, 600).apply { isFocusable = true; accessibilityHeading() }, LinearLayout.LayoutParams(0, -2, 1f))
        trailing?.let { header.addView(it) }
        add(header, height = 56.dp, bottom = 8)
    }
    private fun subPageTitle(title: String, back: () -> Unit) {
        val header = FrameLayout(this)
        header.addView(text(title, 17f, Palette.text, 600).apply { gravity = Gravity.CENTER; accessibilityHeading() }, FrameLayout.LayoutParams(-1, -1))
        header.addView(FrameLayout(this).apply {
            background = pressable(Color.TRANSPARENT, 12); contentDescription = L10n.text(R.string.back_action); setOnClickListener { back() }
            addView(icon(R.drawable.ic_chevron_left, Palette.text, 20), FrameLayout.LayoutParams(20.dp, 20.dp, Gravity.CENTER))
        }, FrameLayout.LayoutParams(44.dp, 44.dp, Gravity.CENTER_VERTICAL or Gravity.START))
        add(header, height = 52.dp, bottom = 12)
    }
    private fun TextView.accessibilityHeading() { if (Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true }
    private fun primaryButton(title: String, onClick: () -> Unit) = text(title, 16f, Palette.onAccent, 600).apply {
        gravity = Gravity.CENTER; background = RippleDrawable(ColorStateList.valueOf(Palette.alpha(Palette.onAccent, 40)), rounded(Palette.accent, 14), null)
        isClickable = true; setOnClickListener { if (!busy) onClick() }
    }
    private fun field(hint: String, value: String = "", kind: Int = InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS) = EditText(this).apply {
        this.hint = hint; setText(value); setSingleLine(true); inputType = InputType.TYPE_CLASS_TEXT or kind
        textSize = 15f; setTextColor(Palette.text); setHintTextColor(Palette.faint); setPadding(16.dp, 0, 16.dp, 0)
        background = rounded(Palette.surface, 12); textCursorDrawableTint()
    }
    private fun EditText.textCursorDrawableTint() { if (Build.VERSION.SDK_INT >= 29) textCursorDrawable?.setTint(Palette.accent); highlightColor = Palette.alpha(Palette.accent, 70) }
    private fun fieldLabel(title: String) = add(text(title, 13f, Palette.secondary).apply { setPadding(4.dp, 0, 0, 0) }, bottom = 8)
    private fun mbps(bytesPerSecond: Long) = String.format(L10n.locale, "%.1f", bytesPerSecond * 8 / 1_000_000.0)
    private fun bytes(value: Long) = android.text.format.Formatter.formatShortFileSize(this, value)
    private fun ms(quality: Quality?) = quality?.latency?.let { L10n.text(R.string.latency_ms, L10n.number(it)) }
    /** "86 ms · Good", or the grade alone when nothing answered. */
    private fun summary(quality: Quality) = ms(quality)?.let { it + " · " + L10n.text(quality.grade) } ?: L10n.text(quality.grade)

    // ---- Pages
    private fun render() {
        ring = null; stateTitle = null; stateDot = null; stateDetail = null; nodeTitle = null; nodeDetail = null; nodeBadge = null
        val side = maxOf(20.dp, (resources.displayMetrics.widthPixels - 560.dp) / 2)
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(side, 4.dp, side, 20.dp) }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Palette.ground); fitsSystemWindows = true }
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true; indeterminateTintList = ColorStateList.valueOf(Palette.accent); visibility = if (busy) View.VISIBLE else View.INVISIBLE
        }
        root.addView(progress, LinearLayout.LayoutParams(-1, 2.dp))
        root.addView(ScrollView(this).apply { isFillViewport = true; overScrollMode = View.OVER_SCROLL_NEVER; addView(content) }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        val signedIn = api.secret("token") != null
        // A new page eases in (short fade and rise); re-renders of the same page stay still.
        val view = if (signedIn) page else "login"
        if (view != lastView) { content.alpha = 0f; content.translationY = 8.dp.toFloat(); content.animate().alpha(1f).translationY(0f).setDuration(200).setInterpolator(DecelerateInterpolator()).start() }
        lastView = view
        if (!signedIn) { accountData = null; login(); return }
        when (page) {
            "connect" -> home()
            "nodes" -> nodes()
            "devices" -> devices()
            "logs" -> logs()
            else -> account()
        }
        if (page in listOf("connect", "nodes", "account")) root.addView(tabBar())
        handler.removeCallbacks(refresh); if (visible) handler.post(refresh)
    }
    private fun tabBar() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(View(this@MainActivity).apply { setBackgroundColor(Palette.hairline) }, LinearLayout.LayoutParams(-1, 1))
        val tabs = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL; setPadding(12.dp, 6.dp, 12.dp, 6.dp) }
        for ((tab, title, res) in listOf(Triple("connect", R.string.connect_tab, R.drawable.ic_tab_connect), Triple("nodes", R.string.locations, R.drawable.ic_tab_nodes), Triple("account", R.string.account, R.drawable.ic_tab_account))) {
            val selected = tab == page; val color = if (selected) Palette.accent else Palette.secondary
            tabs.addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; background = pressable(Color.TRANSPARENT, 12)
                addView(icon(res, color, 22))
                addView(text(L10n.text(title), 11f, color, 500).apply { maxLines = 1 }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 4.dp })
                contentDescription = L10n.text(title) + if (selected) L10n.text(R.string.current_page) else ""
                setOnClickListener { if (!busy && !selected) { page = tab; render() } }
            }, LinearLayout.LayoutParams(0, 52.dp, 1f))
        }
        addView(tabs)
    }
    /** Update and announcement notes: one compact card each, only when there is something to say. */
    private fun notices() {
        update?.let { available ->
            add(row(60).apply {
                background = rounded(Palette.surface, 16)
                addView(titles(L10n.text(R.string.update_available, available.version), L10n.text(if (available.mandatory) R.string.update_required_detail else R.string.update_available_detail)))
                addView(text(L10n.text(R.string.update_now), 14f, Palette.accent, 600).apply {
                    setPadding(12.dp, 10.dp, 4.dp, 10.dp); background = pressable(Color.TRANSPARENT, 10); setOnClickListener { if (!busy) installUpdate(available) }
                }, LinearLayout.LayoutParams(-2, -2).apply { marginStart = 8.dp })
            }, top = 4, bottom = 8)
        }
        if (announcement.isNotBlank()) add(text(announcement, 14f, Palette.secondary).apply { background = rounded(Palette.surface, 16); setPadding(16.dp, 14.dp, 16.dp, 14.dp) }, top = 4, bottom = 8)
    }

    /** One ring, one location row, one line of usage: everything needed to connect, on one screen. */
    private fun home() {
        add(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(4.dp, 0, 0, 0)
            addView(ImageView(this@MainActivity).apply { setImageResource(R.drawable.ic_mark) }, LinearLayout.LayoutParams(22.dp, 22.dp).apply { marginEnd = 10.dp })
            addView(text("TrackNothing", 15f, Palette.text, 600))
        }, height = 48.dp)
        notices()
        spacer(1f)
        ring = ConnectRing(this).apply {
            isClickable = true; isFocusable = true
            setOnClickListener {
                animate().scaleX(0.97f).scaleY(0.97f).setDuration(90).withEndAction { animate().scaleX(1f).scaleY(1f).setDuration(140).start() }.start()
                if (!busy) toggleConnection()
            }
        }.also { add(it, height = 216.dp, width = 216.dp, gravity = Gravity.CENTER_HORIZONTAL) }
        val titleRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        stateDot = View(this).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Palette.accent) } }
        titleRow.addView(stateDot, LinearLayout.LayoutParams(8.dp, 8.dp).apply { marginEnd = 10.dp })
        stateTitle = text("", 26f, Palette.text, 600).also { titleRow.addView(it) }
        add(titleRow, top = 36)
        stateDetail = text("", 14f, Palette.secondary).apply { gravity = Gravity.CENTER; maxLines = 2 }.also { add(it, top = 8) }
        spacer(1f)
        val node = row(68).apply { background = pressable(Palette.surface, 16); contentDescription = L10n.text(R.string.tap_to_change); setOnClickListener { if (!busy) { page = "nodes"; render() } } }
        nodeBadge = badge(null).also { node.addView(it) }
        val names = titles(" ", " "); node.addView(names)
        nodeTitle = names.getChildAt(0) as TextView; nodeDetail = names.getChildAt(1) as TextView
        node.addView(chevron())
        add(node, top = 24)
        usageStrip()
        showState()
        if (Directory.nodes.isEmpty()) Thread {
            val nodes = try { api.request("nodes").getJSONArray("nodes") } catch (_: Exception) { null } ?: return@Thread
            Directory.remember(nodes); runOnUiThread { showState() }
        }.start()
    }
    /** What this account has used and how long it runs: two quiet figures under the location. */
    private fun usageStrip() {
        val traffic = text("—", 15f, Palette.text, 500); val until = text("—", 15f, Palette.text, 500)
        val strip = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(4.dp, 0, 4.dp, 0) }
        for ((title, value) in listOf(L10n.text(R.string.last_30_days) to traffic, L10n.text(R.string.valid_until_label) to until)) strip.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(text(title, 12f, Palette.secondary).apply { maxLines = 1 })
            addView(value.apply { maxLines = 1 }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 4.dp })
        }, LinearLayout.LayoutParams(0, -2, 1f))
        add(strip, top = 16)
        fun show(data: JSONObject) { traffic.text = totalTraffic(data)?.let { bytes(it) } ?: "—"; until.text = L10n.date(data.optString("expiresAt")) }
        accountData?.let { show(it) }
        Thread {
            val data = try { api.request("account") } catch (_: Exception) { null } ?: return@Thread
            runOnUiThread { accountData = data; if (!isDestroyed && traffic.isAttachedToWindow) show(data) }
        }.start()
    }
    private fun totalTraffic(data: JSONObject) = data.optJSONObject("traffic")?.let { (it.optString("uploadBytes", "0").toLongOrNull() ?: 0) + (it.optString("downloadBytes", "0").toLongOrNull() ?: 0) }
    private fun failed() = !ConnectionStateStore.active && ConnectionStateStore.messageId !in listOf(R.string.not_connected, R.string.disconnected)
    private fun showState() {
        val active = ConnectionStateStore.active; val since = ConnectionStateStore.since
        val state = when { active && since > 0 -> ConnectRing.State.CONNECTED; active -> ConnectRing.State.CONNECTING; failed() -> ConnectRing.State.FAILED; else -> ConnectRing.State.IDLE }
        ring?.apply {
            this.state = state
            contentDescription = L10n.text(when (state) { ConnectRing.State.IDLE -> R.string.connect_action; ConnectRing.State.FAILED -> R.string.retry_action; else -> R.string.disconnect_action })
        }
        stateTitle?.text = L10n.text(when (state) { ConnectRing.State.CONNECTED -> R.string.connected_status; ConnectRing.State.CONNECTING -> R.string.connecting; ConnectRing.State.FAILED -> R.string.connect_failed_title; else -> R.string.not_connected })
        stateDot?.visibility = if (state == ConnectRing.State.CONNECTED) View.VISIBLE else View.GONE
        stateDetail?.text = when (state) {
            ConnectRing.State.CONNECTED -> if (ConnectionStateStore.messageId == R.string.confirming_connection_status) ConnectionStateStore.message
                else L10n.text(R.string.connection_stats, DateUtils.formatElapsedTime((SystemClock.elapsedRealtime() - since) / 1000), mbps(ConnectionStateStore.rxRate), mbps(ConnectionStateStore.txRate))
            ConnectRing.State.CONNECTING -> L10n.text(R.string.finding_best_route)
            ConnectRing.State.FAILED -> ConnectionStateStore.message
            else -> L10n.text(if (update?.mandatory == true) R.string.update_required_detail else R.string.tap_ring_to_connect)
        }
        showCurrentNode()
    }
    private fun showCurrentNode() {
        val title = nodeTitle ?: return; val badge = nodeBadge ?: return
        val active = ConnectionStateStore.active
        val id = if (active) ConnectionStateStore.nodeId else selectedId
        val quality = Latency.recent[id].takeIf { id.isNotEmpty() }
        val automatic = selectedId.isEmpty()
        when {
            active && id.isNotEmpty() -> {
                title.text = ConnectionStateStore.node
                nodeDetail?.text = if (automatic) ms(quality)?.let { L10n.text(R.string.connected_automatic_detail, it) } ?: L10n.text(R.string.automatic) else quality?.let { summary(it) } ?: L10n.text(R.string.tap_to_change)
                fillBadge(badge, Directory.code(id, ConnectionStateStore.node), null, Palette.text)
            }
            automatic -> {
                title.text = L10n.text(R.string.automatic)
                // The location automatic mode would pick now, when this session measured one.
                val best = Latency.recent.entries.filter { it.value.latency != null && Directory.nodes.containsKey(it.key) }.minByOrNull { it.value.score }
                nodeDetail?.text = best?.let { Directory.nodes[it.key]!!.first + " · " + ms(it.value) } ?: L10n.text(R.string.auto_detail)
                fillBadge(badge, null, R.drawable.ic_sparkle, Palette.accent)
            }
            else -> {
                title.text = selectedName
                nodeDetail?.text = quality?.let { summary(it) } ?: L10n.text(R.string.tap_to_change)
                fillBadge(badge, selectedCode.ifEmpty { Directory.code(id, selectedName) }, null, Palette.text)
            }
        }
    }
    private fun toggleConnection() {
        if (ConnectionStateStore.active) { startService(Intent(this, ConnectionService::class.java).setAction("disconnect")); return }
        if (update?.mandatory == true) { alert(L10n.text(R.string.update_required_detail)); return }
        val consent = VpnService.prepare(this); if (consent != null) startActivityForResult(consent, 10) else startConnection()
    }

    private fun login() {
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL or Gravity.END }
        // Before sign-in the only language entry is this small globe; afterwards it is a row on the account page.
        header.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; setPadding(10.dp, 0, 10.dp, 0); background = pressable(Color.TRANSPARENT, 10)
            addView(icon(R.drawable.ic_tab_nodes, Palette.secondary, 16))
            addView(text(shortLanguageName(), 13f, Palette.secondary), LinearLayout.LayoutParams(-2, -2).apply { marginStart = 6.dp })
            contentDescription = L10n.text(R.string.language) + ": " + shortLanguageName(); setOnClickListener { if (!busy) chooseLanguage() }
        }, LinearLayout.LayoutParams(-2, 40.dp))
        add(header, height = 48.dp)
        notices()
        add(ImageView(this).apply { setImageResource(R.drawable.ic_mark); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }, height = 64.dp, width = 64.dp, top = 56, gravity = Gravity.CENTER_HORIZONTAL)
        add(text("TrackNothing", 24f, Palette.text, 600).apply { gravity = Gravity.CENTER; accessibilityHeading() }, top = 16)
        add(text(L10n.text(R.string.sign_in_tagline), 14f, Palette.secondary).apply { gravity = Gravity.CENTER }, top = 8, bottom = 44)
        val server = if (BuildConfig.API_ORIGIN.isEmpty()) {
            fieldLabel(L10n.text(R.string.server_address))
            add(field(L10n.text(R.string.server_address_url), api.origin, InputType.TYPE_TEXT_VARIATION_URI), height = 50.dp, bottom = 14) as EditText
        } else null
        fieldLabel(L10n.text(R.string.email))
        val email = add(field("name@example.com"), height = 50.dp, bottom = 14) as EditText
        fieldLabel(L10n.text(R.string.password))
        val password = field(L10n.text(R.string.enter_password), kind = InputType.TYPE_TEXT_VARIATION_PASSWORD).apply { setPadding(16.dp, 0, 52.dp, 0) }
        add(FrameLayout(this).apply {
            addView(password, FrameLayout.LayoutParams(-1, -1))
            var shown = false
            addView(ImageView(this@MainActivity).apply {
                setImageResource(R.drawable.ic_eye); imageTintList = ColorStateList.valueOf(Palette.secondary); setPadding(12.dp, 12.dp, 12.dp, 12.dp)
                background = pressable(Color.TRANSPARENT, 10); contentDescription = L10n.text(R.string.show_password)
                setOnClickListener {
                    shown = !shown; val at = password.selectionEnd
                    password.inputType = InputType.TYPE_CLASS_TEXT or if (shown) InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD else InputType.TYPE_TEXT_VARIATION_PASSWORD
                    password.setSelection(maxOf(0, at)); setImageResource(if (shown) R.drawable.ic_eye_off else R.drawable.ic_eye)
                    contentDescription = L10n.text(if (shown) R.string.hide_password else R.string.show_password)
                }
            }, FrameLayout.LayoutParams(44.dp, 44.dp, Gravity.END or Gravity.CENTER_VERTICAL).apply { marginEnd = 3.dp })
        }, height = 50.dp)
        add(primaryButton(L10n.text(R.string.sign_in_action)) {
            val origin = server?.text?.toString(); val address = email.text.toString().trim(); val secret = password.text.toString()
            if (address.isBlank() || secret.isEmpty()) { alert(L10n.text(R.string.enter_your_email_and_password)); return@primaryButton }
            work({ if (origin != null) api.origin = origin; api.login(address, secret) }) { password.setText(""); page = "connect"; render(); checkForUpdate() }
        }, height = 52.dp, top = 28)
    }

    private var measuring = false
    private fun nodes() {
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
    private fun routingChoice() {
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
    private fun show(list: LinearLayout, ranked: List<Pair<JSONObject, Quality?>>, query: String) {
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
                if (latency.isNotEmpty()) addView(text(latency, 13f, if (unreachable) Palette.faint else Palette.secondary), LinearLayout.LayoutParams(-2, -2).apply { marginStart = 8.dp })
                if (quality != null && !unreachable) addView(SignalBars(this@MainActivity).apply {
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
    private fun select(id: String, name: String, code: String) {
        if (ConnectionStateStore.active) { alert(L10n.text(R.string.disconnect_before_selecting_another_location)); return }
        selectedId = id; selectedName = name; selectedCode = code; page = "connect"; render()
        getSharedPreferences("preferences", MODE_PRIVATE).edit().putString("nodeId", id).putString("nodeName", name).putString("nodeCode", code).apply()
    }

    /** Builds a page from the cached account at once and refreshes it in the background. */
    private fun withAccount(build: (JSONObject) -> Unit) {
        val shown = accountData?.also { build(it) }
        val forPage = page
        if (shown == null) { work({ api.request("account") }) { data -> accountData = data; if (page == forPage) build(data) }; return }
        Thread {
            val data = try { api.request("account") } catch (_: Exception) { null } ?: return@Thread
            runOnUiThread { val changed = data.toString() != accountData?.toString(); accountData = data; if (changed && !isDestroyed && page == forPage && !busy) render() }
        }.start()
    }
    private fun account() {
        pageTitle(L10n.text(R.string.account))
        withAccount { data ->
            val email = data.optString("email"); val name = data.optString("name").ifBlank { email }
            add(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(4.dp, 0, 4.dp, 0)
                addView(text(name.take(1).uppercase(L10n.locale), 18f, Palette.accent, 600).apply {
                    gravity = Gravity.CENTER; background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Palette.raised) }
                }, LinearLayout.LayoutParams(48.dp, 48.dp).apply { marginEnd = 14.dp })
                addView(LinearLayout(this@MainActivity).apply {
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
            add(text("TrackNothing " + BuildConfig.VERSION_NAME, 12f, Palette.faint).apply {
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
    private fun usageCard(data: JSONObject) {
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
        card.addView(text(styled, 34f, Palette.text, 600), LinearLayout.LayoutParams(-2, -2).apply { topMargin = 14.dp })
        val perDay = HashMap<String, Long>()
        traffic.optJSONArray("days")?.let { days -> for (i in 0 until days.length()) days.optJSONObject(i)?.let { perDay[it.optString("day")] = it.optString("bytes", "0").toLongOrNull() ?: 0 } }
        if (perDay.isNotEmpty()) {
            val today = LocalDate.now()
            card.addView(UsageBars(this).apply { values = (29 downTo 0).map { perDay[today.minusDays(it.toLong()).toString()] ?: 0L }; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO },
                LinearLayout.LayoutParams(-1, 40.dp).apply { topMargin = 14.dp })
        }
        card.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(text(L10n.text(R.string.download_amount, bytes(down)), 13f, Palette.secondary), LinearLayout.LayoutParams(-2, -2).apply { marginEnd = 20.dp })
            addView(text(L10n.text(R.string.upload_amount, bytes(up)), 13f, Palette.secondary))
        }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 14.dp })
        add(card, top = 20)
    }
    private fun devices() {
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
                    addView(FrameLayout(this@MainActivity).apply {
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
    private fun platformName(value: String) = when (value.lowercase()) { "android" -> "Android"; "ios" -> "iOS"; "ipados" -> "iPadOS"; "macos" -> "macOS"; "windows" -> "Windows"; "" -> null; else -> value }
    private fun revoke(device: JSONObject) {
        AlertDialog.Builder(this).setTitle(L10n.text(R.string.revoke_this_device_s_access)).setMessage(L10n.text(R.string.this_device_will_no_longer_be_able_to_connect))
            .setNegativeButton(L10n.text(R.string.cancel), null).setPositiveButton(L10n.text(R.string.revoke_access)) { _, _ ->
                work({ api.action("revoke", JSONObject().put("enrollmentId", device.getString("id"))); api.request("account") }) { data ->
                    accountData = data
                    if (device.getBoolean("isCurrent") && ConnectionStateStore.active) startService(Intent(this, ConnectionService::class.java).setAction("disconnect"))
                    render()
                }
            }.show()
    }
    private fun logs() {
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
    private val languages get() = listOf("system" to L10n.text(R.string.language_system), "zh" to "简体中文", "en" to "English", "ru" to "Русский")
    private fun currentLanguage() = L10n.preference.substringBefore('-').let { code -> languages.firstOrNull { it.first == code } ?: languages[0] }
    private fun shortLanguageName() = when (L10n.locale.language) { "zh" -> "中文"; "ru" -> "Русский"; else -> "English" }
    private fun chooseLanguage() {
        val current = currentLanguage().first
        sheet(L10n.text(R.string.language), languages.map { it.second }, languages.indexOfFirst { it.first == current }) { which ->
            if (languages[which].first != current) { L10n.select(languages[which].first); if (Build.VERSION.SDK_INT < 33) recreate() }
        }
    }
    private fun sheet(title: String, options: List<String>, checked: Int, onPick: (Int) -> Unit) {
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

    private fun <T> work(task: () -> T, success: (T) -> Unit) {
        if (busy) return
        busy = true
        progress?.visibility = View.VISIBLE
        executor.execute {
            try { val result = task(); runOnUiThread { busy = false; if (!measuring) progress?.visibility = View.INVISIBLE; if (!isDestroyed) success(result) } }
            catch (e: Exception) { runOnUiThread { busy = false; if (!measuring) progress?.visibility = View.INVISIBLE; if (!isDestroyed) { if ((e as? ApiFailure)?.code == "AUTH_REQUIRED") { api.saveSecret("token", null); render() }; if ((e as? ApiFailure)?.code == "CLIENT_UPDATE_REQUIRED") checkForUpdate(); alert(friendly(e)) } } }
        }
    }
    /** Background check; failures are silent (the next launch checks again) unless someone asked from the account page. */
    private fun checkForUpdate(announce: Boolean = false) {
        Thread {
            val found = try { updater.check() } catch (_: Exception) { null }
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                if (found == null) { if (announce) Toast.makeText(this, L10n.text(R.string.unable_to_reach_the_service_check_your_network_and), Toast.LENGTH_SHORT).show(); return@runOnUiThread }
                if (announce && found.update == null) Toast.makeText(this, L10n.text(R.string.up_to_date), Toast.LENGTH_SHORT).show()
                if (found.update?.build != update?.build || found.announcement != announcement) { update = found.update; announcement = found.announcement; if (!busy) render() }
            }
        }.start()
    }
    private fun installUpdate(available: UpdateInfo) {
        if (!updater.canInstall()) { alert(L10n.text(R.string.update_allow_installs)); startActivity(updater.installPermissionIntent()); return }
        Toast.makeText(this, L10n.text(R.string.update_downloading), Toast.LENGTH_SHORT).show()
        work({ updater.downloadAndInstall(available) }) {}
    }
    private fun alert(message: String) { AlertDialog.Builder(this).setTitle("TrackNothing").setMessage(message).setPositiveButton(L10n.text(R.string.got_it), null).show() }
    private fun startConnection() { startForegroundService(Intent(this, ConnectionService::class.java).putExtra("nodeId", selectedId)) }
    @Deprecated("Activity result compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 10) { if (resultCode == RESULT_OK) startConnection() else alert(L10n.text(R.string.allow_the_system_vpn_permission_to_connect)) }
    }
}

/** Names and country codes of the locations seen this session, for the connect page's badge and "fastest" line. */
object Directory {
    val nodes = ConcurrentHashMap<String, Pair<String, String?>>()
    fun remember(list: org.json.JSONArray) {
        for (i in 0 until list.length()) list.optJSONObject(i)?.let { node ->
            nodes[node.getString("id")] = node.getString("name") to node.optString("countryCode").takeIf { it.length == 2 }?.uppercase()
        }
    }
    /** The country code, or the name's first letter when the location has no region. */
    fun code(id: String, name: String): String = nodes[id]?.second ?: name.trim().take(1).uppercase()
}
