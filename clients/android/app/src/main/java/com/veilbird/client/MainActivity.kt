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
import android.animation.LayoutTransition
import android.animation.ValueAnimator
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.ZoneOffset
import com.veilbird.core.Core
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var api: NativeApi
    private lateinit var updater: Updater
    private var update: UpdateInfo? = null
    private var announcement = ""
    // The update banner and the account page's update row follow one state: available, downloading, ready, failed.
    private var downloading = false
    private var download: DownloadState? = null
    private var downloadError = ""
    private var banner: LinearLayout? = null
    private var updateRowValue: TextView? = null
    private var launched = false
    private lateinit var content: LinearLayout
    /** One backdrop for the app's life, so its slow drift carries on across pages. */
    private val space by lazy { SpaceView(this) }
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
    private var stamp: View? = null
    private var action: View? = null
    private var dock: LinearLayout? = null
    private var actionLabel: TextView? = null
    private var actionDot: View? = null
    private var scan: ScanLine? = null
    private var fileLines: List<SealedText>? = null
    // Whether the file was last shown sealed; null before the first show on a page (which does not animate).
    private var sealedShown: Boolean? = null
    private var shownState: LinkState? = null
    private var visitorIp: String? = null
    private var stateTitle: TextView? = null
    private var stateDot: View? = null
    private var stateDetail: TextView? = null
    private var stateTimer: TextView? = null
    private var stateRates: TextView? = null
    private var accountDot: View? = null
    private var nodeTitle: TextView? = null
    private var nodeDetail: TextView? = null
    private var nodeBadge: FrameLayout? = null
    private var rateBars: RateBars? = null
    private var switchNote: View? = null
    private var switchText: TextView? = null
    // The note is dismissed per switch: a later switch shows it again.
    private var dismissedSwitch = ""
    // Download / upload rates of the last 40 seconds for the connect page's chart, newest last.
    private val rxHistory = ArrayDeque<Long>(); private val txHistory = ArrayDeque<Long>()
    private var usageRange = "30d"
    // Activity tab: which view, which connections, and the part refreshed each second.
    private var activityTab = "conns"
    private var activityFilter = "all"
    private var activityBody: LinearLayout? = null
    private var activityLoading = false
    private val refresh = object : Runnable {
        override fun run() { showState(); if (page == "activity") loadActivity(); if (visible) handler.postDelayed(this, 1000) }
    }
    private val downloadTick = object : Runnable {
        override fun run() { if (!downloading) return; download = updater.progress(); showUpdate(); handler.postDelayed(this, 300) }
    }
    /** Not while a connection is being set up: the check would compete with it for the network. */
    private val updateCheck = object : Runnable {
        override fun run() {
            if (ConnectionStateStore.active && ConnectionStateStore.since == 0L) { handler.postDelayed(this, 10_000); return }
            checkForUpdate()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); api = NativeApi(this); updater = Updater(this, api); NodeCache.restore(this)
        val settings = getSharedPreferences("preferences", MODE_PRIVATE)
        Palette.theme = settings.getString("appearance", "amber")!!
        selectedId = settings.getString("nodeId", "")!!; selectedName = settings.getString("nodeName", "")!!; selectedCode = settings.getString("nodeCode", "")!!
        @Suppress("DEPRECATION") window.apply { statusBarColor = Palette.ground; navigationBarColor = Palette.ground; decorView.systemUiVisibility = 0 }
        render()
        executor.execute { Crash.send(this, api) }
        // The Quick Settings tile could not start the VPN from the background: connect now that the app is open.
        if (intent?.getBooleanExtra("connect", false) == true && api.secret("token") != null && !ConnectionStateStore.active) toggleConnection()
    }
    override fun onResume() {
        super.onResume(); visible = true; handler.post(refresh)
        // At launch, and when the app comes back after six hours: refresh the location list quietly.
        if (System.currentTimeMillis() - NodeCache.loadedAt > NodeCache.RESUME_MS || !nodesLoaded) { nodesLoaded = true; refreshNodes() }
        // At launch a few seconds after the first frame, then whenever the app returns after six hours or more.
        val due = !launched || System.currentTimeMillis() - updater.checkedAt > 6 * 3_600_000L
        launched = true
        if (due && !downloading) { handler.removeCallbacks(updateCheck); handler.postDelayed(updateCheck, 3000) }
    }
    override fun onPause() { visible = false; handler.removeCallbacks(refresh); super.onPause() }
    override fun onDestroy() { handler.removeCallbacks(updateCheck); handler.removeCallbacks(downloadTick); executor.shutdown(); super.onDestroy() }
    @Deprecated("Back handling for API 26+")
    override fun onBackPressed() {
        when (page) {
            "devices", "logs" -> { page = "account"; render() }
            "nodes", "account", "activity" -> { page = "connect"; render() }
            else -> super.onBackPressed()
        }
    }

    // ---- Building blocks: one radius (nearly square), one palette, one type scale.
    private val Int.dp get() = (this * resources.displayMetrics.density).toInt()
    // A "surface" block is drawn as a hairline outline on the ground (same as the Portal and Console cards).
    // Corners are nearly square (at most 4dp) like the sheets of a file; an "accent" control is an amber outline.
    private fun rounded(color: Int, radius: Int) = GradientDrawable().apply {
        when (color) {
            Palette.surface -> { setColor(Color.TRANSPARENT); setStroke(1.dp, Palette.edge) }
            Palette.accent -> { setColor(Palette.alpha(Palette.accent, 15)); setStroke(1.dp, Palette.alpha(Palette.accent, 180)) }
            else -> setColor(color)
        }
        cornerRadius = minOf(radius, 4).dp.toFloat()
    }
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
    /** "TRACKNOTHING" in the dot-matrix face: shown once per screen, next to the pixel mark. */
    private fun wordmark(size: Float) = text("TRACKNOTHING", size).apply { typeface = Pixel.font(this@MainActivity); letterSpacing = 0.04f; contentDescription = "TrackNothing" }
    private fun icon(res: Int, color: Int, size: Int = 20) = ImageView(this).apply {
        setImageResource(res); imageTintList = ColorStateList.valueOf(color); scaleType = ImageView.ScaleType.FIT_CENTER
        layoutParams = LinearLayout.LayoutParams(size.dp, size.dp)
    }
    private fun add(view: View, height: Int = -2, top: Int = 0, bottom: Int = 0, width: Int = -1, gravity: Int = -1) =
        view.also { content.addView(it, LinearLayout.LayoutParams(width, height).apply { topMargin = top.dp; bottomMargin = bottom.dp; if (gravity != -1) this.gravity = gravity }) }
    /** A height in px for [size] sp of text, so reserved slots grow with the system font size. */
    private fun sp(size: Float) = android.util.TypedValue.applyDimension(android.util.TypedValue.COMPLEX_UNIT_SP, size, resources.displayMetrics).toInt()
    /** Fades a view in or out (it keeps its space either way); repeated calls with the same target do nothing. */
    private fun View.fade(on: Boolean) {
        val target = if (on) 1f else 0f
        if (getTag(R.id.fade_target) == target) return
        setTag(R.id.fade_target, target); animate().cancel()
        if (!isAttachedToWindow || !ValueAnimator.areAnimatorsEnabled()) { alpha = target; visibility = if (on) View.VISIBLE else View.INVISIBLE; return }
        if (on) visibility = View.VISIBLE
        animate().alpha(target).setDuration(if (on) 220 else 160).setInterpolator(DecelerateInterpolator()).withEndAction { if (!on) visibility = View.INVISIBLE }.start()
    }
    /** Changes a line of text with a short cross-fade instead of a cut; the same text again does nothing. */
    private fun TextView.swap(value: CharSequence) {
        if (text.toString() == value.toString()) return
        if (!isAttachedToWindow || !ValueAnimator.areAnimatorsEnabled() || text.isEmpty()) { text = value; return }
        val shown = getTag(R.id.fade_target) != 0f
        animate().cancel()
        animate().alpha(0f).setDuration(90).withEndAction { text = value; if (shown) animate().alpha(1f).setDuration(160).setInterpolator(DecelerateInterpolator()).start() }.start()
    }
    private fun spacer(weight: Float) = add(View(this), height = 0).apply { (layoutParams as LinearLayout.LayoutParams).weight = weight }
    private fun row(minHeight: Int = 54) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = minHeight.dp; setPadding(16.dp, 8.dp, 16.dp, 8.dp)
    }
    /** A 36dp tile with a two-letter country code or an icon. */
    private fun badge(code: String?, iconRes: Int? = null, tint: Int = Palette.text) = FrameLayout(this).apply {
        background = rounded(Palette.raised, 8)
        fillBadge(this, code, iconRes, tint)
        layoutParams = LinearLayout.LayoutParams(36.dp, 36.dp).apply { marginEnd = 14.dp }
    }
    private fun fillBadge(badge: FrameLayout, code: String?, iconRes: Int?, tint: Int) {
        badge.removeAllViews()
        if (iconRes != null) badge.addView(icon(iconRes, tint, 18), FrameLayout.LayoutParams(18.dp, 18.dp, Gravity.CENTER))
        else badge.addView(text(code ?: "", 15f, if (tint == Palette.text) Palette.accent else tint).apply { gravity = Gravity.CENTER; typeface = Pixel.font(this@MainActivity) }, FrameLayout.LayoutParams(-1, -1))
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
        addView(chevron()); contentDescription = if (value.isEmpty()) title else "$title: $value"
        setOnClickListener { if (!busy) onClick() }
    }
    /** A main page opens like a sheet of the file: the file header, its § number, then the title. */
    private fun pageTitle(title: String, trailing: View? = null, section: Int? = null) {
        fileHeader()
        section?.let { add(sectionLabel(it), top = 14) }
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(4.dp, 0, 0, 0) }
        header.addView(text(title, 30f, Palette.text, 300).apply { isFocusable = true; accessibilityHeading(); maxLines = 1; ellipsize = TextUtils.TruncateAt.END }, LinearLayout.LayoutParams(0, -2, 1f))
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
        banner = null; updateRowValue = null; onNodes = null; onMeasured = null
        stamp = null; action = null; actionLabel = null; actionDot = null; scan = null; fileLines = null; stateTitle = null; stateDot = null; stateDetail = null; stateTimer = null; stateRates = null; accountDot = null; nodeTitle = null; nodeDetail = null; nodeBadge = null
        rateBars = null; switchNote = null; switchText = null; activityBody = null
        val side = maxOf(20.dp, (resources.displayMetrics.widthPixels - 560.dp) / 2)
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(side, 4.dp, side, 20.dp) }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; fitsSystemWindows = true }
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true; indeterminateTintList = ColorStateList.valueOf(Palette.accent); visibility = if (busy) View.VISIBLE else View.INVISIBLE
        }
        root.addView(progress, LinearLayout.LayoutParams(-1, 2.dp))
        root.addView(ScrollView(this).apply { isFillViewport = true; overScrollMode = View.OVER_SCROLL_NEVER; addView(content) }, LinearLayout.LayoutParams(-1, 0, 1f))
        // Kept outside the scrolling page, so the home's one action is always on screen however short the phone is.
        dock = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(side, 0, side, 0) }.also { root.addView(it, LinearLayout.LayoutParams(-1, -2)) }
        (space.parent as? ViewGroup)?.removeView(space)
        setContentView(FrameLayout(this).apply { setBackgroundColor(Palette.ground); addView(space, FrameLayout.LayoutParams(-1, -1)); addView(root, FrameLayout.LayoutParams(-1, -1)) })
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
            "activity" -> activity()
            else -> account()
        }
        showUpdate()
        if (page in listOf("connect", "nodes", "activity", "account")) root.addView(tabBar())
        handler.removeCallbacks(refresh); if (visible) handler.post(refresh)
    }
    private fun tabBar() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setBackgroundColor(Palette.alpha(Palette.ground, 140))
        addView(View(this@MainActivity).apply { setBackgroundColor(Palette.hairline) }, LinearLayout.LayoutParams(-1, 1))
        val tabs = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL; setPadding(12.dp, 6.dp, 12.dp, 6.dp) }
        for ((tab, title, res) in listOf(Triple("connect", R.string.connect_tab, R.drawable.ic_tab_connect), Triple("nodes", R.string.locations, R.drawable.ic_tab_nodes), Triple("activity", R.string.activity_title, R.drawable.ic_tab_activity), Triple("account", R.string.account, R.drawable.ic_tab_account))) {
            val selected = tab == page; val color = if (selected) Palette.accent else Palette.secondary
            tabs.addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; background = pressable(Color.TRANSPARENT, 12)
                // A small dot on the account tab while an update waits (the banner can be dismissed, the dot stays).
                addView(FrameLayout(this@MainActivity).apply {
                    addView(icon(res, color, 22), FrameLayout.LayoutParams(22.dp, 22.dp, Gravity.CENTER))
                    if (tab == "account") addView(View(this@MainActivity).apply { setBackgroundColor(Palette.accent); visibility = if (update != null) View.VISIBLE else View.INVISIBLE; accountDot = this }, FrameLayout.LayoutParams(6.dp, 6.dp, Gravity.TOP or Gravity.END))
                }, LinearLayout.LayoutParams(30.dp, 22.dp))
                addView(text(L10n.text(title), 11f, color, 500).apply { maxLines = 1 }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 4.dp })
                contentDescription = L10n.text(title) + if (selected) L10n.text(R.string.current_page) else ""
                setOnClickListener { if (!busy && !selected) { page = tab; render() } }
            }, LinearLayout.LayoutParams(0, 52.dp, 1f))
        }
        addView(tabs)
    }
    // ---- Activity: this connection's open connections and where its traffic went. Kept by the core in memory while
    // connected, forgotten on disconnect; nothing is stored or sent.
    private val directColor = Color.rgb(97, 90, 80)
    private fun activity() {
        pageTitle(L10n.text(R.string.activity_title), section = R.string.section_activity)
        add(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(4.dp, 0, 0, 0)
            addView(View(this@MainActivity).apply { setBackgroundColor(Palette.past) }, LinearLayout.LayoutParams(6.dp, 6.dp).apply { marginEnd = 8.dp })
            addView(text(L10n.text(R.string.activity_local_only), 12f, Palette.faint).apply { maxLines = 2 }, LinearLayout.LayoutParams(0, -2, 1f))
        }, top = -6, bottom = 14)
        add(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; setPadding(2.dp, 2.dp, 2.dp, 2.dp); background = rounded(Color.rgb(23, 21, 19), 12)
            for ((key, title) in listOf("conns" to R.string.activity_connections, "rank" to R.string.activity_ranking)) {
                val selected = key == activityTab
                addView(text(L10n.text(title), 13f, if (selected) Palette.text else Palette.secondary, 500).apply {
                    gravity = Gravity.CENTER; maxLines = 1
                    background = if (selected) rounded(Color.rgb(48, 45, 40), 10) else pressable(Color.TRANSPARENT, 10)
                    contentDescription = L10n.text(title) + if (selected) L10n.text(R.string.current_page) else ""
                    setOnClickListener { if (!selected) { activityTab = key; render() } }
                }, LinearLayout.LayoutParams(0, -1, 1f))
            }
        }, height = 36.dp, bottom = 12)
        activityBody = add(LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }) as LinearLayout
        fillActivity(null)
    }
    private fun loadActivity() {
        if (activityLoading || activityBody == null) return
        if (!(ConnectionStateStore.active && ConnectionStateStore.since > 0)) { fillActivity(null); return }
        activityLoading = true
        executor.execute {
            val data = try { JSONObject(Core.activity()) } catch (_: Exception) { null }
            runOnUiThread { activityLoading = false; if (page == "activity") fillActivity(data) }
        }
    }
    private fun fillActivity(data: JSONObject?) {
        val body = activityBody ?: return
        body.removeAllViews()
        if (data == null || !(ConnectionStateStore.active && ConnectionStateStore.since > 0)) {
            body.addView(text(L10n.text(R.string.activity_empty), 14f, Palette.secondary).apply { gravity = Gravity.CENTER },
                LinearLayout.LayoutParams(-1, -2).apply { topMargin = 72.dp; leftMargin = 24.dp; rightMargin = 24.dp })
            return
        }
        if (activityTab == "rank") activityRanking(body, data) else activityConnections(body, data)
    }
    private fun square(color: Int, size: Int = 6) = View(this).apply { setBackgroundColor(color); layoutParams = LinearLayout.LayoutParams(size.dp, size.dp) }
    private fun rate(value: Long) = if (value <= 0) "0 B/s" else bytes(value) + "/s"
    private fun activityConnections(body: LinearLayout, data: JSONObject) {
        val conns = data.optJSONArray("conns") ?: org.json.JSONArray()
        val all = (0 until conns.length()).mapNotNull { conns.optJSONObject(it) }
        val proxied = all.count { it.optBoolean("proxy") }
        body.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            for ((key, title, color) in listOf(Triple("all", R.string.activity_all, null), Triple("proxy", R.string.activity_proxy, Palette.accent), Triple("direct", R.string.activity_direct, directColor))) {
                val selected = key == activityFilter
                val count = when (key) { "proxy" -> proxied; "direct" -> all.size - proxied; else -> all.size }
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(12.dp, 0, 12.dp, 0)
                    background = GradientDrawable().apply { cornerRadius = 8.dp.toFloat(); setStroke(1.dp, if (selected) Palette.accent else Color.rgb(44, 41, 36)) }
                    if (color != null) addView(square(color).apply { (layoutParams as LinearLayout.LayoutParams).marginEnd = 6.dp })
                    addView(text(L10n.text(title), 13f, if (selected) Palette.text else Palette.secondary))
                    addView(text(L10n.number(count), 11f, if (selected) Palette.text else Palette.secondary).apply { typeface = Typeface.MONOSPACE },
                        LinearLayout.LayoutParams(-2, -2).apply { marginStart = 6.dp })
                    contentDescription = L10n.text(title) + " " + L10n.number(count)
                    setOnClickListener { activityFilter = key; fillActivity(data) }
                }, LinearLayout.LayoutParams(-2, 30.dp).apply { marginEnd = 8.dp })
            }
        }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 6.dp })
        val shown = all.filter { activityFilter == "all" || it.optBoolean("proxy") == (activityFilter == "proxy") }.take(100)
        for (c in shown) {
            val proxy = c.optBoolean("proxy"); val speed = c.optLong("rate")
            val exit = if (proxy) ConnectionStateStore.node.ifEmpty { c.optString("via") } else L10n.text(R.string.activity_direct)
            val route = SpannableString(c.optString("rule") + " → " + exit).apply {
                setSpan(ForegroundColorSpan(if (proxy) Palette.text else Palette.secondary), length - exit.length, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            body.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = 58.dp; setPadding(4.dp, 8.dp, 4.dp, 8.dp)
                addView(square(if (proxy) Palette.accent else directColor).apply { (layoutParams as LinearLayout.LayoutParams).marginEnd = 12.dp })
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(text(c.optString("host"), 15f).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.MIDDLE })
                    addView(text(route, 12f, Palette.secondary).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 4.dp })
                }, LinearLayout.LayoutParams(0, -2, 1f))
                addView(text(rate(speed), 12f, if (speed > 0) Palette.text else Color.rgb(126, 117, 105)).apply { typeface = Typeface.MONOSPACE; maxLines = 1 },
                    LinearLayout.LayoutParams(-2, -2).apply { marginStart = 8.dp })
            })
            body.addView(View(this).apply { setBackgroundColor(Color.rgb(26, 24, 22)) }, LinearLayout.LayoutParams(-1, 1))
        }
        if (shown.isEmpty()) body.addView(text(L10n.text(R.string.activity_nothing), 13f, Palette.secondary), LinearLayout.LayoutParams(-1, -2).apply { topMargin = 16.dp; marginStart = 4.dp })
    }
    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(18.dp, 16.dp, 18.dp, 16.dp)
        background = GradientDrawable().apply { setColor(Color.TRANSPARENT); cornerRadius = 16.dp.toFloat(); setStroke(1.dp, Palette.edge) }
    }
    private fun legend(proxy: Boolean, value: Long, free: Boolean = false) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        addView(square(if (proxy) Palette.accent else directColor).apply { (layoutParams as LinearLayout.LayoutParams).marginEnd = 6.dp })
        addView(text(L10n.text(if (proxy) R.string.activity_proxy else R.string.activity_direct) + " ", 12f, if (proxy) Palette.text else Palette.secondary).apply { maxLines = 1 })
        addView(text(bytes(value), 12f).apply { typeface = Typeface.MONOSPACE; maxLines = 1 })
        if (free) addView(text(" · " + L10n.text(R.string.activity_direct_free), 12f, Palette.secondary).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
    }
    private fun activityRanking(body: LinearLayout, data: JSONObject) {
        val p = data.optLong("proxy"); val d = data.optLong("direct")
        val summary = card()
        summary.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.BOTTOM
            val parts = bytes(p + d).split(' ', '\u00A0', limit = 2)
            addView(text(parts[0], 36f).apply { typeface = Pixel.font(this@MainActivity) })
            addView(text(parts.getOrElse(1) { "" }, 14f, Palette.secondary).apply { typeface = Typeface.MONOSPACE }, LinearLayout.LayoutParams(-2, -2).apply { marginStart = 6.dp; bottomMargin = 4.dp })
            addView(View(this@MainActivity), LinearLayout.LayoutParams(0, 1, 1f))
            addView(text(L10n.text(R.string.activity_this_session), 12f, Palette.secondary), LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = 4.dp })
        })
        val hours = data.optJSONArray("hours")
        val values = (0 until 24).map { i -> hours?.optJSONArray(i)?.let { it.optLong(0) to it.optLong(1) } ?: (0L to 0L) }
        summary.addView(HourBars(this).apply { set(values, java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)) }, LinearLayout.LayoutParams(-1, 48.dp).apply { topMargin = 12.dp })
        // Proxied vs direct as one bar split in two.
        summary.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            if (p + d == 0L) addView(View(this@MainActivity).apply { setBackgroundColor(Palette.raised) }, LinearLayout.LayoutParams(0, -1, 1f))
            else {
                if (p > 0) addView(View(this@MainActivity).apply { setBackgroundColor(Palette.accent) }, LinearLayout.LayoutParams(0, -1, p.toFloat()))
                if (d > 0) addView(View(this@MainActivity).apply { setBackgroundColor(directColor) }, LinearLayout.LayoutParams(0, -1, d.toFloat()).apply { if (p > 0) marginStart = 3.dp })
            }
        }, LinearLayout.LayoutParams(-1, 8.dp).apply { topMargin = 12.dp })
        summary.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            addView(legend(true, p))
            addView(View(this@MainActivity), LinearLayout.LayoutParams(0, 1, 1f))
            addView(legend(false, d, free = true), LinearLayout.LayoutParams(-2, -2).apply { marginStart = 8.dp })
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 10.dp })
        body.addView(summary, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 12.dp })
        body.addView(rankList(L10n.text(R.string.activity_by_domain), data.optJSONArray("domains"), mono = false, note = null), LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 12.dp })
        body.addView(rankList(L10n.text(R.string.activity_by_rule), data.optJSONArray("rules"), mono = true, note = L10n.text(R.string.activity_no_apps)))
    }
    private fun rankList(title: String, rows: org.json.JSONArray?, mono: Boolean, note: String?) = card().apply {
        setPadding(18.dp, 14.dp, 18.dp, 14.dp)
        addView(text(title, 12f, Palette.secondary, 500), LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = 4.dp })
        val list = (0 until (rows?.length() ?: 0)).mapNotNull { rows?.optJSONObject(it) }
        val top = maxOf(1L, list.firstOrNull()?.optLong("bytes") ?: 1L)
        for (r in list) addView(LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, 6.dp, 0, 6.dp)
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(text(r.optString("name"), if (mono) 12.5f else 13f).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.MIDDLE; if (mono) typeface = Typeface.MONOSPACE })
                addView(DotBar(this@MainActivity, r.optLong("bytes").toDouble() / top, if (r.optBoolean("proxy")) Palette.accent else directColor), LinearLayout.LayoutParams(-1, 4.dp).apply { topMargin = 6.dp })
            }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(text(bytes(r.optLong("bytes")), 12f).apply { typeface = Typeface.MONOSPACE; maxLines = 1; gravity = Gravity.END }, LinearLayout.LayoutParams(78.dp, -2).apply { marginStart = 12.dp })
        })
        if (list.isEmpty()) addView(text(L10n.text(R.string.activity_nothing), 12f, Palette.secondary), LinearLayout.LayoutParams(-2, -2).apply { topMargin = 6.dp })
        if (note != null) addView(text(note, 11f, Palette.faint), LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8.dp })
    }

    /** Update and announcement notes: one compact card each, only when there is something to say. */
    private fun notices() {
        banner = add(LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }) as LinearLayout
        showUpdate()
        if (announcement.isNotBlank()) add(text(announcement, 14f, Palette.secondary).apply { background = rounded(Palette.surface, 16); setPadding(16.dp, 14.dp, 16.dp, 14.dp) }, top = 4, bottom = 8)
    }

    /** The file header on every main page: mark and name on the left, the account's file number on the right. */
    private fun fileHeader() {
        add(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(4.dp, 0, 4.dp, 0)
            addView(PixelMark(this@MainActivity), LinearLayout.LayoutParams(18.dp, 18.dp).apply { marginEnd = 10.dp })
            addView(wordmark(14f).apply { setTextColor(Palette.secondary) }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(mono("№ " + fileNumber(), 11f, Palette.faint))
        }, height = 44.dp)
        add(View(this).apply { setBackgroundColor(Palette.hairline) }, height = 1, bottom = 4)
    }
    private fun mono(value: String, size: Float, color: Int) = text(value, size, color).apply { typeface = Typeface.MONOSPACE; letterSpacing = 0.08f; maxLines = 1 }
    private fun sectionLabel(res: Int) = mono(L10n.text(res), 11f, Palette.faint).apply { setPadding(4.dp, 0, 0, 0) }
    /** A short, stable file number for this account (same rule as the Portal's), not an id. */
    private fun fileNumber(): String {
        val seed = accountData?.optString("email").orEmpty().ifEmpty { api.secret("token")?.take(12).orEmpty() }
        var hash = 7L
        for (c in seed) hash = (hash * 31 + c.code) and 0xFFFFFFFFL
        return String.format(java.util.Locale.ROOT, "%04d", hash % 10000)
    }

    /**
     * The connect page as a file: its state, four lines of what anyone can see about this phone right now, one
     * action, then the location and usage. Connecting seals the file (a line of light sweeps down and each line turns
     * into dots, the lamp above goes out); disconnecting sweeps back up and opens it.
     */
    private fun home() {
        fileHeader()
        notices()
        switchNote = row(48).apply {
            setPadding(16.dp, 0, 4.dp, 0); background = rounded(Palette.surface, 12); visibility = View.GONE
            addView(View(this@MainActivity).apply { setBackgroundColor(Palette.accent) }, LinearLayout.LayoutParams(6.dp, 6.dp).apply { marginEnd = 12.dp })
            switchText = text("", 13f).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END }.also { addView(it, LinearLayout.LayoutParams(0, -2, 1f)) }
            addView(FrameLayout(this@MainActivity).apply {
                background = pressable(Color.TRANSPARENT, 10); contentDescription = L10n.text(R.string.close)
                addView(icon(R.drawable.ic_close, Palette.secondary, 14), FrameLayout.LayoutParams(14.dp, 14.dp, Gravity.CENTER))
                setOnClickListener { dismissedSwitch = ConnectionStateStore.switchedFrom; showState() }
            }, LinearLayout.LayoutParams(44.dp, 44.dp))
        }.also { add(it, top = 4) }
        // Notes that come and go above the file (update, location switch) slide the page smoothly instead of snapping it.
        if (ValueAnimator.areAnimatorsEnabled()) content.layoutTransition = LayoutTransition().apply { setDuration(220); enableTransitionType(LayoutTransition.CHANGING) }
        spacer(0.6f)
        add(sectionLabel(R.string.section_status), top = 12, bottom = 8)
        // The state block has one height in every state, so nothing below it moves when a connection comes up or goes
        // down: what only exists while connected fades in and out of space that is always reserved.
        val titleRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(4.dp, 0, 4.dp, 0) }
        stateTitle = text("", 32f, Palette.text, 300).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END; letterSpacing = -0.01f }
            .also { titleRow.addView(it, LinearLayout.LayoutParams(0, -2, 1f)) }
        stamp = text("SEALED", 11f, Palette.accent, 600).apply {
            typeface = Typeface.MONOSPACE; letterSpacing = 0.22f; setPadding(8.dp, 4.dp, 6.dp, 4.dp); rotation = -6f; alpha = 0f; visibility = View.INVISIBLE
            background = GradientDrawable().apply { setStroke(1.dp, Palette.alpha(Palette.accent, 200)); cornerRadius = 2.dp.toFloat() }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }.also { titleRow.addView(it, LinearLayout.LayoutParams(-2, -2).apply { marginStart = 12.dp }) }
        add(titleRow, height = sp(46f))
        val slot = FrameLayout(this).apply { setPadding(4.dp, 0, 4.dp, 0) }
        stateTimer = text("", 15f, Palette.text).apply { typeface = Typeface.MONOSPACE; fontFeatureSettings = "tnum"; letterSpacing = 0.06f; maxLines = 1; alpha = 0f; visibility = View.INVISIBLE }
            .also { slot.addView(it, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER_VERTICAL)) }
        stateDetail = text("", 13f, Palette.secondary).apply { maxLines = 2; ellipsize = TextUtils.TruncateAt.END }
            .also { slot.addView(it, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER_VERTICAL)) }
        add(slot, height = sp(36f), top = 2)
        // The file itself: what any site or app on this network can read about this phone.
        val file = FrameLayout(this)
        val lines = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val values = listOf(
            R.string.file_public_ip to (visitorIp ?: "···"),
            R.string.file_device to "${Build.MODEL} · Android ${Build.VERSION.RELEASE}",
            R.string.file_time_zone to zoneLabel(),
            R.string.file_language to L10n.locale.toLanguageTag(),
        )
        fileLines = values.mapIndexed { i, (label, value) ->
            lines.addView(View(this).apply { setBackgroundColor(Palette.hairline) }, LinearLayout.LayoutParams(-1, 1))
            val line = SealedText(this).apply { this.value = value; ellipsize = TextUtils.TruncateAt.END }
            lines.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(4.dp, 0, 4.dp, 0)
                addView(mono(L10n.text(label), 10f, Palette.faint).apply { ellipsize = TextUtils.TruncateAt.END }, LinearLayout.LayoutParams(96.dp, -2))
                addView(line, LinearLayout.LayoutParams(0, -2, 1f))
                contentDescription = L10n.text(label)
            }, LinearLayout.LayoutParams(-1, 42.dp))
            if (i == values.lastIndex) lines.addView(View(this).apply { setBackgroundColor(Palette.hairline) }, LinearLayout.LayoutParams(-1, 1))
            line
        }
        file.addView(lines, FrameLayout.LayoutParams(-1, -2))
        scan = ScanLine(this).also { file.addView(it, FrameLayout.LayoutParams(-1, -1)) }
        add(file, top = 10)
        stateRates = text("", 12f, Palette.secondary).apply { typeface = Typeface.MONOSPACE; maxLines = 1; ellipsize = TextUtils.TruncateAt.END; fontFeatureSettings = "tnum"; alpha = 0f; visibility = View.INVISIBLE; setPadding(4.dp, 0, 4.dp, 0) }
            .also { add(it, height = sp(18f), top = 12) }
        rateBars = RateBars(this).apply { alpha = 0f; visibility = View.INVISIBLE }.also { add(it, height = 40.dp, top = 6) }
        spacer(1f)
        // One outlined action: grey and quiet while exposed, amber with a breathing dot while sealed.
        action = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(18.dp, 0, 18.dp, 0); isClickable = true; isFocusable = true
            actionLabel = text("", 15f, Palette.text, 500).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }.also { addView(it, LinearLayout.LayoutParams(0, -2, 1f)) }
            actionDot = View(this@MainActivity).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Palette.alpha(Palette.text, 90)) } }
                .also { addView(it, LinearLayout.LayoutParams(6.dp, 6.dp)) }
            setOnClickListener { if (!busy) toggleConnection() }
        }.also { dock?.addView(it, LinearLayout.LayoutParams(-1, 54.dp).apply { topMargin = 4.dp; bottomMargin = 12.dp }) }
        // Connected, the location row opens the connection check; otherwise, or while the chosen location does not
        // answer, it opens the location list (picking one there reconnects to it).
        val node = row(64).apply { background = pressable(Palette.surface, 4); contentDescription = L10n.text(R.string.tap_to_change)
            setOnClickListener { if (busy) return@setOnClickListener; if (ConnectionStateStore.active && ConnectionStateStore.since > 0 && ConnectionStateStore.messageId != R.string.location_retrying) connectionCheck() else { page = "nodes"; render() } } }
        nodeBadge = badge(null).also { node.addView(it) }
        val names = titles(" ", " "); node.addView(names)
        nodeTitle = names.getChildAt(0) as TextView; nodeDetail = names.getChildAt(1) as TextView
        node.addView(chevron())
        add(node, top = 10)
        usageStrip()
        sealedShown = null; shownState = null
        showState()
        if (visitorIp == null) loadVisitorIp()
        // Just signed in: no saved list yet, so load it for the location's name and code.
        if (NodeCache.nodes(this) == null) refreshNodes()
    }
    private fun zoneLabel(): String {
        val minutes = java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000
        return String.format(java.util.Locale.ROOT, "UTC%s%02d:%02d", if (minutes >= 0) "+" else "-", Math.abs(minutes) / 60, Math.abs(minutes) % 60)
    }
    /** The public address the service sees, read once while not connected (afterwards it would be the location's). */
    private fun loadVisitorIp() {
        if (ConnectionStateStore.active) return
        Thread {
            val ip = try { api.get("/api/v1/visitor").let { if (it.isNull("ip")) "—" else it.optString("ip") } } catch (_: Exception) { null }
            runOnUiThread { visitorIp = ip; fileLines?.firstOrNull()?.value = ip ?: "—" }
        }.start()
    }
    /** What this account has left (or used) and how long it runs: two quiet figures under the location. */
    private fun usageStrip() {
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
    private fun deviceLimit(data: JSONObject) = if (data.isNull("limit")) L10n.text(R.string.devices_unlimited) else L10n.number(data.optInt("limit"))
    private fun totalTraffic(data: JSONObject) = data.optJSONObject("traffic")?.let { (it.optString("uploadBytes", "0").toLongOrNull() ?: 0) + (it.optString("downloadBytes", "0").toLongOrNull() ?: 0) }
    private fun failed() = !ConnectionStateStore.active && ConnectionStateStore.messageId !in listOf(R.string.not_connected, R.string.disconnected)
    private fun showState() {
        val active = ConnectionStateStore.active; val since = ConnectionStateStore.since
        val state = when { active && since > 0 -> LinkState.CONNECTED; active -> LinkState.CONNECTING; failed() -> LinkState.FAILED; else -> LinkState.IDLE }
        val connected = state == LinkState.CONNECTED
        space.lit = !active
        if (state != shownState) action?.apply {
            contentDescription = L10n.text(when (state) { LinkState.IDLE -> R.string.connect_action; LinkState.FAILED -> R.string.retry_action; LinkState.CONNECTING -> R.string.cancel; else -> R.string.disconnect_action })
            background = GradientDrawable().apply {
                cornerRadius = 2.dp.toFloat()
                if (connected) { setColor(Palette.alpha(Palette.accent, 15)); setStroke(1.dp, Palette.alpha(Palette.accent, 180)) } else { setColor(Palette.alpha(Palette.text, 10)); setStroke(1.dp, Palette.alpha(Palette.text, 120)) }
            }.let { RippleDrawable(ColorStateList.valueOf(Palette.alpha(Palette.text, 22)), it, null) }
        }
        if (state != shownState) actionLabel?.apply {
            swap(L10n.text(when (state) { LinkState.CONNECTED -> R.string.unseal_action; LinkState.CONNECTING -> R.string.sealing_detail; LinkState.FAILED -> R.string.retry_action; else -> R.string.seal_action }))
            setTextColor(if (connected) Palette.accent else Palette.text)
        }
        if (state != shownState) actionDot?.apply {
            (background as? GradientDrawable)?.setColor(if (active) Palette.accent else Palette.alpha(Palette.text, 90))
            animate().cancel(); alpha = 1f
            if (active && ValueAnimator.areAnimatorsEnabled()) breathe(this)
        }
        stateTitle?.swap(L10n.text(when (state) { LinkState.CONNECTED -> R.string.sealed_status; LinkState.CONNECTING -> R.string.connecting; LinkState.FAILED -> R.string.connect_failed_title; else -> R.string.exposed_status }))
        // The file seals as soon as a connection starts, and opens again when it ends; the first show on a page is still.
        val seal = active
        if (sealedShown != seal) {
            val moving = sealedShown != null && ValueAnimator.areAnimatorsEnabled()
            fileLines?.let { lines ->
                val n = lines.size
                lines.forEachIndexed { i, line -> line.seal(seal, if (moving) (1300L * ((if (seal) i else n - 1 - i) + 0.5f) / n).toLong() else 0L, moving) }
            }
            if (moving) scan?.sweep(down = seal)
            stamp?.apply {
                animate().cancel()
                if (!moving) { alpha = if (seal) 1f else 0f; visibility = if (seal) View.VISIBLE else View.INVISIBLE; scaleX = 1f; scaleY = 1f }
                else if (seal) { visibility = View.VISIBLE; alpha = 0f; scaleX = 1.6f; scaleY = 1.6f; animate().alpha(1f).scaleX(1f).scaleY(1f).setStartDelay(1250).setDuration(260).setInterpolator(DecelerateInterpolator()).start() }
                else animate().alpha(0f).setStartDelay(0).setDuration(200).withEndAction { visibility = View.INVISIBLE }.start()
            }
            sealedShown = seal
        }
        if (connected) stateTimer?.text = DateUtils.formatElapsedTime((SystemClock.elapsedRealtime() - since) / 1000)
        stateTimer?.fade(connected); stateDetail?.fade(!connected)
        if (state == LinkState.CONNECTED) {
            rxHistory.addLast(ConnectionStateStore.rxRate); txHistory.addLast(ConnectionStateStore.txRate)
            while (rxHistory.size > RateBars.COUNT) { rxHistory.removeFirst(); txHistory.removeFirst() }
        } else { rxHistory.clear(); txHistory.clear() }
        rateBars?.apply { fade(connected); set(rxHistory.toList(), txHistory.toList()) }
        val from = ConnectionStateStore.switchedFrom
        val noteShown = state == LinkState.CONNECTED && from.isNotEmpty() && from != dismissedSwitch && from != ConnectionStateStore.node
        switchText?.text = if (noteShown) L10n.text(R.string.switched_location, from, ConnectionStateStore.node) else ""
        switchNote?.visibility = if (noteShown) View.VISIBLE else View.GONE
        // Rates change every second: set directly (fixed-width digits keep the line still); messages cross-fade.
        if (connected) stateRates?.text = if (ConnectionStateStore.messageId in ConnectionService.NOTICES) ConnectionStateStore.message
            else L10n.text(R.string.connection_rates, mbps(ConnectionStateStore.rxRate), mbps(ConnectionStateStore.txRate))
        stateRates?.fade(connected)
        if (!connected) stateDetail?.swap(when (state) {
            LinkState.CONNECTING -> L10n.text(R.string.finding_best_route)
            LinkState.FAILED -> ConnectionStateStore.message
            else -> L10n.text(if (update?.mandatory == true) R.string.update_required_detail else R.string.exposed_detail)
        })
        shownState = state
        showCurrentNode()
    }
    /** The action's dot breathes slowly while a connection is up; it stops when the view is gone or the state changes. */
    private fun breathe(dot: View) {
        if (!dot.isAttachedToWindow && dot.parent == null) return
        dot.animate().alpha(0.35f).setDuration(1800).setInterpolator(android.view.animation.AccelerateDecelerateInterpolator()).withEndAction {
            dot.animate().alpha(1f).setDuration(1800).withEndAction { if (ConnectionStateStore.active && actionDot === dot) breathe(dot) }.start()
        }.start()
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
                val base = if (automatic) ms(quality)?.let { L10n.text(R.string.connected_automatic_detail, it) } ?: L10n.text(R.string.automatic) else quality?.let { summary(it) } ?: L10n.text(R.string.tap_to_change)
                nodeDetail?.text = if (ConnectionStateStore.since > 0) base + " · " + L10n.text(R.string.tap_to_check) else base
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
        // Before sign-in the look is two small swatches (amber, moon halo) so a new user sees the choice; afterwards it
        // is the Appearance row on the account page.
        header.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(4.dp, 0, 4.dp, 0)
            for ((theme, label, color) in listOf(Triple("amber", R.string.theme_amber, Color.rgb(224, 164, 88)), Triple("moon", R.string.theme_moon, Color.rgb(235, 184, 195)))) {
                val chosen = Palette.theme == theme
                addView(FrameLayout(this@MainActivity).apply {
                    background = pressable(Color.TRANSPARENT, 10)
                    addView(View(this@MainActivity).apply {
                        background = GradientDrawable().apply {
                            shape = GradientDrawable.OVAL; setColor(color)
                            if (chosen) setStroke(2.dp, Palette.ground)
                        }
                    }, FrameLayout.LayoutParams(14.dp, 14.dp, Gravity.CENTER))
                    if (chosen) addView(View(this@MainActivity).apply {
                        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.TRANSPARENT); setStroke(1.dp, color) }
                    }, FrameLayout.LayoutParams(20.dp, 20.dp, Gravity.CENTER))
                    contentDescription = L10n.text(R.string.appearance) + ": " + L10n.text(label); isSelected = chosen
                    setOnClickListener { if (!busy) applyAppearance(theme) }
                }, LinearLayout.LayoutParams(32.dp, 40.dp))
            }
        }, LinearLayout.LayoutParams(-2, 40.dp))
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
        add(text(L10n.text(R.string.sign_in_tagline), 14f, Palette.secondary).apply { gravity = Gravity.CENTER }, top = 8, bottom = 36)
        add(sectionLabel(R.string.section_sign_in), bottom = 12)
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
        add(text(L10n.text(R.string.forgot_password), 13f, Palette.secondary).apply {
            gravity = Gravity.CENTER_VERTICAL; setPadding(10.dp, 0, 4.dp, 0); background = pressable(Color.TRANSPARENT, 10)
            setOnClickListener {
                if (busy) return@setOnClickListener
                val address = email.text.toString().trim()
                if (address.isEmpty()) { alert(L10n.text(R.string.reset_enter_email_first)); email.requestFocus(); return@setOnClickListener }
                val origin = server?.text?.toString()
                resetPassword(address, L10n.text(R.string.reset_confirm_detail, address), L10n.text(R.string.reset_link_sent)) { if (origin != null) api.origin = origin }
            }
        }, height = 40.dp, width = -2, top = 4, gravity = Gravity.END)
        add(primaryButton(L10n.text(R.string.sign_in_action)) {
            val origin = server?.text?.toString(); val address = email.text.toString().trim(); val secret = password.text.toString()
            if (address.isBlank() || secret.isEmpty()) { alert(L10n.text(R.string.enter_your_email_and_password)); return@primaryButton }
            work({ if (origin != null) api.origin = origin; api.login(address, secret) }) { password.setText(""); page = "connect"; render(); handler.postDelayed(updateCheck, 1500) }
        }, height = 52.dp, top = 12)
    }
    /** Both "forgot password" and "change password" email the Portal's reset link; the new password is set there. */
    private fun resetPassword(email: String, detail: String, sent: String, before: () -> Unit = {}) {
        AlertDialog.Builder(this).setTitle(L10n.text(R.string.reset_by_email)).setMessage(detail)
            .setNegativeButton(L10n.text(R.string.cancel), null).setPositiveButton(L10n.text(R.string.send_reset_link)) { _, _ ->
                work({ before(); api.requestPasswordReset(email) }) { alert(sent) }
            }.show()
    }

    private var measuring = false
    private fun nodes() {
        val retest = FrameLayout(this).apply {
            background = pressable(Color.TRANSPARENT, 12); contentDescription = L10n.text(R.string.retest_latency); alpha = if (measuring) 0.5f else 1f
            addView(icon(R.drawable.ic_refresh, Palette.secondary, 20), FrameLayout.LayoutParams(20.dp, 20.dp, Gravity.CENTER))
            layoutParams = LinearLayout.LayoutParams(44.dp, 44.dp)
        }
        pageTitle(L10n.text(R.string.locations), retest, R.string.section_locations)
        routingChoice()
        val search = FrameLayout(this).also { add(it) }
        val automatic = selectedId.isEmpty()
        // Selected = a lifted row and a amber tile; nothing is added, so the rows keep their layout.
        add(row(68).apply {
            background = pressable(if (automatic) Palette.raised else Palette.surface, 16)
            addView(badge(null, R.drawable.ic_sparkle, if (automatic) Palette.onAccent else Palette.accent).apply { if (automatic) background = rounded(Palette.accent, 8) })
            addView(titles(L10n.text(R.string.automatic), L10n.text(R.string.select_an_available_location_for_you)).apply { if (automatic) (getChildAt(0) as TextView).weight(600) })
            contentDescription = L10n.text(R.string.automatic) + if (automatic) L10n.text(R.string.current_page) else ""
            setOnClickListener { if (!busy) select("", "", "") }
        }, top = 20)
        add(text(L10n.text(R.string.all_locations), 13f, Palette.secondary).apply { setPadding(4.dp, 0, 0, 0) }, top = 20, bottom = 8)
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also { add(it) }
        var query = ""
        // Shown in this order while the page is open: new measurements change the figures in place, never the order.
        var ranked: List<Pair<JSONObject, Quality?>> = emptyList()
        var nodes = JSONArray()
        fun searchBox() {
            if (nodes.length() <= 6 || search.childCount > 0) return
            search.addView(LinearLayout(this).apply {
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
        }
        fun figures() { ranked = ranked.map { (node, _) -> node to Latency.recent[node.getString("id")] } }
        // Coalesces one redraw per frame while results arrive node by node.
        var redraw = false
        fun redrawSoon() { if (redraw) return; redraw = true; list.postOnAnimation { redraw = false; if (list.isAttachedToWindow) { figures(); show(list, ranked, query) } } }
        fun unmeasured() = (0 until nodes.length()).any { i -> Latency.recent[nodes.getJSONObject(i).getString("id")] == null }
        fun measure(all: Boolean) {
            if (measuring || nodes.length() == 0) return
            measuring = true; retest.alpha = 0.5f; progress?.visibility = View.VISIBLE; show(list, ranked, query)
            val input = nodes
            Thread {
                // Each result replaces that node's figures as it arrives; the earlier figures stay until then.
                // The page shown when a result arrives redraws it (the person may have left and come back meanwhile).
                val result = try { Latency.rank(input, reuseMs = if (all) 0 else Long.MAX_VALUE) { _, _ -> runOnUiThread { onMeasured?.invoke(false) } } } catch (_: Exception) { null }
                if (result != null) { NodeCache.saveMeasured(applicationContext); Latency.report(applicationContext, api, result) }
                runOnUiThread {
                    measuring = false
                    if (isDestroyed) return@runOnUiThread
                    if (!busy) progress?.visibility = View.INVISIBLE
                    onMeasured?.invoke(true)
                }
            }.start()
        }
        onMeasured = { done ->
            if (done) retest.alpha = 1f
            if (list.isAttachedToWindow) { if (done) { figures(); show(list, ranked, query); if (unmeasured()) measure(false) } else redrawSoon() }
        }
        /** A newer list: rows that stay keep their place and figures, new ones go to the end, removed ones leave. */
        fun loaded(fresh: JSONArray, first: Boolean) {
            nodes = fresh
            val byId = (0 until fresh.length()).map { fresh.getJSONObject(it) }.associateBy { it.getString("id") }
            ranked = if (first) byId.values.map { it to Latency.recent[it.getString("id")] }.sortedBy { it.second?.score ?: Long.MAX_VALUE }
            else ranked.mapNotNull { (old, _) -> byId[old.getString("id")] }.let { kept ->
                val known = kept.map { it.getString("id") }.toSet()
                (kept + byId.values.filter { it.getString("id") !in known }).map { it to Latency.recent[it.getString("id")] }
            }
            searchBox(); show(list, ranked, query)
            // Measuring is by hand (the refresh button); only nodes this device never measured are measured on their own.
            // Results are kept across launches, and automatic mode measures again when it connects.
            if (unmeasured()) measure(false)
        }
        retest.setOnClickListener { if (!measuring) { refreshNodes(); measure(true) } }
        onNodes = { fresh -> if (list.isAttachedToWindow) loaded(fresh, ranked.isEmpty()) }
        val cached = NodeCache.nodes(this)
        if (cached != null) loaded(cached, true)
        // First time on this device: nothing to show yet, so this one load shows progress and errors.
        else work({ api.request("nodes").getJSONArray("nodes") }) { fresh -> NodeCache.save(this, fresh); loaded(fresh, true) }
    }
    /** Called with each newer location list the app loads in the background; set by the location page. */
    private var onNodes: ((JSONArray) -> Unit)? = null
    /** Called as each measurement arrives (false) and when all are done (true); set by the location page. */
    private var onMeasured: ((Boolean) -> Unit)? = null
    private var loadingNodes = false
    /** Set once this run has loaded the list (or tried to). */
    private var nodesLoaded = false
    /** Loads the location list in the background and saves it; nothing changes on screen if it fails. */
    private fun refreshNodes() {
        if (loadingNodes || api.secret("token") == null) return
        loadingNodes = true
        Thread {
            val fresh = try { api.request("nodes").getJSONArray("nodes") } catch (_: Exception) { null }
            if (fresh != null) NodeCache.save(applicationContext, fresh)
            runOnUiThread {
                loadingNodes = false
                if (fresh == null || isDestroyed) return@runOnUiThread
                onNodes?.invoke(fresh)
                if (page == "connect") showState()
            }
        }.start()
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
    /** The node whose per-line detail is open in the list ("" = none); one at a time. */
    private var openNode = ""
    private fun lineName(index: Int) = L10n.text(R.string.line_n, L10n.number(index + 1))
    /** Each line's cell (OK, SLOW, DOWN, OFF) in the order Line 1…4; null when this device has no line results for the node. */
    private fun lineStates(quality: Quality?): List<Int>? = quality?.lines?.takeIf { it.isNotEmpty() }?.let { lines ->
        Latency.lineOrder.map { name -> lines[name]?.let { ms -> when { ms < 0 -> LineCells.DOWN; ms > 300 -> LineCells.SLOW; else -> LineCells.OK } } ?: LineCells.OFF }
    }
    /** One sentence when a line is out ("Line 2 has no answer, using Line 1"); null when every offered line works or none was measured. */
    private fun linesNote(quality: Quality?): String? {
        val lines = quality?.lines?.takeIf { it.isNotEmpty() } ?: return null
        val offered = Latency.lineOrder.withIndex().filter { lines.containsKey(it.value) }
        val working = offered.filter { (lines[it.value] ?: -1) >= 0 }
        val down = offered.filter { (lines[it.value] ?: -1) < 0 }
        val join = if (L10n.locale.language == "zh") "、" else ", "
        return when {
            working.isEmpty() -> L10n.text(R.string.lines_none)
            down.isEmpty() -> null
            working.size == 1 && offered.size > 2 -> L10n.text(R.string.lines_only, lineName(working[0].index))
            else -> L10n.text(R.string.lines_one_down, down.joinToString(join) { lineName(it.index) }, lineName(working.minBy { lines[it.value]!! }.index))
        }
    }
    /** The quiet per-line grid under a node: a small cell, "Line N" and its delay, two columns, indented to the name. */
    private fun lineDetail(quality: Quality?): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(66.dp, 0, 16.dp, 10.dp)
        val lines = quality?.lines ?: emptyMap()
        val states = lineStates(quality) ?: return@apply
        for (pair in Latency.lineOrder.indices.chunked(2)) {
            val r = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL }
            for (i in pair) {
                val ms = lines[Latency.lineOrder[i]]
                val value = when { ms == null -> L10n.text(R.string.line_off); ms < 0 -> L10n.text(R.string.line_down); else -> L10n.text(R.string.latency_ms, L10n.number(ms)) }
                r.addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = 24.dp
                    addView(LineCells(this@MainActivity).apply { cell = 4f; this.states = listOf(states[i]) }, LinearLayout.LayoutParams(6.dp, 6.dp).apply { marginEnd = 7.dp })
                    addView(text(lineName(i), 12f, Palette.faint), LinearLayout.LayoutParams(0, -2, 1f))
                    addView(text(value, 11f, when { ms == null -> Palette.faint; ms < 0 -> Palette.alpha(Palette.danger, 190); else -> Palette.secondary }).apply { typeface = Typeface.MONOSPACE; maxLines = 1 })
                    contentDescription = lineName(i) + ", " + value
                }, LinearLayout.LayoutParams(0, -2, 1f).apply { if (i % 2 == 1) marginStart = 20.dp })
            }
            addView(r, LinearLayout.LayoutParams(-1, -2))
        }
    }
    /** Opens or closes a node's line detail by animating its height, so the rows below slide instead of jumping. */
    private fun expand(detail: View, open: Boolean) {
        detail.animate().cancel()
        (detail.getTag(R.id.fade_target) as? ValueAnimator)?.cancel()
        val from = if (detail.visibility == View.VISIBLE) detail.height else 0
        detail.measure(View.MeasureSpec.makeMeasureSpec((detail.parent as View).width, View.MeasureSpec.EXACTLY), View.MeasureSpec.UNSPECIFIED)
        val to = if (open) detail.measuredHeight else 0
        if (!ValueAnimator.areAnimatorsEnabled()) { detail.layoutParams.height = -2; detail.visibility = if (open) View.VISIBLE else View.GONE; detail.alpha = 1f; detail.requestLayout(); return }
        detail.visibility = View.VISIBLE
        ValueAnimator.ofInt(from, to).apply {
            duration = 260; interpolator = DecelerateInterpolator()
            addUpdateListener { detail.layoutParams.height = it.animatedValue as Int; detail.alpha = if (to == 0) 1f - it.animatedFraction else it.animatedFraction; detail.requestLayout() }
            addListener(object : android.animation.AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: android.animation.Animator) { if (!open) detail.visibility = View.GONE else detail.layoutParams.height = -2; detail.requestLayout() }
            })
            detail.setTag(R.id.fade_target, this)
            start()
        }
    }
    private fun show(list: LinearLayout, ranked: List<Pair<JSONObject, Quality?>>, query: String) {
        list.removeAllViews()
        val rows = mutableListOf<View>()
        for ((node, quality) in ranked) {
            val name = node.getString("name"); val region = node.optString("region").takeIf { it.isNotBlank() && it != "null" && it != name } ?: ""
            if (!("$name $region").contains(query, ignoreCase = true)) continue
            val id = node.getString("id"); val code = Directory.code(id, name)
            val unreachable = quality != null && quality.latency == null
            val states = lineStates(quality)
            val note = linesNote(quality)
            val selected = id == selectedId
            // Selected = a lifted row, a amber tile and a bolder name; opened = a darker row (unless selected).
            val rest = if (selected) Palette.raised else Color.TRANSPARENT
            val item = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; background = ColorDrawable(rest) }
            val detail = lineDetail(quality).apply { visibility = if (openNode == id && states != null) View.VISIBLE else View.GONE }
            // Fixed columns on every row: tile, name, delay (fixed width, right-aligned), line cells (fixed slot).
            val main = row(60).apply {
                background = pressable(Color.TRANSPARENT, 0); setPadding(16.dp, 8.dp, 4.dp, 8.dp)
                addView(badge(code, null, when { selected -> Palette.onAccent; unreachable -> Palette.faint; else -> Palette.text }).apply { if (selected) background = rounded(Palette.accent, 8) })
                addView(titles(name, note ?: region, if (unreachable && !selected) Palette.faint else Palette.text).apply { if (selected) (getChildAt(0) as TextView).weight(600) })
                val latency = when {
                    quality == null -> if (measuring) "…" else ""
                    unreachable -> L10n.text(R.string.quality_unreachable)
                    else -> ms(quality)!!
                }
                addView(text(latency, 13f, if (unreachable) Palette.danger else Palette.secondary).apply {
                    gravity = Gravity.END or Gravity.CENTER_VERTICAL; maxLines = 1
                    if (!unreachable) { typeface = Typeface.MONOSPACE; fontFeatureSettings = "tnum" }
                    setAutoSizeTextTypeUniformWithConfiguration(10, 13, 1, android.util.TypedValue.COMPLEX_UNIT_SP)
                }, LinearLayout.LayoutParams(76.dp, 20.dp).apply { marginStart = 8.dp })
                contentDescription = name + ", " + (quality?.let { summary(it) } ?: "") + (note?.let { ", $it" } ?: "") + if (selected) L10n.text(R.string.current_page) else ""
                setOnClickListener { if (!busy) select(id, name, code) }
            }
            item.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                addView(main, LinearLayout.LayoutParams(0, -2, 1f))
                // The cell slot is always there: the four line cells (tap to open each line's result), signal bars
                // for a device without line results, or empty; old results stay drawn while a node is re-measured.
                val slot = LinearLayout.LayoutParams(44.dp, 44.dp).apply { marginEnd = 6.dp }
                when {
                    states != null || (measuring && quality == null && Latency.offered(node).isNotEmpty()) -> addView(LineCells(this@MainActivity).apply {
                        this.states = states ?: List(Latency.lineOrder.size) { LineCells.WAIT }
                        background = pressable(Color.TRANSPARENT, 8)
                        val working = states?.count { it == LineCells.OK || it == LineCells.SLOW } ?: 0
                        contentDescription = L10n.text(R.string.lines_detail, name, L10n.number(states?.count { it != LineCells.OFF } ?: 0), L10n.number(working))
                        if (states != null) setOnClickListener {
                            val open = openNode != id
                            val previous = openNode
                            openNode = if (open) id else ""
                            if (previous.isNotEmpty() && previous != id) list.findViewWithTag<View>("lines:$previous")?.let { expand(it, false) }
                            expand(detail, open)
                            item.background = ColorDrawable(if (open && !selected) Color.rgb(16, 14, 13) else rest)
                        }
                    }, slot)
                    quality != null && !unreachable -> addView(FrameLayout(this@MainActivity).apply {
                        addView(SignalBars(this@MainActivity).apply {
                            level = when (quality.grade) { R.string.quality_good -> 3; R.string.quality_fair -> 2; else -> 1 }
                            color = when (quality.grade) { R.string.quality_good -> Palette.accent; R.string.quality_fair -> Palette.fair; else -> Palette.danger }
                        }, FrameLayout.LayoutParams(14.dp, 12.dp, Gravity.CENTER))
                    }, slot)
                    else -> addView(View(this@MainActivity), slot)
                }
            }, LinearLayout.LayoutParams(-1, -2))
            detail.tag = "lines:$id"
            item.addView(detail, LinearLayout.LayoutParams(-1, -2))
            if (openNode == id && states != null && !selected) item.background = ColorDrawable(Color.rgb(16, 14, 13))
            rows.add(item)
        }
        when {
            rows.isNotEmpty() -> list.addView(group(rows, inset = 66))
            ranked.isEmpty() -> list.addView(text(L10n.text(R.string.no_locations_available_refresh_later_or_contact_your_administrator), 14f, Palette.secondary).apply { setPadding(4.dp, 4.dp, 4.dp, 4.dp) })
            else -> list.addView(text(L10n.text(R.string.no_matching_locations_try_another_search), 14f, Palette.secondary).apply { setPadding(4.dp, 4.dp, 4.dp, 4.dp) })
        }
    }
    private fun select(id: String, name: String, code: String) {
        val reconnect = ConnectionStateStore.active && id != ConnectionStateStore.nodeId
        selectedId = id; selectedName = name; selectedCode = code; page = "connect"; render()
        getSharedPreferences("preferences", MODE_PRIVATE).edit().putString("nodeId", id).putString("nodeName", name).putString("nodeCode", code).apply()
        // Connected (or reconnecting): one tap moves the VPN to the new location.
        if (reconnect) {
            startService(Intent(this, ConnectionService::class.java).setAction("disconnect"))
            val started = SystemClock.elapsedRealtime()
            handler.post(object : Runnable {
                override fun run() {
                    // A moment after the old service is gone, so the new connection gets a fresh one.
                    if (!ConnectionStateStore.active) handler.postDelayed({ startConnection() }, 600)
                    else if (SystemClock.elapsedRealtime() - started < 10_000) handler.postDelayed(this, 200)
                }
            })
        }
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
        pageTitle(L10n.text(R.string.account), section = R.string.section_account)
        withAccount { data ->
            val email = data.optString("email"); val name = data.optString("name").ifBlank { email }
            add(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(4.dp, 0, 4.dp, 0)
                addView(text(name.take(1).uppercase(L10n.locale), 18f, Palette.accent, 600).apply {
                    gravity = Gravity.CENTER; background = rounded(Palette.raised, 4)
                }, LinearLayout.LayoutParams(48.dp, 48.dp).apply { marginEnd = 14.dp })
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    // The address is sealed on screen; pressing and holding opens it for as long as the finger stays.
                    addView(SealedText(this@MainActivity).apply {
                        value = email; textSize = 15f; ellipsize = TextUtils.TruncateAt.END; seal(true, animate = false)
                        contentDescription = email; isClickable = true
                        @Suppress("ClickableViewAccessibility")
                        setOnTouchListener { _, e ->
                            when (e.actionMasked) {
                                android.view.MotionEvent.ACTION_DOWN -> seal(false)
                                android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> seal(true)
                            }
                            false
                        }
                    }, LinearLayout.LayoutParams(-1, sp(22f)))
                    addView(mono(L10n.text(R.string.hold_to_reveal), 10f, Palette.faint), LinearLayout.LayoutParams(-2, -2).apply { topMargin = 2.dp })
                    addView(text(L10n.text(R.string.account_valid_until, L10n.date(data.optString("expiresAt"))), 13f, Palette.secondary), LinearLayout.LayoutParams(-2, -2).apply { topMargin = 4.dp })
                }, LinearLayout.LayoutParams(0, -2, 1f))
            }, top = 4)
            usageCard(data)
            add(group(listOf(
                settingRow(L10n.text(R.string.authorized_devices), "${L10n.number(data.optInt("used"))} / ${deviceLimit(data)}") { page = "devices"; render() },
                settingRow(L10n.text(R.string.change_password), "") { resetPassword(email, L10n.text(R.string.reset_change_detail, email), L10n.text(R.string.reset_link_sent_to, email)) },
                settingRow(L10n.text(R.string.language), currentLanguage().second) { chooseLanguage() },
                settingRow(L10n.text(R.string.appearance), L10n.text(if (Palette.theme == "moon") R.string.theme_moon else R.string.theme_amber)) { chooseAppearance() },
                // Android's own kill switch: Always-on VPN with "Block connections without VPN" in system settings.
                settingRow(L10n.text(R.string.kill_switch), "") {
                    AlertDialog.Builder(this@MainActivity).setTitle(L10n.text(R.string.kill_switch)).setMessage(L10n.text(R.string.kill_switch_android_detail))
                        .setPositiveButton(L10n.text(R.string.open_vpn_settings)) { _, _ -> try { startActivity(Intent(android.provider.Settings.ACTION_VPN_SETTINGS)) } catch (_: Exception) { } }
                        .setNegativeButton(L10n.text(R.string.cancel), null).show()
                },
                settingRow(L10n.text(R.string.check_for_updates), "") { update?.let { if (!downloading) startDownload(it) } ?: checkForUpdate(announce = true) }
                    .also { updateRowValue = it.getChildAt(1) as TextView },
                // This build's improvements, from clients/CHANGELOG.md (generated into the string resources).
                settingRow(L10n.text(R.string.whats_new), BuildConfig.VERSION_NAME) { showNotes(BuildConfig.VERSION_NAME, L10n.text(R.string.whats_new_notes).lines().filter { it.isNotBlank() }) },
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
                typeface = Pixel.font(this@MainActivity); letterSpacing = 0.12f
                gravity = Gravity.CENTER; setPadding(0, 16.dp, 0, 8.dp)
                setOnClickListener {
                    val now = SystemClock.elapsedRealtime()
                    if (now - firstTap > 4000) { taps = 0; firstTap = now }
                    if (++taps >= 7) { taps = 0; page = "logs"; render() }
                }
            }, top = 4)
        }
    }
    /**
     * Today / this month / 30 days: the total for the range in the pixel face, a bar per day for the last 30 days with
     * the range lit, and for 30 days the download / upload split. Days are the server's (UTC) days.
     */
    private fun usageCard(data: JSONObject) {
        val traffic = data.optJSONObject("traffic") ?: return
        val down = traffic.optString("downloadBytes", "0").toLongOrNull() ?: 0; val up = traffic.optString("uploadBytes", "0").toLongOrNull() ?: 0
        val perDay = HashMap<String, Long>()
        traffic.optJSONArray("days")?.let { days -> for (i in 0 until days.length()) days.optJSONObject(i)?.let { perDay[it.optString("day").take(10)] = it.optString("bytes", "0").toLongOrNull() ?: 0 } }
        val today = LocalDate.now(ZoneOffset.UTC)
        val card = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; background = rounded(Palette.surface, 16); setPadding(16.dp, 14.dp, 16.dp, 16.dp) }
        val ranges = listOf("today" to R.string.usage_today, "month" to R.string.usage_this_month, "30d" to R.string.last_30_days)
        val switcher = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; background = rounded(Palette.ground, 10); setPadding(2.dp, 2.dp, 2.dp, 2.dp) }
        val figure = text("", 42f).apply { typeface = Pixel.font(this@MainActivity) }
        val bars = UsageBars(this).apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO; values = (29 downTo 0).map { perDay[today.minusDays(it.toLong()).toString()] ?: 0L } }
        val split = text(L10n.text(R.string.download_amount, bytes(down)) + "    " + L10n.text(R.string.upload_amount, bytes(up)), 13f, Palette.secondary)
        fun pick(range: String) {
            usageRange = range
            for (i in 0 until switcher.childCount) (switcher.getChildAt(i) as TextView).apply {
                val on = ranges[i].first == range
                setTextColor(if (on) Palette.text else Palette.secondary); background = if (on) rounded(Palette.selected, 8) else null
                contentDescription = text.toString() + if (on) L10n.text(R.string.current_page) else ""
            }
            val total = when (range) {
                "today" -> perDay[today.toString()] ?: 0L
                "month" -> perDay.filterKeys { it.startsWith(today.toString().take(7)) }.values.sum()
                else -> down + up
            }
            // "143 GB": the number large, its unit small and muted.
            val label = bytes(total); val cut = label.indexOfLast { it.isWhitespace() || it == '\u00A0' }
            figure.text = SpannableString(label).apply { if (cut > 0) { setSpan(AbsoluteSizeSpan(16, true), cut, label.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE); setSpan(ForegroundColorSpan(Palette.secondary), cut, label.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) } }
            bars.recent = when (range) { "today" -> 1; "month" -> today.dayOfMonth.coerceAtMost(30); else -> 30 }
            split.visibility = if (range == "30d") View.VISIBLE else View.GONE
        }
        for ((key, title) in ranges) switcher.addView(text(L10n.text(title), 13f, Palette.secondary, 500).apply {
            gravity = Gravity.CENTER; maxLines = 1; setPadding(12.dp, 0, 12.dp, 0); setOnClickListener { pick(key) }
        }, LinearLayout.LayoutParams(-2, 32.dp))
        card.addView(LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; addView(switcher) })
        card.addView(figure, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 14.dp })
        if (perDay.isNotEmpty()) card.addView(bars, LinearLayout.LayoutParams(-1, 58.dp).apply { topMargin = 14.dp })
        card.addView(split, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 14.dp })
        pick(usageRange)
        add(card, top = 20)
    }
    private fun devices() {
        subPageTitle(L10n.text(R.string.authorized_devices)) { page = "account"; render() }
        withAccount { data ->
            add(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.BOTTOM; setPadding(4.dp, 0, 4.dp, 0)
                addView(text(L10n.text(R.string.devices_used, L10n.number(data.optInt("used")), deviceLimit(data)), 13f, Palette.secondary), LinearLayout.LayoutParams(-2, -2).apply { marginEnd = 12.dp })
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
            if (data.optInt("configs") > 0) add(text(L10n.text(R.string.devices_configs_note, L10n.number(data.optInt("configs"))), 12f, Palette.secondary).apply { setPadding(4.dp, 0, 4.dp, 0) }, top = 12)
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
    private fun shortLanguageName() = when (L10n.locale.language) { "zh" -> "简体中文"; "ru" -> "Русский"; else -> "English" }
    private fun chooseLanguage() {
        val current = currentLanguage().first
        sheet(L10n.text(R.string.language), languages.map { it.second }, languages.indexOfFirst { it.first == current }) { which ->
            if (languages[which].first != current) { L10n.select(languages[which].first); if (Build.VERSION.SDK_INT < 33) recreate() }
        }
    }
    /** Amber (the default) or Moon: the same file, lit in a softer pearl-to-rose light. Applies at once. */
    private fun chooseAppearance() {
        val themes = listOf("amber" to R.string.theme_amber, "moon" to R.string.theme_moon)
        sheet(L10n.text(R.string.appearance), themes.map { L10n.text(it.second) }, themes.indexOfFirst { it.first == Palette.theme }) { which -> applyAppearance(themes[which].first) }
    }
    private fun applyAppearance(theme: String) {
        if (theme == Palette.theme) return
        Palette.theme = theme; getSharedPreferences("preferences", MODE_PRIVATE).edit().putString("appearance", theme).apply()
        @Suppress("DEPRECATION") window.apply { statusBarColor = Palette.ground; navigationBarColor = Palette.ground }
        space.invalidate(); render()
    }
    private fun sheet(title: String, options: List<String>, checked: Int, onPick: (Int) -> Unit) {
        val dialog = Dialog(this).apply { requestWindowFeature(Window.FEATURE_NO_TITLE) }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(20.dp, 10.dp, 20.dp, 28.dp)
            background = GradientDrawable().apply { setColor(Palette.surface); val r = 24.dp.toFloat(); cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f) }
        }
        box.addView(View(this).apply { background = rounded(Color.rgb(52, 49, 43), 2) }, LinearLayout.LayoutParams(36.dp, 4.dp).apply { gravity = Gravity.CENTER_HORIZONTAL })
        box.addView(text(title, 17f, Palette.text, 600).apply { setPadding(4.dp, 0, 0, 0); accessibilityHeading() }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 18.dp; bottomMargin = 14.dp })
        box.addView(group(options.mapIndexed { i, option ->
            row().apply {
                addView(text(option, 15f).apply { maxLines = 1 }, LinearLayout.LayoutParams(0, -2, 1f))
                if (i == checked) addView(icon(R.drawable.ic_check, Palette.accent, 20))
                contentDescription = option + if (i == checked) L10n.text(R.string.current_page) else ""
                setOnClickListener { dialog.dismiss(); onPick(i) }
            }
        }, color = Color.rgb(31, 29, 26)))
        dialog.setContentView(android.widget.ScrollView(this).apply { isVerticalScrollBarEnabled = false; overScrollMode = View.OVER_SCROLL_NEVER; addView(box) })
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); setGravity(Gravity.BOTTOM)
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND); setDimAmount(0.6f)
            @Suppress("DEPRECATION") navigationBarColor = Palette.surface
        }
    }

    /**
     * The connection check: three legs timed on demand. Your network = a small page fetched outside the tunnel,
     * to the location = a TCP connect to the node outside the tunnel, opening a page = the test page through the
     * transport carrying traffic now. One sentence then says which leg is slow.
     */
    private fun connectionCheck() {
        val nodeId = ConnectionStateStore.nodeId; val nodeName = ConnectionStateStore.node
        val dialog = Dialog(this).apply { requestWindowFeature(Window.FEATURE_NO_TITLE) }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(20.dp, 10.dp, 20.dp, 24.dp)
            background = GradientDrawable().apply { setColor(Palette.surface); val r = 24.dp.toFloat(); cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f) }
        }
        box.addView(View(this).apply { background = rounded(Color.rgb(52, 49, 43), 2) }, LinearLayout.LayoutParams(36.dp, 4.dp).apply { gravity = Gravity.CENTER_HORIZONTAL })
        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.BOTTOM }
        head.addView(text(L10n.text(R.string.check_title), 19f, Palette.text, 600).apply { accessibilityHeading() }, LinearLayout.LayoutParams(0, -2, 1f))
        val status = text("", 12f, Palette.secondary).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        head.addView(status, LinearLayout.LayoutParams(-2, -2).apply { marginStart = 12.dp })
        box.addView(head, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 18.dp })
        class Leg(val mark: View, val value: TextView)
        fun leg(title: String, detail: String): Leg {
            val r = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = 58.dp }
            val mark = View(this).apply { setBackgroundColor(Palette.faint) }
            r.addView(mark, LinearLayout.LayoutParams(8.dp, 8.dp).apply { marginEnd = 14.dp })
            r.addView(titles(title, detail), LinearLayout.LayoutParams(0, -2, 1f))
            val value = text("—", 22f).apply { typeface = Pixel.font(this@MainActivity); gravity = Gravity.END; maxLines = 1 }
            r.addView(value, LinearLayout.LayoutParams(-2, -2).apply { marginStart = 12.dp })
            box.addView(r, LinearLayout.LayoutParams(-1, -2))
            return Leg(mark, value)
        }
        val local = leg(L10n.text(R.string.check_local), L10n.text(R.string.check_local_detail))
        val toNode = leg(L10n.text(R.string.check_node), nodeName)
        val web = leg(L10n.text(R.string.check_web), L10n.text(R.string.check_web_detail))
        val verdict = text("", 14f).apply { background = rounded(Color.rgb(31, 29, 26), 12); setPadding(16.dp, 14.dp, 16.dp, 14.dp) }
        box.addView(verdict, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 12.dp })
        Directory.regions[nodeId]?.let { region ->
            box.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = 44.dp; setPadding(2.dp, 0, 2.dp, 0)
                addView(text(L10n.text(R.string.check_exit), 13f, Palette.secondary), LinearLayout.LayoutParams(0, -2, 1f))
                addView(text(region, 13f).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
            }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 6.dp })
        }
        // This node's lines (Line 1…4), each with its delay and the one carrying traffic marked "in use".
        val linesLabel = text(L10n.text(R.string.check_lines), 12f, Palette.secondary).apply { visibility = View.GONE }
        box.addView(linesLabel, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 14.dp })
        class LineBox(val cell: LineCells, val now: TextView, val value: TextView)
        val lineGrid = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        val lineBoxes = Latency.lineOrder.indices.map { i ->
            val cell = LineCells(this).apply { states = listOf(LineCells.WAIT) }
            val now = text(L10n.text(R.string.line_in_use), 11f, Palette.accent).apply { alpha = 0f; maxLines = 1 }
            val value = text("—", 12f, Palette.faint).apply { typeface = Typeface.MONOSPACE; maxLines = 1 }
            val view = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(10.dp, 0, 10.dp, 0)
                background = rounded(Palette.surface, 8)
                addView(cell, LinearLayout.LayoutParams(6.dp, 6.dp).apply { marginEnd = 8.dp })
                addView(text(lineName(i), 13f), LinearLayout.LayoutParams(-2, -2).apply { marginEnd = 6.dp })
                addView(now, LinearLayout.LayoutParams(0, -2, 1f))
                addView(value)
            }
            if (i % 2 == 0) lineGrid.addView(LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }, LinearLayout.LayoutParams(-1, 34.dp).apply { if (i > 0) topMargin = 6.dp })
            (lineGrid.getChildAt(lineGrid.childCount - 1) as LinearLayout).addView(view, LinearLayout.LayoutParams(0, -1, 1f).apply { if (i % 2 == 1) marginStart = 6.dp })
            LineBox(cell, now, value)
        }
        box.addView(lineGrid, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8.dp })
        val lineNote = text("", 13f, Palette.secondary).apply { visibility = View.GONE }
        box.addView(lineNote, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8.dp })
        fun showLines(lines: Map<String, Long>?, current: String) {
            if (lines.isNullOrEmpty()) return
            linesLabel.visibility = View.VISIBLE; lineGrid.visibility = View.VISIBLE
            val states = lineStates(Quality(0, 0, 0, null, lines = lines))!!
            Latency.lineOrder.forEachIndexed { i, name ->
                val ms = lines[name]; val b = lineBoxes[i]
                b.cell.states = listOf(states[i])
                b.value.text = when { ms == null -> L10n.text(R.string.line_off); ms < 0 -> L10n.text(R.string.line_down); else -> L10n.text(R.string.latency_ms, L10n.number(ms)) }
                b.value.setTextColor(when { ms == null -> Palette.faint; ms < 0 -> Palette.danger; else -> Palette.text })
                b.now.fade(name == current)
            }
            val down = Latency.lineOrder.withIndex().filter { (lines[it.value] ?: 0) < 0 }
            val used = Latency.lineOrder.indexOf(current).takeIf { it >= 0 && (lines[current] ?: -1) >= 0 }
            val note = if (down.isNotEmpty() && used != null) L10n.text(R.string.check_lines_note, down.joinToString(if (L10n.locale.language == "zh") "、" else ", ") { lineName(it.index) }, lineName(used)) else ""
            lineNote.text = note; lineNote.visibility = if (note.isEmpty()) View.GONE else View.VISIBLE
        }
        showLines(Latency.recent[nodeId]?.lines, try { Core.now(Transports.GROUP) } catch (_: Exception) { "" })

        // The speed of the current connection: a few seconds of download through the line carrying traffic now.
        val speedCard = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; background = rounded(Palette.surface, 14); setPadding(16.dp, 16.dp, 16.dp, 16.dp) }
        val speedHead = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        speedHead.addView(text(L10n.text(R.string.speed_title), 12f, Palette.secondary), LinearLayout.LayoutParams(0, -2, 1f))
        val elapsed = text("—", 11f, Palette.secondary).apply { typeface = Typeface.MONOSPACE }
        speedHead.addView(elapsed)
        speedCard.addView(speedHead)
        val figure = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.BOTTOM }
        val mbpsText = text("—", 44f, Color.rgb(68, 63, 57)).apply { typeface = Pixel.font(this@MainActivity); includeFontPadding = false; maxLines = 1 }
        figure.addView(mbpsText, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = 6.dp })
        figure.addView(text("Mbps", 13f, Palette.secondary).apply { typeface = Typeface.MONOSPACE }, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = 4.dp })
        speedCard.addView(figure, LinearLayout.LayoutParams(-1, 56.dp).apply { topMargin = 8.dp })
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val barCells = List(30) { View(this).apply { setBackgroundColor(Color.rgb(32, 30, 27)) }.also { bar.addView(it, LinearLayout.LayoutParams(0, -1, 1f).apply { if (bar.childCount > 0) marginStart = 2.dp }) } }
        speedCard.addView(bar, LinearLayout.LayoutParams(-1, 6.dp).apply { topMargin = 12.dp })
        val stats = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        fun stat(title: String) = text("—", 14f).apply { typeface = Typeface.MONOSPACE; maxLines = 1 }.also { value ->
            stats.addView(LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; addView(text(title, 12f, Palette.secondary)); addView(value, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 2.dp }) }, LinearLayout.LayoutParams(0, -2, 1f))
        }
        val latencyText = stat(L10n.text(R.string.speed_latency)); val jitterText = stat(L10n.text(R.string.speed_jitter)); val usedText = stat(L10n.text(R.string.speed_used))
        speedCard.addView(stats, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 12.dp })
        val speedNote = text(L10n.text(R.string.speed_hint), 13f, Palette.secondary).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END; minHeight = sp(13f) + 6.dp }
        speedCard.addView(speedNote, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 12.dp })
        box.addView(speedCard, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 18.dp })
        val speedButton = text(L10n.text(R.string.speed_start), 15f, Palette.onAccent, 600).apply { gravity = Gravity.CENTER; background = pressable(Palette.accent, 12) }
        box.addView(speedButton, LinearLayout.LayoutParams(-1, 48.dp).apply { topMargin = 18.dp })
        var speedLine = ""
        fun lineLabel(name: String) = Latency.lineOrder.indexOf(name).takeIf { it >= 0 }?.let { lineName(it) }
        fun showSpeed(status: JSONObject) {
            val state = status.optString("state")
            val running = state == "ping" || state == "download"
            val seconds = status.optInt("seconds", 6).coerceAtLeast(1)
            val elapsedMs = status.optLong("elapsedMs")
            val fraction = when (state) { "download" -> (elapsedMs / (seconds * 1000f)).coerceIn(0f, 1f); "done" -> 1f; else -> 0f }
            val filled = (fraction * 30).toInt()
            barCells.forEachIndexed { i, v -> v.setBackgroundColor(if (i < filled) (if (state == "done") Palette.accent else Palette.secondary) else Color.rgb(32, 30, 27)) }
            elapsed.text = if (state == "download" || state == "done") String.format(L10n.locale, "%.1f / %.1f s", minOf(elapsedMs, seconds * 1000L) / 1000.0, seconds.toDouble()) else "—"
            val mbps = status.optDouble("mbps", 0.0)
            mbpsText.text = if (state == "download" || state == "done") String.format(L10n.locale, "%.1f", mbps) else "—"
            mbpsText.setTextColor(when (state) { "done" -> Palette.accent; "download" -> Palette.secondary; else -> Color.rgb(68, 63, 57) })
            val latency = status.optInt("latency", -1); val jitter = status.optInt("jitter", -1)
            latencyText.text = if (latency >= 0) L10n.text(R.string.latency_ms, L10n.number(latency)) else "—"
            jitterText.text = if (jitter >= 0) L10n.text(R.string.latency_ms, L10n.number(jitter)) else "—"
            usedText.text = if (status.optLong("bytes") > 0) bytes(status.optLong("bytes")) else "—"
            status.optString("line").takeIf { it.isNotEmpty() }?.let { speedLine = it }
            val over = lineLabel(speedLine) ?: nodeName
            speedNote.swap(when (state) {
                "ping", "download" -> L10n.text(R.string.speed_downloading, over)
                "done" -> if (lineLabel(speedLine) != null) L10n.text(R.string.speed_done, over, nodeName) else nodeName
                "failed" -> L10n.text(R.string.speed_failed)
                else -> L10n.text(R.string.speed_hint)
            })
            speedButton.text = L10n.text(when { running -> R.string.speed_running; state == "done" || state == "failed" -> R.string.speed_again; else -> R.string.speed_start })
            speedButton.isEnabled = !running; speedButton.alpha = if (running) 0.45f else 1f
        }
        val speedTick = object : Runnable {
            override fun run() {
                if (!dialog.isShowing) return
                val status = try { JSONObject(Core.speedProgress()) } catch (_: Exception) { return }
                showSpeed(status)
                if (status.optString("state") in listOf("ping", "download")) handler.postDelayed(this, 200)
                else if (status.optString("state") == "done") Journal.add("speed: ${status.optString("line")} ${status.optDouble("mbps")} Mbps, ${status.optLong("bytes")} bytes, latency ${status.optInt("latency")} ms, jitter ${status.optInt("jitter")} ms")
                else if (status.optString("state") == "failed") Journal.add("speed: failed ${status.optString("error")} over ${status.optString("line")}")
            }
        }
        speedButton.setOnClickListener {
            val request = JSONObject().put("group", Transports.GROUP).put("pingUrl", Transports.TEST_URL).put("url", Latency.SPEED_URL).put("seconds", 6)
            val reply = try { Core.speedStart(request.toString()) } catch (_: Exception) { "error" }
            if (reply != "ok") { showSpeed(JSONObject().put("state", "failed")); return@setOnClickListener }
            handler.removeCallbacks(speedTick); handler.post(speedTick)
        }
        dialog.setOnDismissListener { handler.removeCallbacks(speedTick); try { Core.speedStop() } catch (_: Exception) { } }
        showSpeed(JSONObject().put("state", "idle"))

        val other = text(L10n.text(R.string.change_location).replace("›", "").trim(), 15f, Palette.onAccent, 600).apply {
            gravity = Gravity.CENTER; background = pressable(Palette.accent, 12); visibility = View.GONE
            setOnClickListener { dialog.dismiss(); page = "nodes"; render() }
        }
        box.addView(other, LinearLayout.LayoutParams(-1, 48.dp).apply { topMargin = 12.dp })
        val again = text(L10n.text(R.string.check_again), 15f).apply { gravity = Gravity.CENTER; background = pressable(Color.rgb(31, 29, 26), 12) }
        box.addView(again, LinearLayout.LayoutParams(-1, 48.dp).apply { topMargin = 10.dp })
        val ok = Palette.accent; val slow = Palette.fair; val bad = Palette.danger
        fun show(leg: Leg, ms: Int, limit: Int) {
            val color = when { ms < 0 -> bad; ms > limit -> slow; else -> ok }
            leg.mark.setBackgroundColor(color); leg.value.setTextColor(color)
            leg.value.text = if (ms < 0) L10n.text(R.string.check_no_answer) else L10n.text(R.string.latency_ms, L10n.number(ms))
            leg.value.textSize = if (ms < 0) 14f else 22f; leg.value.typeface = if (ms < 0) Typeface.DEFAULT else Pixel.font(this)
        }
        var running = false
        fun runCheck() {
            if (running) return
            running = true
            status.text = L10n.text(R.string.check_running); verdict.text = L10n.text(R.string.check_running); other.visibility = View.GONE
            for (leg in listOf(local, toNode, web)) { leg.mark.setBackgroundColor(Palette.faint); leg.value.setTextColor(Palette.faint); leg.value.text = "—"; leg.value.textSize = 22f; leg.value.typeface = Pixel.font(this) }
            Thread {
                fun delay(result: String) = result.substringAfter('=', "-1").toIntOrNull() ?: -1
                val a = try { delay(Core.probe("DIRECT", Transports.LOCAL_URL, 3000)) } catch (_: Exception) { -1 }
                val b = Directory.probes[nodeId]?.let { try { Core.reach(it, 3000).toInt() } catch (_: Exception) { -1 } } ?: -1
                val current = try { Core.now(Transports.GROUP) } catch (_: Exception) { "" }
                val c = if (current.isEmpty()) -1 else try { delay(Core.probe(current, Transports.TEST_URL, 5000)) } catch (_: Exception) { -1 }
                // Each line again, outside the tunnel, as the location list measures them.
                val lines = Directory.tests[nodeId]?.let { Latency.real(nodeId, it)?.second }?.takeIf { it.isNotEmpty() }
                lines?.let { fresh -> Latency.recent[nodeId]?.let { Latency.recent[nodeId] = it.copy(lines = fresh) } }
                runOnUiThread {
                    running = false
                    if (!dialog.isShowing) return@runOnUiThread
                    show(local, a, 300); show(toNode, b, 300); show(web, c, 1200)
                    showLines(lines ?: Latency.recent[nodeId]?.lines, current)
                    status.text = nodeName
                    val nodeSlow = b < 0 || b > 300; val localSlow = a < 0 || a > 300; val webSlow = c < 0 || c > 1200
                    verdict.text = when {
                        a < 0 && b < 0 && c < 0 -> L10n.text(R.string.check_failed)
                        localSlow && (nodeSlow || webSlow) -> L10n.text(R.string.check_local_slow)
                        nodeSlow -> L10n.text(R.string.check_node_slow, nodeName)
                        webSlow -> L10n.text(R.string.check_web_slow)
                        localSlow -> L10n.text(R.string.check_local_slow)
                        else -> L10n.text(R.string.check_ok)
                    }
                    other.visibility = if (!localSlow && (nodeSlow || webSlow)) View.VISIBLE else View.GONE
                }
            }.start()
        }
        again.setOnClickListener { runCheck() }
        dialog.setContentView(android.widget.ScrollView(this).apply { isVerticalScrollBarEnabled = false; overScrollMode = View.OVER_SCROLL_NEVER; addView(box) })
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); setGravity(Gravity.BOTTOM)
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND); setDimAmount(0.6f)
            @Suppress("DEPRECATION") navigationBarColor = Palette.surface
        }
        runCheck()
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
                if (found.update?.build != update?.build || found.announcement != announcement) {
                    if (downloading && found.update?.build != update?.build) updater.cancel()
                    val announcementChanged = found.announcement != announcement
                    update = found.update; announcement = found.announcement; downloadError = ""
                    // On the connect page only the banner and the tab dot change, so the page eases instead of rebuilding.
                    if (!busy) { if (page == "connect" && banner != null && !announcementChanged) { showUpdate(); accountDot?.visibility = if (update != null) View.VISIBLE else View.INVISIBLE } else render() }
                }
            }
        }.start()
    }

    private enum class UpdatePhase { NONE, AVAILABLE, DOWNLOADING, READY, FAILED }
    private fun updatePhase(available: UpdateInfo) = when {
        downloading -> UpdatePhase.DOWNLOADING
        updater.downloaded(available) != null -> UpdatePhase.READY
        downloadError.isNotEmpty() -> UpdatePhase.FAILED
        else -> UpdatePhase.AVAILABLE
    }
    /** "12.4 MB / 29.6 MB · about 20 s"; the time appears once the core's rate has settled. */
    private fun downloadMeta(state: DownloadState?, available: UpdateInfo): String {
        val received = state?.received ?: 0L; val size = state?.size?.takeIf { it > 0 } ?: available.sizeBytes
        val seconds = state?.seconds ?: -1
        val left = when { seconds < 0 -> ""; seconds < 60 -> L10n.text(R.string.update_seconds, L10n.number(seconds.toInt())); else -> L10n.text(R.string.update_minutes, L10n.number(((seconds + 59) / 60).toInt())) }
        return "${bytes(received)} / ${bytes(size)}" + if (left.isEmpty()) "" else " · " + L10n.text(R.string.update_time_left, left)
    }
    private fun percent(state: DownloadState?, available: UpdateInfo) =
        ((state?.received ?: 0L) * 100 / (state?.size?.takeIf { it > 0 } ?: available.sizeBytes).coerceAtLeast(1)).toInt().coerceIn(0, 100)

    /** Fills the home banner and the account row from the update state; called on every progress tick. */
    private fun showUpdate() {
        val available = update
        updateRowValue?.text = when (available?.let { updatePhase(it) }) {
            null, UpdatePhase.NONE -> L10n.text(R.string.up_to_date)
            UpdatePhase.DOWNLOADING -> L10n.text(R.string.update_downloading_value, "${percent(download, available!!)}%")
            UpdatePhase.READY -> L10n.text(R.string.update_install)
            else -> L10n.text(R.string.update_banner_title, available!!.version)
        }
        val holder = banner ?: return
        val phase = available?.let { updatePhase(it) } ?: UpdatePhase.NONE
        if (available == null || (phase == UpdatePhase.AVAILABLE && updater.dismissed(available))) { holder.removeAllViews(); holder.visibility = View.GONE; return }
        holder.visibility = View.VISIBLE
        if (phase == UpdatePhase.DOWNLOADING && holder.tag == "downloading" && holder.childCount == 1) { fillProgress(holder.getChildAt(0) as LinearLayout, available); return }
        holder.removeAllViews(); holder.tag = if (phase == UpdatePhase.DOWNLOADING) "downloading" else ""
        val card: LinearLayout = when (phase) {
            UpdatePhase.DOWNLOADING -> progressCard(available)
            UpdatePhase.READY -> bannerRow(L10n.text(R.string.update_ready_title, available.version),
                L10n.text(if (ConnectionStateStore.active) R.string.update_ready_detail else R.string.update_ready_detail_idle),
                bannerButton(L10n.text(R.string.update_install), filled = true) { installUpdate(available) })
            UpdatePhase.FAILED -> bannerRow(L10n.text(R.string.update_failed_title, available.version),
                L10n.text(when (downloadError) { "digest" -> R.string.update_failed_digest; "storage" -> R.string.update_failed_storage; "package" -> R.string.update_failed_package; else -> R.string.update_failed_network }),
                bannerButton(L10n.text(R.string.update_retry)) { startDownload(available) })
            else -> bannerRow(L10n.text(if (available.mandatory) R.string.update_required_title else R.string.update_banner_title, available.version),
                if (available.mandatory) L10n.text(R.string.update_required_detail) else L10n.notes(available.notes).firstOrNull() ?: L10n.text(R.string.update_available_detail),
                bannerButton(L10n.text(R.string.update_action)) { startDownload(available) },
                if (available.mandatory) null else text("×", 20f, Palette.faint).apply {
                    gravity = Gravity.CENTER; background = pressable(Color.TRANSPARENT, 10); contentDescription = L10n.text(R.string.update_later)
                    layoutParams = LinearLayout.LayoutParams(40.dp, 44.dp); setOnClickListener { updater.dismiss(available); showUpdate() }
                }).apply {
                    // The banner shows the first improvement; a tap lists them all, with the update button.
                    val items = L10n.notes(available.notes)
                    if (items.size > 1) { background = pressable(Palette.surface, 16); setOnClickListener {
                        showNotes(available.version, items, L10n.text(R.string.update_action)) { if (!downloading) startDownload(available) }
                    } }
                }
        }
        holder.addView(card, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 4.dp; bottomMargin = 8.dp })
    }
    /** What's new in a version: one line per improvement, optionally with an action (update). */
    private fun showNotes(version: String, items: List<String>, action: String? = null, onAction: (() -> Unit)? = null) {
        val dialog = AlertDialog.Builder(this).setTitle(L10n.text(R.string.whats_new_title, version)).setMessage(items.joinToString("\n") { "· $it" })
        if (action != null && onAction != null) dialog.setPositiveButton(action) { _, _ -> onAction() }.setNegativeButton(L10n.text(R.string.update_later), null)
        else dialog.setPositiveButton(L10n.text(R.string.got_it), null)
        dialog.show()
    }
    private fun bannerButton(title: String, filled: Boolean = false, onClick: () -> Unit) = text(title, 14f, if (filled) Palette.onAccent else Palette.accent, 600).apply {
        gravity = Gravity.CENTER; setPadding(if (filled) 16.dp else 12.dp, 0, if (filled) 16.dp else 12.dp, 0)
        background = if (filled) RippleDrawable(ColorStateList.valueOf(Palette.alpha(Palette.onAccent, 40)), rounded(Palette.accent, 10), null) else pressable(Color.TRANSPARENT, 10)
        layoutParams = LinearLayout.LayoutParams(-2, if (filled) 40.dp else 44.dp).apply { marginStart = 8.dp }
        setOnClickListener { if (!busy) onClick() }
    }
    private fun bannerRow(title: String, detail: String, action: View, trailing: View? = null) = row(60).apply {
        background = rounded(Palette.surface, 16); setPadding(16.dp, 8.dp, if (trailing != null) 4.dp else 8.dp, 8.dp)
        addView(titles(title, detail).apply { (getChildAt(1) as TextView).maxLines = 2 })
        addView(action); trailing?.let { addView(it) }
    }
    /** Title, size and time left, a big percentage, and a bar of square blocks (the brand's pixel accent). */
    private fun progressCard(available: UpdateInfo) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; background = rounded(Palette.surface, 16); setPadding(16.dp, 12.dp, 8.dp, 14.dp)
        val top = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        top.addView(titles(L10n.text(if (available.mandatory) R.string.update_required_title else R.string.update_downloading_title, available.version), " "))
        top.addView(text("", 22f, Palette.accent).apply { typeface = Pixel.font(this@MainActivity) }, LinearLayout.LayoutParams(-2, -2).apply { marginStart = 8.dp })
        if (!available.mandatory) top.addView(text(L10n.text(R.string.cancel), 13f, Palette.secondary).apply {
            gravity = Gravity.CENTER; setPadding(10.dp, 0, 10.dp, 0); background = pressable(Color.TRANSPARENT, 10)
            setOnClickListener { updater.cancel() }
        }, LinearLayout.LayoutParams(-2, 44.dp))
        addView(top)
        val blocks = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        repeat(30) { i -> blocks.addView(View(this@MainActivity), LinearLayout.LayoutParams(0, 6.dp, 1f).apply { if (i > 0) marginStart = 3.dp }) }
        addView(blocks, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 10.dp; marginEnd = 8.dp })
        fillProgress(this, available)
    }
    private fun fillProgress(card: LinearLayout, available: UpdateInfo) {
        val top = card.getChildAt(0) as LinearLayout; val names = top.getChildAt(0) as LinearLayout
        val value = percent(download, available)
        (names.getChildAt(1) as TextView).apply { text = downloadMeta(download, available); visibility = View.VISIBLE }
        (top.getChildAt(1) as TextView).text = "$value%"
        val blocks = card.getChildAt(1) as LinearLayout
        for (i in 0 until blocks.childCount) blocks.getChildAt(i).setBackgroundColor(if (i < value * blocks.childCount / 100) Palette.accent else Palette.raised)
        card.contentDescription = L10n.text(R.string.update_downloading_title, available.version) + ", $value%"
    }

    /** One tap: the download runs in the core (CDN first, then the server, resuming), then the system installer. */
    private fun startDownload(available: UpdateInfo) {
        if (downloading) return
        if (updater.downloaded(available) != null) { installUpdate(available); return }
        if (!updater.canInstall()) { alert(L10n.text(R.string.update_allow_installs)); startActivity(updater.installPermissionIntent()); return }
        downloading = true; downloadError = ""; download = null
        showUpdate(); handler.post(downloadTick)
        Thread {
            val result = try { updater.download(available) } catch (e: Exception) { DownloadState("failed", 0, 0, -1, "", "network", e.javaClass.simpleName) }
            runOnUiThread {
                downloading = false; handler.removeCallbacks(downloadTick); download = result
                if (result.state == "failed") downloadError = result.error.ifEmpty { "network" }
                if (isDestroyed) return@runOnUiThread
                showUpdate()
                // Straight to the installer when nobody would lose a connection; otherwise the banner offers Install.
                if (result.state == "done" && visible && !ConnectionStateStore.active) installUpdate(available)
            }
        }.start()
    }
    private fun installUpdate(available: UpdateInfo) {
        if (!updater.canInstall()) { alert(L10n.text(R.string.update_allow_installs)); startActivity(updater.installPermissionIntent()); return }
        if (updater.downloaded(available) == null) { startDownload(available); return }
        // A package for another app is deleted by install(); the banner then offers the download again.
        work({ updater.install(available, reconnect = ConnectionStateStore.active) }) {}
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
    /** "host:port,host:port" each node answers TCP on (the latency probes; the first answer counts), and its region name: for the connection check. */
    val probes = ConcurrentHashMap<String, String>()
    val regions = ConcurrentHashMap<String, String>()
    /** The transports this device can test on each node (the server's "test" list): the connection check re-tests each line. */
    val tests = ConcurrentHashMap<String, org.json.JSONArray>()
    fun remember(list: org.json.JSONArray) {
        for (i in 0 until list.length()) list.optJSONObject(i)?.let { node ->
            val id = node.getString("id")
            nodes[id] = node.getString("name") to node.optString("countryCode").takeIf { it.length == 2 }?.uppercase()
            Latency.probes(node).takeIf { it.isNotEmpty() }?.let { list -> probes[id] = list.joinToString(",") { (host, port) -> (if (host.contains(':')) "[$host]" else host) + ":" + port } }
            node.optString("region").takeIf { it.isNotBlank() && it != "null" }?.let { regions[id] = it }
            node.optJSONArray("test")?.takeIf { it.length() > 0 }?.let { tests[id] = it }
        }
    }
    /** The country code, or the name's first letter when the location has no region. */
    fun code(id: String, name: String): String = nodes[id]?.second ?: name.trim().take(1).uppercase()
}
