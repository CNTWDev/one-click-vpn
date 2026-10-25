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
    internal lateinit var api: NativeApi
    internal lateinit var updater: Updater
    internal var update: UpdateInfo? = null
    internal var announcement = ""
    internal lateinit var content: LinearLayout
    internal val executor = Executors.newSingleThreadExecutor()
    internal val handler = Handler(Looper.getMainLooper())
    internal var selectedId = ""
    internal var selectedName = ""
    internal var selectedCode = ""
    internal var page = "connect"
    internal var busy = false
    internal var visible = false
    internal var progress: ProgressBar? = null
    internal var lastView = ""
    // The last account summary, so pages show usage at once and refresh it quietly.
    internal var accountData: JSONObject? = null
    // Connect page views that the once-a-second refresh updates.
    internal var ring: ConnectRing? = null
    internal var stateTitle: TextView? = null
    internal var stateDot: View? = null
    internal var stateDetail: TextView? = null
    internal var stateTimer: TextView? = null
    internal var stream: DataStream? = null
    internal var nodeTitle: TextView? = null
    internal var nodeDetail: TextView? = null
    internal var nodeBadge: FrameLayout? = null
    internal val refresh = object : Runnable {
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
    internal val Int.dp get() = (this * resources.displayMetrics.density).toInt()
    internal fun rounded(color: Int, radius: Int) = GradientDrawable().apply { setColor(color); cornerRadius = radius.dp.toFloat() }
    internal fun pressable(color: Int, radius: Int): Drawable =
        RippleDrawable(ColorStateList.valueOf(Palette.alpha(Palette.text, 22)), if (color == Color.TRANSPARENT) null else rounded(color, radius), rounded(Color.WHITE, radius))
    internal fun TextView.weight(value: Int) = apply {
        typeface = when {
            Build.VERSION.SDK_INT >= 28 -> Typeface.create(Typeface.DEFAULT, value, false)
            value >= 600 -> Typeface.DEFAULT_BOLD
            value >= 500 -> Typeface.create("sans-serif-medium", Typeface.NORMAL)
            else -> Typeface.DEFAULT
        }
    }
    internal fun text(value: CharSequence, size: Float, color: Int = Palette.text, weight: Int = 400) = TextView(this).apply {
        text = value; textSize = size; setTextColor(color); weight(weight); includeFontPadding = false
        if (size >= 24) letterSpacing = -0.015f
        setLineSpacing(3.dp.toFloat(), 1f)
    }
    /** "TRACKNOTHING" in the dot-matrix face: shown once per screen, next to the pixel mark. */
    internal fun wordmark(size: Float) = text("TRACKNOTHING", size).apply { typeface = Pixel.font(this@MainActivity); letterSpacing = 0.04f; contentDescription = "TrackNothing" }
    internal fun icon(res: Int, color: Int, size: Int = 20) = ImageView(this).apply {
        setImageResource(res); imageTintList = ColorStateList.valueOf(color); scaleType = ImageView.ScaleType.FIT_CENTER
        layoutParams = LinearLayout.LayoutParams(size.dp, size.dp)
    }
    internal fun add(view: View, height: Int = -2, top: Int = 0, bottom: Int = 0, width: Int = -1, gravity: Int = -1) =
        view.also { content.addView(it, LinearLayout.LayoutParams(width, height).apply { topMargin = top.dp; bottomMargin = bottom.dp; if (gravity != -1) this.gravity = gravity }) }
    internal fun spacer(weight: Float) = add(View(this), height = 0).apply { (layoutParams as LinearLayout.LayoutParams).weight = weight }
    internal fun row(minHeight: Int = 54) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = minHeight.dp; setPadding(16.dp, 8.dp, 16.dp, 8.dp)
    }
    /** A 36dp tile with a two-letter country code or an icon. */
    internal fun badge(code: String?, iconRes: Int? = null, tint: Int = Palette.text) = FrameLayout(this).apply {
        background = rounded(Palette.raised, 8)
        fillBadge(this, code, iconRes, tint)
        layoutParams = LinearLayout.LayoutParams(36.dp, 36.dp).apply { marginEnd = 14.dp }
    }
    internal fun fillBadge(badge: FrameLayout, code: String?, iconRes: Int?, tint: Int) {
        badge.removeAllViews()
        if (iconRes != null) badge.addView(icon(iconRes, tint, 18), FrameLayout.LayoutParams(18.dp, 18.dp, Gravity.CENTER))
        else badge.addView(text(code ?: "", 15f, if (tint == Palette.text) Palette.accent else tint).apply { gravity = Gravity.CENTER; typeface = Pixel.font(this@MainActivity) }, FrameLayout.LayoutParams(-1, -1))
    }
    /** Title with an optional second line, filling the space between a badge and trailing views. */
    internal fun titles(title: String, detail: String = "", titleColor: Int = Palette.text): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(text(title, 15f, titleColor, 500).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
        addView(text(detail, 13f, Palette.secondary).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END; visibility = if (detail.isEmpty()) View.GONE else View.VISIBLE },
            LinearLayout.LayoutParams(-2, -2).apply { topMargin = 3.dp })
        layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
    }
    /** A card of rows separated by hairlines; the line starts after the badge when rows have one. */
    internal fun group(rows: List<View>, inset: Int = 16, color: Int = Palette.surface) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; background = rounded(color, 16); clipToOutline = true
        rows.forEachIndexed { i, row ->
            if (i > 0) addView(View(this@MainActivity).apply { setBackgroundColor(Palette.hairline) }, LinearLayout.LayoutParams(-1, 1).apply { marginStart = inset.dp })
            row.background = row.background ?: pressable(Color.TRANSPARENT, 0)
            addView(row, LinearLayout.LayoutParams(-1, -2))
        }
    }
    internal fun chevron() = icon(R.drawable.ic_chevron_right, Palette.secondary, 16)
    internal fun settingRow(title: String, value: String, onClick: () -> Unit) = row().apply {
        addView(text(title, 15f).apply { maxLines = 1 }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(text(value, 14f, Palette.secondary).apply { maxLines = 1 }, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = 8.dp })
        addView(chevron()); contentDescription = "$title: $value"
        setOnClickListener { if (!busy) onClick() }
    }
    internal fun pageTitle(title: String, trailing: View? = null) {
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(4.dp, 0, 0, 0) }
        header.addView(text(title, 28f, Palette.text, 600).apply { isFocusable = true; accessibilityHeading() }, LinearLayout.LayoutParams(0, -2, 1f))
        trailing?.let { header.addView(it) }
        add(header, height = 56.dp, bottom = 8)
    }
    internal fun subPageTitle(title: String, back: () -> Unit) {
        val header = FrameLayout(this)
        header.addView(text(title, 17f, Palette.text, 600).apply { gravity = Gravity.CENTER; accessibilityHeading() }, FrameLayout.LayoutParams(-1, -1))
        header.addView(FrameLayout(this).apply {
            background = pressable(Color.TRANSPARENT, 12); contentDescription = L10n.text(R.string.back_action); setOnClickListener { back() }
            addView(icon(R.drawable.ic_chevron_left, Palette.text, 20), FrameLayout.LayoutParams(20.dp, 20.dp, Gravity.CENTER))
        }, FrameLayout.LayoutParams(44.dp, 44.dp, Gravity.CENTER_VERTICAL or Gravity.START))
        add(header, height = 52.dp, bottom = 12)
    }
    internal fun TextView.accessibilityHeading() { if (Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true }
    internal fun primaryButton(title: String, onClick: () -> Unit) = text(title, 16f, Palette.onAccent, 600).apply {
        gravity = Gravity.CENTER; background = RippleDrawable(ColorStateList.valueOf(Palette.alpha(Palette.onAccent, 40)), rounded(Palette.accent, 14), null)
        isClickable = true; setOnClickListener { if (!busy) onClick() }
    }
    internal fun field(hint: String, value: String = "", kind: Int = InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS) = EditText(this).apply {
        this.hint = hint; setText(value); setSingleLine(true); inputType = InputType.TYPE_CLASS_TEXT or kind
        textSize = 15f; setTextColor(Palette.text); setHintTextColor(Palette.faint); setPadding(16.dp, 0, 16.dp, 0)
        background = rounded(Palette.surface, 12); textCursorDrawableTint()
    }
    internal fun EditText.textCursorDrawableTint() { if (Build.VERSION.SDK_INT >= 29) textCursorDrawable?.setTint(Palette.accent); highlightColor = Palette.alpha(Palette.accent, 70) }
    internal fun fieldLabel(title: String) = add(text(title, 13f, Palette.secondary).apply { setPadding(4.dp, 0, 0, 0) }, bottom = 8)
    internal fun mbps(bytesPerSecond: Long) = String.format(L10n.locale, "%.1f", bytesPerSecond * 8 / 1_000_000.0)
    internal fun bytes(value: Long) = android.text.format.Formatter.formatShortFileSize(this, value)
    internal fun ms(quality: Quality?) = quality?.latency?.let { L10n.text(R.string.latency_ms, L10n.number(it)) }
    /** "86 ms · Good", or the grade alone when nothing answered. */
    internal fun summary(quality: Quality) = ms(quality)?.let { it + " · " + L10n.text(quality.grade) } ?: L10n.text(quality.grade)

    // ---- Pages
    internal fun render() {
        ring = null; stateTitle = null; stateDot = null; stateDetail = null; stateTimer = null; stream = null; nodeTitle = null; nodeDetail = null; nodeBadge = null
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
    internal fun tabBar() = LinearLayout(this).apply {
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
    internal fun notices() {
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
    internal fun home() {
        add(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(4.dp, 0, 0, 0)
            addView(PixelMark(this@MainActivity), LinearLayout.LayoutParams(22.dp, 22.dp).apply { marginEnd = 10.dp })
            addView(wordmark(18f))
        }, height = 48.dp)
        notices()
        spacer(1f)
        ring = ConnectRing(this).apply {
            isClickable = true; isFocusable = true
            setOnClickListener {
                animate().scaleX(0.97f).scaleY(0.97f).setDuration(90).withEndAction { animate().scaleX(1f).scaleY(1f).setDuration(140).start() }.start()
                if (!busy) toggleConnection()
            }
        }.also { add(it, height = 240.dp, width = 240.dp, gravity = Gravity.CENTER_HORIZONTAL) }
        val titleRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        stateDot = View(this).apply { setBackgroundColor(Palette.accent) }
        titleRow.addView(stateDot, LinearLayout.LayoutParams(8.dp, 8.dp).apply { marginEnd = 10.dp })
        stateTitle = text("", 26f, Palette.text, 600).also { titleRow.addView(it) }
        add(titleRow, top = 28)
        stateTimer = text("", 34f).apply { gravity = Gravity.CENTER; typeface = Pixel.font(this@MainActivity); letterSpacing = 0.02f }.also { add(it, top = 10) }
        stateDetail = text("", 14f, Palette.secondary).apply { gravity = Gravity.CENTER; maxLines = 2 }.also { add(it, top = 8) }
        stream = DataStream(this).also { add(it, top = 22) }
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
    /** What this account has left (or used) and how long it runs: two quiet figures under the location. */
    internal fun usageStrip() {
        val trafficTitle = text(L10n.text(R.string.last_30_days), 12f, Palette.secondary).apply { maxLines = 1 }
        val traffic = text("—", 15f, Palette.text, 500); val until = text("—", 15f, Palette.text, 500)
        val strip = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(4.dp, 0, 4.dp, 0) }
        for ((title, value) in listOf(trafficTitle to traffic, text(L10n.text(R.string.valid_until_label), 12f, Palette.secondary).apply { maxLines = 1 } to until)) strip.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(title)
            addView(value.apply { maxLines = 1 }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 4.dp })
        }, LinearLayout.LayoutParams(0, -2, 1f))
        add(strip, top = 16)
        fun show(data: JSONObject) {
            val access = AccountAccess.from(data)
            trafficTitle.text = L10n.text(if (access.metered) R.string.traffic_left else R.string.last_30_days)
            traffic.text = if (access.metered) bytes(access.remainingBytes) else totalTraffic(data)?.let { bytes(it) } ?: "—"
            traffic.setTextColor(when { access.state == "exhausted" -> Palette.danger; access.low -> Palette.fair; else -> Palette.text })
            until.text = L10n.date(data.optString("expiresAt"))
            until.setTextColor(when { access.state == "expired" -> Palette.danger; access.ending -> Palette.fair; else -> Palette.text })
        }
        accountData?.let { show(it) }
        Thread {
            val data = try { api.request("account") } catch (_: Exception) { null } ?: return@Thread
            runOnUiThread { accountData = data; if (!isDestroyed && traffic.isAttachedToWindow) show(data) }
        }.start()
    }
    internal fun totalTraffic(data: JSONObject) = data.optJSONObject("traffic")?.let { (it.optString("uploadBytes", "0").toLongOrNull() ?: 0) + (it.optString("downloadBytes", "0").toLongOrNull() ?: 0) }
    internal fun failed() = !ConnectionStateStore.active && ConnectionStateStore.messageId !in listOf(R.string.not_connected, R.string.disconnected)
    internal fun showState() {
        val active = ConnectionStateStore.active; val since = ConnectionStateStore.since
        val state = when { active && since > 0 -> ConnectRing.State.CONNECTED; active -> ConnectRing.State.CONNECTING; failed() -> ConnectRing.State.FAILED; else -> ConnectRing.State.IDLE }
        ring?.apply {
            this.state = state
            contentDescription = L10n.text(when (state) { ConnectRing.State.IDLE -> R.string.connect_action; ConnectRing.State.FAILED -> R.string.retry_action; ConnectRing.State.CONNECTING -> R.string.cancel; else -> R.string.disconnect_action })
        }
        stateTitle?.text = L10n.text(when (state) { ConnectRing.State.CONNECTED -> R.string.connected_status; ConnectRing.State.CONNECTING -> R.string.connecting; ConnectRing.State.FAILED -> R.string.connect_failed_title; else -> R.string.not_connected })
        stateDot?.visibility = if (state == ConnectRing.State.CONNECTED) View.VISIBLE else View.GONE
        val elapsed = if (state == ConnectRing.State.CONNECTED) DateUtils.formatElapsedTime((SystemClock.elapsedRealtime() - since) / 1000) else ""
        stateTimer?.apply { text = elapsed; visibility = if (elapsed.isEmpty()) View.GONE else View.VISIBLE }
        stream?.running = state == ConnectRing.State.CONNECTING || state == ConnectRing.State.CONNECTED
        stateDetail?.text = when (state) {
            ConnectRing.State.CONNECTED -> if (ConnectionStateStore.messageId == R.string.confirming_connection_status) ConnectionStateStore.message
                else L10n.text(R.string.connection_rates, mbps(ConnectionStateStore.rxRate), mbps(ConnectionStateStore.txRate))
            ConnectRing.State.CONNECTING -> L10n.text(R.string.finding_best_route)
            ConnectRing.State.FAILED -> ConnectionStateStore.message
            else -> L10n.text(if (update?.mandatory == true) R.string.update_required_detail else R.string.tap_ring_to_connect)
        }
        showCurrentNode()
    }
    internal fun showCurrentNode() {
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
    internal fun toggleConnection() {
        if (ConnectionStateStore.active) { startService(Intent(this, ConnectionService::class.java).setAction("disconnect")); return }
        if (update?.mandatory == true) { alert(L10n.text(R.string.update_required_detail)); return }
        val consent = VpnService.prepare(this); if (consent != null) startActivityForResult(consent, 10) else startConnection()
    }

    internal fun login() {
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
        add(PixelMark(this), height = 96.dp, width = 96.dp, top = 48, gravity = Gravity.CENTER_HORIZONTAL)
        add(wordmark(30f).apply { gravity = Gravity.CENTER; accessibilityHeading() }, top = 22)
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

    internal var measuring = false
    internal fun <T> work(task: () -> T, success: (T) -> Unit) {
        if (busy) return
        busy = true
        progress?.visibility = View.VISIBLE
        executor.execute {
            try { val result = task(); runOnUiThread { busy = false; if (!measuring) progress?.visibility = View.INVISIBLE; if (!isDestroyed) success(result) } }
            catch (e: Exception) { runOnUiThread { busy = false; if (!measuring) progress?.visibility = View.INVISIBLE; if (!isDestroyed) { if ((e as? ApiFailure)?.code == "AUTH_REQUIRED") { api.saveSecret("token", null); render() }; if ((e as? ApiFailure)?.code == "CLIENT_UPDATE_REQUIRED") checkForUpdate(); alert(friendly(e)) } } }
        }
    }
    /** Background check; failures are silent (the next launch checks again) unless someone asked from the account page. */
    internal fun checkForUpdate(announce: Boolean = false) {
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
    internal fun installUpdate(available: UpdateInfo) {
        if (!updater.canInstall()) { alert(L10n.text(R.string.update_allow_installs)); startActivity(updater.installPermissionIntent()); return }
        Toast.makeText(this, L10n.text(R.string.update_downloading), Toast.LENGTH_SHORT).show()
        work({ updater.downloadAndInstall(available) }) {}
    }
    internal fun alert(message: String) { AlertDialog.Builder(this).setTitle("TrackNothing").setMessage(message).setPositiveButton(L10n.text(R.string.got_it), null).show() }
    internal fun startConnection() { startForegroundService(Intent(this, ConnectionService::class.java).putExtra("nodeId", selectedId)) }
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
