package com.veilbird.client

import android.content.Context
import kotlin.math.roundToInt
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

/** First-run steps before the tab bar appears: sign in, then connect (the location starts on Automatic). */
private const val STEPS = 2

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
    private var portrait: Portrait? = null
    private var fileLines: List<SealedText>? = null
    // Whether the file was last shown sealed; null before the first show on a page (which does not animate).
    private var sealedShown: Boolean? = null
    private var shownState: LinkState? = null
    private var shownTrouble: Trouble? = null
    /** False on a new install until its first connection: sign-in and connect then show "n/2" and no tab bar (the location is Automatic until changed). */
    private var onboarded = true
    private var stepsRow: LinearLayout? = null
    private var firstNote: View? = null
    private var secondary: TextView? = null
    private var visitorIp: String? = null
    private var stateTitle: TextView? = null
    private var stateDot: View? = null
    private var stateDetail: TextView? = null
    private var accountDot: View? = null
    private var nodeTitle: TextView? = null
    private var nodeDetail: TextView? = null
    private var nodeBadge: FrameLayout? = null
    private var rateBars: RateBars? = null
    private var switchNote: View? = null
    /** Under a network failure: the four steps and where the attempt stopped. The location row and the usage give it their room. */
    private var checksCard: LinearLayout? = null
    private var nodeRow: View? = null
    private var usageRow: View? = null
    private var shownChecks: List<Check>? = null
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
    /** A finger is on a connection row: the list waits (rebuilding it would cancel the long press). */
    private var activityHeld = false
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
        // A new activity (also after a language change) looks the language up once more.
        L10n.forget(); super.onCreate(savedInstanceState); api = NativeApi(this); updater = Updater(this, api); NodeCache.restore(this)
        val settings = getSharedPreferences("preferences", MODE_PRIVATE)
        Palette.theme = settings.getString("appearance", "amber")!!
        selectedId = settings.getString("nodeId", "")!!; selectedName = settings.getString("nodeName", "")!!; selectedCode = settings.getString("nodeCode", "")!!
        // Someone already signed in when this version arrives is not new: only a fresh install gets the first-run steps.
        if (!settings.contains("onboarded")) settings.edit().putBoolean("onboarded", api.secret("token") != null).apply()
        onboarded = settings.getBoolean("onboarded", true)
        @Suppress("DEPRECATION") window.apply { statusBarColor = Palette.ground; navigationBarColor = Palette.ground; decorView.systemUiVisibility = 0 }
        // A long press on the Quick Settings tile opens the location list.
        if (intent?.action == "android.service.quicksettings.action.QS_TILE_PREFERENCES" && api.secret("token") != null) page = "nodes"
        render()
        executor.execute { Crash.send(this, api) }
        // The Quick Settings tile could not start the VPN from the background: connect now that the app is open.
        intent?.data?.let { qrFromLink(it) }
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
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 7 && grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED) accountData?.let { AccessReminders.check(this, AccountAccess.from(it)) }
    }
    override fun onPause() { visible = false; handler.removeCallbacks(refresh); super.onPause() }
    override fun onDestroy() { handler.removeCallbacks(updateCheck); handler.removeCallbacks(downloadTick); executor.shutdown(); super.onDestroy() }
    @Deprecated("Back handling for API 26+")
    override fun onBackPressed() {
        when (page) {
            "devices", "logs", "apps", "rules" -> { page = "account"; render() }
            "nodes", "account", "activity", "usage" -> { page = "connect"; render() }
            else -> super.onBackPressed()
        }
    }

    // ---- Building blocks: one radius (nearly square), one palette, one type scale.
    private val Int.dp get() = (this * resources.displayMetrics.density).toInt()
    // Every block is a soft filled shape on the ground, never an outline: cards are "surface", the main action is
    // solid amber with dark text. Rounded corners, no strokes anywhere.
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
    private fun pageTitle(title: String, trailing: View? = null) {
        fileHeader()
        add(View(this), height = 14.dp)
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
        stamp = null; portrait = null; action = null; actionLabel = null; actionDot = null; scan = null; fileLines = null; stateTitle = null; stateDot = null; stateDetail = null; accountDot = null; nodeTitle = null; nodeDetail = null; nodeBadge = null
        rateBars = null; switchNote = null; switchText = null; activityBody = null; stepsRow = null; firstNote = null; secondary = null; shownTrouble = null
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
        val view = if (!signedIn) "login" else page
        if (view != lastView) { content.alpha = 0f; content.translationY = 8.dp.toFloat(); content.animate().alpha(1f).translationY(0f).setDuration(200).setInterpolator(DecelerateInterpolator()).start() }
        lastView = view
        if (!signedIn) { accountData = null; login(); return }
        when (page) {
            "connect" -> home()
            "nodes" -> nodes()
            "devices" -> devices()
            "apps" -> appsPage()
            "rules" -> rulesPage()
            "logs" -> logs()
            "activity" -> activity()
            "usage" -> usagePage()
            else -> account()
        }
        showUpdate()
        // The tab bar waits for the first connection, so a new person sees only the step in front of them.
        if (onboarded && page in listOf("connect", "nodes", "activity", "account")) root.addView(tabBar())
        handler.removeCallbacks(refresh); if (visible) handler.post(refresh)
    }
    private fun tabBar() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setBackgroundColor(Palette.alpha(Palette.ground, 200))
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
        pageTitle(L10n.text(R.string.activity_title))
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
        if (activityLoading || activityBody == null || activityHeld) return
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
                    background = rounded(if (selected) Palette.selected else Palette.surface, 10)
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
                background = pressable(Color.TRANSPARENT, 10)
                // Tap: why it went this way; long press: the row's actions (rules, copy, close).
                setOnClickListener { connectionSheet(c) }
                setOnLongClickListener { activityHeld = false; connectionSheet(c); true }
                @Suppress("ClickableViewAccessibility")
                setOnTouchListener { _, event ->
                    when (event.actionMasked) {
                        android.view.MotionEvent.ACTION_DOWN -> activityHeld = true
                        android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> activityHeld = false
                    }
                    false
                }
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
    // ---- A connection's actions (long press) and why it went the way it did (tap) ----
    private fun bottomSheet(build: (Dialog, LinearLayout) -> Unit) {
        val dialog = Dialog(this).apply { requestWindowFeature(Window.FEATURE_NO_TITLE) }
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(20.dp, 10.dp, 20.dp, 28.dp)
            background = GradientDrawable().apply { setColor(Palette.surface); val r = 24.dp.toFloat(); cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f) }
        }
        box.addView(View(this).apply { background = rounded(Color.rgb(52, 49, 43), 2) }, LinearLayout.LayoutParams(36.dp, 4.dp).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = 18.dp })
        build(dialog, box)
        dialog.setContentView(android.widget.ScrollView(this).apply { isVerticalScrollBarEnabled = false; overScrollMode = View.OVER_SCROLL_NEVER; addView(box) })
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)); setGravity(Gravity.BOTTOM)
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND); setDimAmount(0.6f)
            @Suppress("DEPRECATION") navigationBarColor = Palette.surface
        }
    }
    private fun connectionExit(c: JSONObject) = if (c.optBoolean("proxy")) ConnectionStateStore.node.ifEmpty { c.optString("via") } else L10n.text(R.string.activity_direct)
    private fun connectionSheet(c: JSONObject) = bottomSheet { dialog, box ->
        val host = c.optString("host"); val id = c.optString("id"); val site = Advanced.site(host)
        box.addView(text(host, 17f, Palette.text, 600).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.MIDDLE; setPadding(4.dp, 0, 4.dp, 0); accessibilityHeading() })
        routePath(box, c)
        if (host.isNotEmpty()) {
            // The reach of the rule: the whole site (and its subdomains) or only this name.
            var whole = true
            if (site != host) {
                val pills = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(2.dp, 2.dp, 2.dp, 2.dp); background = rounded(Color.rgb(31, 29, 26), 12) }
                val options = listOf(L10n.text(R.string.menu_whole_site, site), L10n.text(R.string.menu_only_domain, host))
                val views = options.map { label -> text(label, 13f, Palette.secondary, 500).apply { gravity = Gravity.CENTER; maxLines = 1; ellipsize = TextUtils.TruncateAt.MIDDLE; setPadding(8.dp, 0, 8.dp, 0) } }
                fun paint() = views.forEachIndexed { i, v ->
                    val on = (i == 0) == whole
                    v.setTextColor(if (on) Palette.text else Palette.secondary); v.background = if (on) rounded(Palette.selected, 10) else pressable(Color.TRANSPARENT, 10)
                    v.contentDescription = options[i] + if (on) L10n.text(R.string.current_page) else ""
                }
                views.forEachIndexed { i, v -> v.setOnClickListener { whole = i == 0; paint() }; pills.addView(v, LinearLayout.LayoutParams(0, -1, 1f)) }
                paint()
                box.addView(pills, LinearLayout.LayoutParams(-1, 40.dp).apply { bottomMargin = 10.dp })
            }
            box.addView(group(listOf(R.string.menu_always_proxy to "proxy", R.string.menu_always_direct to "direct", R.string.menu_block to "block").map { (label, policy) ->
                row().apply {
                    addView(text(L10n.text(label), 15f, if (policy == "block") Palette.danger else Palette.text).apply { maxLines = 1 }, LinearLayout.LayoutParams(0, -2, 1f))
                    setOnClickListener { dialog.dismiss(); addQuickRule(if (whole) site else host, whole, policy) }
                }
            }, color = Color.rgb(31, 29, 26)), LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 10.dp })
        }
        val actions = mutableListOf<View>()
        if (host.isNotEmpty()) actions += row().apply {
            addView(text(L10n.text(R.string.menu_copy_domain), 15f).apply { maxLines = 1 }, LinearLayout.LayoutParams(0, -2, 1f))
            setOnClickListener {
                dialog.dismiss()
                getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("TrackNothing", host))
                Toast.makeText(this@MainActivity, L10n.text(R.string.menu_copied), Toast.LENGTH_SHORT).show()
            }
        }
        if (id.isNotEmpty()) actions += row().apply {
            addView(text(L10n.text(R.string.menu_close_connection), 15f).apply { maxLines = 1 }, LinearLayout.LayoutParams(0, -2, 1f))
            setOnClickListener { dialog.dismiss(); executor.execute { try { Core.closeConnection(id) } catch (_: Exception) { } } }
        }
        actions += row().apply {
            addView(text(L10n.text(R.string.why_open_rules), 15f).apply { maxLines = 1 }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(chevron())
            setOnClickListener { dialog.dismiss(); page = "rules"; render() }
        }
        box.addView(group(actions, color = Color.rgb(31, 29, 26)))
    }
    /** Which rule sent the connection where it went: a short name for the path, and one sentence. */
    private fun reason(c: JSONObject): Pair<String, String> {
        val rule = c.optString("rule"); val proxy = c.optBoolean("proxy")
        if (c.optBoolean("mine")) return L10n.text(R.string.why_mine) to L10n.text(R.string.why_mine_line, rule)
        return when {
            rule == "RULE-SET,ai" -> L10n.text(R.string.why_ai) to L10n.text(R.string.why_ai_line)
            rule == "RULE-SET,cn_domain" || rule == "RULE-SET,cn_ip" -> L10n.text(R.string.why_cn) to L10n.text(R.string.why_cn_line)
            rule == "RULE-SET,private_domain" || rule.startsWith("IP-CIDR,") -> L10n.text(R.string.why_local) to L10n.text(R.string.why_local_line)
            rule == "MATCH" -> L10n.text(R.string.why_rest) to L10n.text(if (proxy) R.string.why_rest_proxy else R.string.why_rest_direct)
            rule.startsWith("PROCESS-NAME,") -> L10n.text(R.string.why_app) to L10n.text(R.string.why_app_line)
            else -> rule.ifEmpty { "—" } to ""
        }
    }
    private fun pathChip(label: String, lit: Boolean = false, mono: Boolean = false) = text(label, 13f, if (lit) Palette.text else Palette.secondary).apply {
        maxLines = 1; ellipsize = TextUtils.TruncateAt.END; gravity = Gravity.CENTER_VERTICAL; setPadding(12.dp, 0, 12.dp, 0)
        if (mono) typeface = Typeface.MONOSPACE
        background = rounded(if (lit) Palette.selected else Color.rgb(36, 34, 30), 9)
    }
    /** Why the connection went the way it did: the rule, encrypted or direct, the exit and the line, and one sentence. */
    private fun routePath(box: LinearLayout, c: JSONObject) {
        val proxy = c.optBoolean("proxy"); val via = c.optString("via"); val exit = connectionExit(c)
        val (chip, line) = reason(c)
        box.addView(text(L10n.text(R.string.menu_why), 13f, Palette.secondary).apply { setPadding(4.dp, 0, 4.dp, 0) }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 14.dp; bottomMargin = 8.dp })
        fun pathRow(views: List<View>) = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            views.forEachIndexed { i, v ->
                if (i > 0) addView(text("→", 13f, Palette.faint), LinearLayout.LayoutParams(-2, -2).apply { marginStart = 6.dp; marginEnd = 6.dp })
                addView(v, LinearLayout.LayoutParams(-2, 32.dp).apply { if (v.tag == "fill") { width = 0; weight = 1f } })
            }
        }
        box.addView(pathRow(listOf(pathChip(chip, lit = true), pathChip(L10n.text(if (proxy) R.string.activity_proxy else R.string.activity_direct)))))
        if (proxy) {
            // The exit and the line on a second row, so long location names keep their room on a narrow phone.
            val second = mutableListOf<View>(pathChip(exit).apply { tag = "fill" })
            if (via.isNotEmpty() && via != exit) second += pathChip(via, mono = true)
            box.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                addView(text("→", 13f, Palette.faint), LinearLayout.LayoutParams(-2, -2).apply { marginEnd = 6.dp })
                addView(pathRow(second), LinearLayout.LayoutParams(0, -2, 1f))
            }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8.dp })
        }
        if (line.isNotEmpty()) box.addView(text(line, 14f, Palette.secondary).apply { setPadding(4.dp, 0, 4.dp, 0) }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 12.dp })
        box.addView(View(this), LinearLayout.LayoutParams(-1, 16.dp))
    }
    /**
     * Saves a quick rule and hands the rules to the running core, which applies them at once; the open connections
     * to the name are closed so its next request takes the new route. A note with Undo follows.
     */
    /** A rule change asks first (one slip in a list that moves would otherwise reroute a site). */
    private fun addQuickRule(name: String, site: Boolean, policy: String) = bottomSheet { dialog, box ->
        val label = L10n.text(when (policy) { "direct" -> R.string.menu_always_direct; "block" -> R.string.menu_block; else -> R.string.menu_always_proxy })
        box.addView(text(L10n.text(R.string.rule_confirm, name, label), 17f, Palette.text, 600).apply { setPadding(4.dp, 0, 4.dp, 0); accessibilityHeading() })
        box.addView(text(L10n.text(if (site) R.string.rule_confirm_site else R.string.rule_confirm_domain), 14f, Palette.secondary).apply { setPadding(4.dp, 0, 4.dp, 0) },
            LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8.dp })
        box.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(text(L10n.text(R.string.cancel), 15f, Palette.text, 500).apply {
                gravity = Gravity.CENTER; maxLines = 1; background = pressable(Palette.raised, 12)
                setOnClickListener { dialog.dismiss() }
            }, LinearLayout.LayoutParams(0, 48.dp, 1f).apply { marginEnd = 10.dp })
            addView(text(L10n.text(R.string.rule_confirm_ok), 15f, Palette.onAccent, 600).apply {
                gravity = Gravity.CENTER; maxLines = 1; background = pressable(Palette.accent, 12)
                setOnClickListener { dialog.dismiss(); applyQuickRule(name, site, policy) }
            }, LinearLayout.LayoutParams(0, 48.dp, 1f))
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 20.dp })
    }
    private fun applyQuickRule(name: String, site: Boolean, policy: String) {
        // A rule from here turns on the person's routing rules (part of advanced) if they were off.
        val before = Advanced.setQuickRule(this, name, site, policy)
        applyRules(name, site) { live ->
            undoBar(L10n.text(if (live) R.string.rule_added else R.string.rule_added_later, name, L10n.text(when (policy) { "direct" -> R.string.policy_direct; "block" -> R.string.policy_block; else -> R.string.policy_proxy })), before)
        }
    }
    /** true when the core took the rules (or nothing is connected); a core that refuses them leaves them for the next connection. */
    private fun applyRules(name: String?, site: Boolean, done: (Boolean) -> Unit = {}) {
        if (!(ConnectionStateStore.active && ConnectionStateStore.since > 0)) { done(true); return }
        val lines = org.json.JSONArray(Advanced.rules(this)).toString()
        executor.execute {
            val live = try { Core.setRules(lines); if (name != null) Core.closeHost(name, site); true } catch (_: Exception) { false }
            runOnUiThread { if (!isDestroyed) done(live) }
        }
    }
    private var undoView: View? = null
    private fun undoBar(message: String, before: String?) {
        val host = findViewById<FrameLayout>(android.R.id.content)
        undoView?.let { host.removeView(it) }
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(18.dp, 12.dp, 10.dp, 12.dp)
            background = rounded(Color.rgb(44, 41, 37), 14); elevation = 6.dp.toFloat()
            addView(text(message, 14f), LinearLayout.LayoutParams(0, -2, 1f))
            if (before != null) addView(text(L10n.text(R.string.rule_undo), 14f, Palette.accent, 600).apply {
                setPadding(12.dp, 8.dp, 12.dp, 8.dp); background = pressable(Color.TRANSPARENT, 10)
                setOnClickListener { Advanced.saveRules(this@MainActivity, before); applyRules(null, false); undoBar(L10n.text(R.string.rule_undone), null) }
            }, LinearLayout.LayoutParams(-2, -2).apply { marginStart = 8.dp })
        }
        undoView = bar
        host.addView(bar, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply { leftMargin = 16.dp; rightMargin = 16.dp; bottomMargin = 96.dp })
        bar.postDelayed({ if (undoView === bar) { host.removeView(bar); undoView = null } }, 6000)
    }
    private fun card() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(18.dp, 16.dp, 18.dp, 16.dp)
        background = rounded(Palette.surface, 16)
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
        }, height = 48.dp)
    }
    private fun mono(value: String, size: Float, color: Int) = text(value, size, color).apply { typeface = Typeface.MONOSPACE; letterSpacing = 0.08f; maxLines = 1 }

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
        if (!onboarded) add(sectionRow(2), top = 4)
        // The portrait: what any site or app on this network can see of this phone, as a sphere of light. It is the
        // switch: a tap starts (or stops) hiding; hidden, a ring holds the time hidden and the rates. It takes whatever
        // height the rest of the page leaves (up to 280dp), so the whole page fits on one screen on any phone.
        portrait = Portrait(this).apply {
            isClickable = true; isFocusable = true
            setOnClickListener { if (!busy) toggleConnection() }
        }.also { add(it, height = 0, top = 8, bottom = 12).apply { (layoutParams as LinearLayout.LayoutParams).weight = 1f } }
        // The state: a title (or the cause of a failure) and two lines held for the detail (or the next step), the same
        // height in every state, so nothing below moves when a connection comes up, drops or fails.
        stateTitle = text("", 26f, Palette.text, 300).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END; setPadding(4.dp, 0, 4.dp, 0) }
        add(stateTitle!!)
        stateDetail = text("", 14f, Palette.secondary).apply { minLines = 2; maxLines = 2; ellipsize = TextUtils.TruncateAt.END; setPadding(4.dp, 0, 4.dp, 0) }
        add(stateDetail!!, top = 6)
        shownChecks = null
        checksCard = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(14.dp, 6.dp, 14.dp, 6.dp); background = rounded(Palette.surface, 14); visibility = View.GONE }
            .also { add(it, top = 14) }
        // First run: before the first tap, what the system is about to ask and which button to press.
        if (!onboarded && VpnService.prepare(this) != null) firstNote = note(L10n.text(R.string.first_connect_android), L10n.text(R.string.first_connect_android_detail))
            .also { dock?.addView(it, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8.dp }) }
        val actions = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        if (ValueAnimator.areAnimatorsEnabled()) actions.layoutTransition = LayoutTransition().apply { setDuration(200); enableTransitionType(LayoutTransition.CHANGING) }
        dock?.addView(actions, LinearLayout.LayoutParams(-1, 54.dp).apply { topMargin = 10.dp; bottomMargin = 12.dp })
        // One filled action: solid amber with dark text while exposed, a quiet dark fill with a breathing dot while
        // hidden; after a failure it is the way out of it (manage devices, use automatic…), with "try again" beside it.
        action = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; setPadding(18.dp, 0, 18.dp, 0); isClickable = true; isFocusable = true
            actionDot = View(this@MainActivity).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Palette.accent) }; visibility = View.GONE }
                .also { addView(it, LinearLayout.LayoutParams(6.dp, 6.dp).apply { marginEnd = 10.dp }) }
            actionLabel = text("", 16f, Palette.onAccent, 600).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }.also { addView(it, LinearLayout.LayoutParams(-2, -2)) }
            setOnClickListener { if (!busy) trouble(shownTrouble?.primaryDo) }
        }.also { actions.addView(it, LinearLayout.LayoutParams(0, -1, 1f)) }
        secondary = text("", 15f, Palette.text, 500).apply {
            gravity = Gravity.CENTER; setPadding(20.dp, 0, 20.dp, 0); maxLines = 1; visibility = View.GONE
            background = RippleDrawable(ColorStateList.valueOf(Palette.alpha(Palette.text, 22)), rounded(Palette.raised, 16), null)
            isClickable = true; setOnClickListener { if (!busy) trouble(shownTrouble?.secondaryDo) }
        }.also { actions.addView(it, LinearLayout.LayoutParams(-2, -1).apply { marginStart = 10.dp }) }
        // Connected, the location row opens the connection check; otherwise, or while the chosen location does not
        // answer, it opens the location list (picking one there reconnects to it).
        val node = row(64).apply { background = pressable(Palette.surface, 14); contentDescription = L10n.text(R.string.tap_to_change)
            setOnClickListener { if (busy) return@setOnClickListener; if (ConnectionStateStore.active && ConnectionStateStore.since > 0 && ConnectionStateStore.messageId != R.string.location_retrying) connectionCheck() else { page = "nodes"; render() } } }
        nodeBadge = badge(null).also { node.addView(it) }
        val names = titles(" ", " "); node.addView(names)
        nodeTitle = names.getChildAt(0) as TextView; nodeDetail = names.getChildAt(1) as TextView
        node.addView(chevron())
        add(node, top = 14)
        nodeRow = node
        usageStrip()
        sealedShown = null; shownState = null
        showState()
        if (visitorIp == null) loadVisitorIp()
        // Just signed in: no saved list yet, so load it for the location's name and code.
        if (NodeCache.nodes(this) == null) refreshNodes()
    }
    /** The public address the service sees, read once while not connected (afterwards it would be the location's). */
    private fun loadVisitorIp() {
        if (ConnectionStateStore.active) return
        Thread {
            // With the address, where it is (a city, coarsely) for the globe; the time zone places it when the address can't.
            val zone = java.net.URLEncoder.encode(java.util.TimeZone.getDefault().id, "UTF-8")
            val seen = try { api.get("/api/v1/visitor?zone=$zone") } catch (_: Exception) { null }
            val ip = seen?.let { if (it.isNull("ip")) "—" else it.optString("ip") }
            seen?.optJSONObject("place")?.let { VisitorPlace.save(this, it) }
            runOnUiThread { visitorIp = ip; if (!isDestroyed && stateDetail != null) { shownState = null; showState() } }
        }.start()
    }
    /** What this account has left (or used) and how long it runs: two quiet figures under the location. */
    private fun usageStrip() {
        val trafficTitle = text(L10n.text(R.string.last_30_days), 12f, Palette.secondary).apply { maxLines = 1 }
        val traffic = text("—", 15f, Palette.text, 500); val until = text("—", 15f, Palette.text, 500)
        val untilTitle = text(L10n.text(R.string.valid_until_label), 12f, Palette.secondary).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        trafficTitle.ellipsize = android.text.TextUtils.TruncateAt.END
        // A tap opens the usage page (per day, device and location).
        val strip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; setPadding(4.dp, 6.dp, 4.dp, 6.dp); background = pressable(Color.TRANSPARENT, 12)
            contentDescription = L10n.text(R.string.usage_open); setOnClickListener { if (!busy) { page = "usage"; render() } }
        }
        for ((title, value) in listOf(trafficTitle to traffic, untilTitle to until)) strip.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(title)
            addView(value.apply { maxLines = 1 }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 4.dp })
        }, LinearLayout.LayoutParams(0, -2, 1f))
        strip.gravity = Gravity.CENTER_VERTICAL; strip.addView(chevron())
        add(strip, top = 6)
        usageRow = strip
        fun show(data: JSONObject) {
            val access = AccountAccess.from(data)
            trafficTitle.text = L10n.text(access.trafficTitle()); untilTitle.text = L10n.text(access.untilTitle())
            trafficTitle.setTextColor(tint(access.state == "exhausted", access.low, Palette.secondary))
            untilTitle.setTextColor(tint(access.state == "expired", access.ending, Palette.secondary))
            traffic.text = if (access.metered) bytes(access.remainingBytes) else totalTraffic(data)?.let { bytes(it) } ?: "—"
            traffic.setTextColor(tint(access.state == "exhausted", access.low, Palette.text))
            until.text = L10n.date(data.optString("expiresAt"))
            until.setTextColor(tint(access.state == "expired", access.ending, Palette.text))
        }
        accountData?.let { show(it) }
        Thread {
            val data = try { api.request("account") } catch (_: Exception) { null } ?: return@Thread
            runOnUiThread { accountData = data; remind(data); if (!isDestroyed && traffic.isAttachedToWindow) show(data) }
        }.start()
    }
    // ---- Usage: what this account used, per day, per device and per location (the server's daily totals), and on
    // Windows per program (kept on that computer only). Opened from the home's usage strip.
    private var usageDays = 30
    private fun usagePage() {
        subPageTitle(L10n.text(R.string.usage_title)) { page = "connect"; render() }
        val quota = card().also { add(it) }
        fun fillQuota(data: JSONObject) {
            quota.removeAllViews()
            val access = AccountAccess.from(data)
            val used = if (access.metered) maxOf(0L, access.quotaBytes!! - access.remainingBytes) else totalTraffic(data) ?: 0L
            quota.addView(text(L10n.text(if (access.metered) R.string.usage_used_period else R.string.last_30_days), 12f, Palette.secondary).apply { maxLines = 1 })
            quota.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.BOTTOM
                val parts = bytes(used).split(' ', '\u00A0', limit = 2)
                addView(text(parts[0], 38f, tint(access.state == "exhausted", false, Palette.text)).apply { typeface = Pixel.font(this@MainActivity); maxLines = 1 })
                addView(text(parts.getOrElse(1) { "" }, 14f, Palette.secondary).apply { typeface = Typeface.MONOSPACE }, LinearLayout.LayoutParams(-2, -2).apply { marginStart = 6.dp; bottomMargin = 5.dp })
                addView(View(this@MainActivity), LinearLayout.LayoutParams(0, 1, 1f))
                addView(text(if (access.metered) L10n.text(R.string.usage_of, bytes(access.quotaBytes!!)) else L10n.text(R.string.usage_unlimited), 13f, Palette.secondary).apply { maxLines = 1 },
                    LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = 5.dp; marginStart = 8.dp })
            }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 6.dp })
            if (access.metered) {
                val share = used.toFloat() / maxOf(1L, access.quotaBytes!!)
                quota.addView(LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL; background = rounded(Palette.raised, 4); clipToOutline = true
                    addView(View(this@MainActivity).apply { background = rounded(tint(access.state == "exhausted", access.low, Palette.accent), 4) }, LinearLayout.LayoutParams(0, -1, share.coerceIn(0.01f, 1f)))
                    if (share < 1f) addView(View(this@MainActivity), LinearLayout.LayoutParams(0, -1, 1f - share.coerceIn(0.01f, 1f)))
                }, LinearLayout.LayoutParams(-1, 8.dp).apply { topMargin = 12.dp })
                quota.addView(text(L10n.text(R.string.usage_left, bytes(access.remainingBytes)), 12f, tint(access.state == "exhausted", access.low, Palette.secondary)).apply { maxLines = 1 },
                    LinearLayout.LayoutParams(-2, -2).apply { topMargin = 8.dp })
            }
            quota.addView(View(this).apply { setBackgroundColor(Palette.hairline) }, LinearLayout.LayoutParams(-1, 1).apply { topMargin = 14.dp; bottomMargin = 12.dp })
            val until = access.until
            val ended = access.state == "expired"
            quota.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                val left = when { ended -> L10n.text(R.string.access_expired_title); until == null -> L10n.text(R.string.no_expiry); else -> L10n.text(R.string.valid_until_label) + " " + L10n.date(until.toString()) }
                addView(text(left, 13f, tint(ended, access.ending, Palette.secondary)).apply { maxLines = 2 }, LinearLayout.LayoutParams(0, -2, 1f))
                if (until != null && !ended) {
                    val days = maxOf(0L, (until.toEpochMilli() - System.currentTimeMillis() + AccountAccess.DAY - 1) / AccountAccess.DAY)
                    addView(text(L10n.text(R.string.usage_days_left, L10n.number(days)), 13f, tint(false, access.ending, Palette.text), 500).apply { maxLines = 1 },
                        LinearLayout.LayoutParams(-2, -2).apply { marginStart = 12.dp })
                }
            })
        }
        accountData?.let { fillQuota(it) }
        // The range: 7, 30 or 90 days; changing it reloads the figures below, the page keeps its place.
        val ranges = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(2.dp, 2.dp, 2.dp, 2.dp); background = rounded(Palette.surface, 12) }
        add(ranges, height = 36.dp, top = 14)
        val chart = card().also { add(it, top = 12) }
        val dayLabel = text(" ", 12f, Palette.secondary).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        val rangeTotal = text(" ", 12f, Palette.secondary).apply { typeface = Typeface.MONOSPACE; maxLines = 1 }
        chart.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(dayLabel, LinearLayout.LayoutParams(0, -2, 1f)); addView(rangeTotal, LinearLayout.LayoutParams(-2, -2).apply { marginStart = 8.dp })
        })
        var shownDays: List<Pair<String, Long>> = emptyList()
        fun pick(index: Int) { shownDays.getOrNull(index)?.let { (day, value) -> dayLabel.swap(L10n.day(day) + " · " + bytes(value)) } }
        val bars = DayBars(this) { pick(it) }
        chart.addView(bars, LinearLayout.LayoutParams(-1, 88.dp).apply { topMargin = 12.dp })
        val firstDay = text(" ", 11f, Palette.faint).apply { maxLines = 1 }; val lastDay = text(" ", 11f, Palette.faint).apply { maxLines = 1 }
        chart.addView(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(firstDay, LinearLayout.LayoutParams(0, -2, 1f)); addView(lastDay)
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8.dp })
        val lists = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also { add(it, top = 12) }
        var loading = 0
        fun load() {
            val ask = ++loading; val days = usageDays
            ranges.removeAllViews()
            for ((value, title) in listOf(7 to R.string.usage_7_days, 30 to R.string.usage_30_days, 90 to R.string.usage_90_days)) {
                val selected = value == usageDays
                ranges.addView(text(L10n.text(title), 13f, if (selected) Palette.text else Palette.secondary, if (selected) 500 else 400).apply {
                    gravity = Gravity.CENTER; maxLines = 1
                    background = if (selected) rounded(Palette.selected, 10) else pressable(Color.TRANSPARENT, 10)
                    contentDescription = L10n.text(title) + if (selected) L10n.text(R.string.current_page) else ""
                    setOnClickListener { if (!selected) { usageDays = value; load() } }
                }, LinearLayout.LayoutParams(0, -1, 1f))
            }
            lists.alpha = 0.5f
            Thread {
                val data = try { api.request("usage?days=$days") } catch (_: Exception) { null }
                runOnUiThread {
                    if (isDestroyed || ask != loading || !lists.isAttachedToWindow) return@runOnUiThread
                    lists.animate().alpha(1f).setDuration(150).start()
                    lists.removeAllViews()
                    if (data == null) {
                        lists.addView(text(L10n.text(R.string.usage_load_failed), 13f, Palette.secondary), LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8.dp; marginStart = 4.dp })
                        return@runOnUiThread
                    }
                    // Every day of the range, with the days without traffic as empty bars.
                    val byDay = data.optJSONArray("daily")?.let { arr -> (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }.associate {
                        it.optString("day") to ((it.optString("upload").toLongOrNull() ?: 0L) + (it.optString("download").toLongOrNull() ?: 0L)) } } ?: emptyMap()
                    val today = java.time.LocalDate.now(java.time.ZoneOffset.UTC)
                    shownDays = (days - 1 downTo 0).map { ago -> today.minusDays(ago.toLong()).toString().let { it to (byDay[it] ?: 0L) } }
                    bars.set(shownDays.map { it.second }, shownDays.size - 1); pick(shownDays.size - 1)
                    rangeTotal.swap(bytes(shownDays.sumOf { it.second }))
                    firstDay.text = L10n.day(shownDays.first().first); lastDay.text = L10n.day(shownDays.last().first)
                    bars.contentDescription = L10n.text(usageRangeTitle(days)) + " · " + bytes(shownDays.sumOf { it.second })
                    fun rows(key: String, name: (JSONObject) -> String) = org.json.JSONArray().apply {
                        val arr = data.optJSONArray(key) ?: return@apply
                        for (i in 0 until arr.length()) arr.optJSONObject(i)?.let { put(JSONObject().put("name", name(it)).put("bytes", it.optString("bytes").toLongOrNull() ?: 0L).put("proxy", true)) }
                    }
                    lists.addView(rankList(L10n.text(R.string.usage_by_device), rows("devices") { d ->
                        d.optString("name").ifBlank { L10n.text(R.string.device) }.let { if (d.optBoolean("isCurrent")) L10n.text(R.string.usage_this_device, it) else it } }, mono = false, note = null),
                        LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 12.dp })
                    lists.addView(rankList(L10n.text(R.string.usage_by_location), rows("nodes") { n -> n.optString("name") }, mono = false, note = null))
                }
            }.start()
        }
        load()
        // The account (quota and end date) may be newer than the copy from the home page.
        Thread {
            val data = try { api.request("account") } catch (_: Exception) { null } ?: return@Thread
            runOnUiThread { accountData = data; if (!isDestroyed && quota.isAttachedToWindow) fillQuota(data) }
        }.start()
    }
    private fun usageRangeTitle(days: Int) = when (days) { 7 -> R.string.usage_7_days; 90 -> R.string.usage_90_days; else -> R.string.usage_30_days }
    /** Running out: amber; run out: red. */
    private fun tint(over: Boolean, low: Boolean, usual: Int) = when { over -> Palette.danger; low -> Palette.fair; else -> usual }
    /**
     * The once-per-step system notification. Android 13 asks for permission to notify: asked here, the first time
     * there is something to say, so the request comes with its reason on screen.
     */
    private fun remind(data: JSONObject) {
        val access = AccountAccess.from(data)
        if (!access.low && !access.ending) return
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            val prefs = getSharedPreferences("reminders", MODE_PRIVATE)
            if (!prefs.getBoolean("asked", false)) { prefs.edit().putBoolean("asked", true).apply(); requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 7) }
            return
        }
        AccessReminders.check(this, access)
    }
    private fun deviceLimit(data: JSONObject) = if (data.isNull("limit")) L10n.text(R.string.devices_unlimited) else L10n.number(data.optInt("limit"))
    private fun totalTraffic(data: JSONObject) = data.optJSONObject("traffic")?.let { (it.optString("uploadBytes", "0").toLongOrNull() ?: 0) + (it.optString("downloadBytes", "0").toLongOrNull() ?: 0) }
    private fun showState() {
        val active = ConnectionStateStore.active; val since = ConnectionStateStore.since
        val state = Guidance.state()
        val connected = state == LinkState.CONNECTED
        // Up but not plainly carrying traffic (switching lines, reconnecting, offline): the quieter "on" look still.
        val on = active && state != LinkState.CONNECTING
        val trouble = if (state == LinkState.FAILED) Guidance.trouble(selectedId.isEmpty()) else null
        space.lit = !active
        if (state != shownState || trouble != shownTrouble) {
            action?.apply {
                contentDescription = when (state) { LinkState.IDLE -> L10n.text(R.string.connect_action); LinkState.FAILED -> L10n.text(trouble!!.primary); LinkState.CONNECTING -> L10n.text(R.string.cancel); else -> L10n.text(R.string.disconnect_action) }
                background = RippleDrawable(ColorStateList.valueOf(Palette.alpha(if (on) Palette.text else Palette.onAccent, if (on) 22 else 40)), rounded(if (on) Palette.raised else Palette.accent, 16), null)
            }
            actionLabel?.apply {
                swap(when (state) { LinkState.IDLE -> L10n.text(R.string.seal_action); LinkState.CONNECTING -> L10n.text(R.string.cancel); LinkState.FAILED -> L10n.text(trouble!!.primary); else -> L10n.text(R.string.unseal_action) })
                setTextColor(if (on) Palette.text else Palette.onAccent)
            }
            actionDot?.apply {
                visibility = if (on) View.VISIBLE else View.GONE
                animate().cancel(); alpha = 1f
                if (active && ValueAnimator.areAnimatorsEnabled()) breathe(this)
            }
            secondary?.apply {
                val second = trouble?.secondary
                if (second != null) text = L10n.text(second)
                visibility = if (second != null) View.VISIBLE else View.GONE
            }
        }
        stateTitle?.apply {
            swap(when (state) {
                LinkState.CONNECTED -> L10n.text(R.string.sealed_status)
                LinkState.CONNECTING, LinkState.SWITCHING -> L10n.text(R.string.hiding_status)
                LinkState.RECONNECTING -> L10n.text(R.string.reconnecting_title)
                LinkState.WAITING -> L10n.text(R.string.waiting_title)
                LinkState.FAILED -> trouble!!.title
                else -> L10n.text(R.string.exposed_status)
            })
            setTextColor(when (state) { LinkState.FAILED -> Palette.fair; LinkState.CONNECTED -> Palette.accent; else -> Palette.text })
        }
        // The file seals as soon as a connection starts, and opens again when it ends; the first show on a page is still.
        val seal = active
        if (sealedShown != seal) {
            val moving = sealedShown != null && ValueAnimator.areAnimatorsEnabled()
            fileLines?.let { lines ->
                val n = lines.size
                lines.forEachIndexed { i, line -> line.seal(seal, if (moving) (1200L * ((if (seal) i else n - 1 - i) + 0.5f) / n).toLong() else 0L, moving) }
            }
            portrait?.set(seal, moving)
            portrait?.contentDescription = L10n.text(if (seal) R.string.disconnect_action else R.string.connect_action)
            stamp?.apply {
                animate().cancel()
                if (!moving) { alpha = if (seal) 1f else 0f; visibility = if (seal) View.VISIBLE else View.INVISIBLE; scaleX = 1f; scaleY = 1f }
                else if (seal) { visibility = View.VISIBLE; alpha = 0f; scaleX = 1.6f; scaleY = 1.6f; animate().alpha(1f).scaleX(1f).scaleY(1f).setStartDelay(1250).setDuration(260).setInterpolator(DecelerateInterpolator()).start() }
                else animate().alpha(0f).setStartDelay(0).setDuration(200).withEndAction { visibility = View.INVISIBLE }.start()
            }
            firstNote?.fade(!seal)
            sealedShown = seal
        }
        // The portrait draws the state (see Portrait); inside it the time hidden and the rates, the phase while
        // connecting, or the countdown to the next try while reconnecting.
        portrait?.apply {
            // The globe's two ends: this device (unless the person hid it) and the location it goes out from.
            val exitId = if (active) ConnectionStateStore.nodeId.ifEmpty { selectedId } else selectedId
            val exitName = if (active && ConnectionStateStore.node.isNotEmpty()) ConnectionStateStore.node else Directory.nodes[exitId]?.first ?: selectedName
            val here = if (VisitorPlace.shown(this@MainActivity)) VisitorPlace.spot(this@MainActivity) else null
            val there = Directory.places[exitId]?.let { Spot(it[0], it[1], exitName) }
            origin = here; exit = there
            distance = if (here != null && there != null) L10n.text(R.string.globe_km, L10n.number(maxOf(10, (Earth.km(here, there) / 10).roundToInt() * 10))) else ""
            this.state = state; lines = maxOf(ConnectionStateStore.lines, 2)
            centre = when (state) {
                LinkState.CONNECTED -> DateUtils.formatElapsedTime((SystemClock.elapsedRealtime() - since) / 1000)
                LinkState.CONNECTING -> Guidance.phase()
                LinkState.RECONNECTING -> DateUtils.formatElapsedTime(Guidance.countdown())
                LinkState.WAITING -> "—"
                else -> ""
            }
            sub = when (state) {
                // Rates change every second: set directly (fixed-width digits keep the line still).
                LinkState.CONNECTED -> L10n.text(R.string.connection_rates, mbps(ConnectionStateStore.rxRate), mbps(ConnectionStateStore.txRate))
                LinkState.RECONNECTING -> if (ConnectionStateStore.attempt > 0) L10n.text(R.string.attempt_n, L10n.number(ConnectionStateStore.attempt)) else ""
                LinkState.WAITING -> L10n.text(R.string.offline_centre)
                else -> ""
            }
        }
        if (connected) {
            rxHistory.addLast(ConnectionStateStore.rxRate); txHistory.addLast(ConnectionStateStore.txRate)
            while (rxHistory.size > RateBars.COUNT) { rxHistory.removeFirst(); txHistory.removeFirst() }
        } else { rxHistory.clear(); txHistory.clear() }
        rateBars?.apply { fade(connected); set(rxHistory.toList(), txHistory.toList()) }
        val from = ConnectionStateStore.switchedFrom
        val noteShown = connected && from.isNotEmpty() && from != dismissedSwitch && from != ConnectionStateStore.node
        switchText?.text = if (noteShown) L10n.text(R.string.switched_location, from, ConnectionStateStore.node) else ""
        switchNote?.visibility = if (noteShown) View.VISIBLE else View.GONE
        stateDetail?.swap(when (state) {
            LinkState.CONNECTED -> L10n.text(R.string.seen_as, ConnectionStateStore.node) + Guidance.bypass().let { if (it.isEmpty()) "" else "\n" + it }
            LinkState.CONNECTING -> L10n.text(R.string.finding_best_route)
            LinkState.SWITCHING -> L10n.text(R.string.switching_detail)
            LinkState.RECONNECTING -> if (ConnectionStateStore.messageId == R.string.location_retrying) ConnectionStateStore.message else L10n.text(R.string.reconnecting_detail)
            LinkState.WAITING -> L10n.text(R.string.waiting_detail)
            LinkState.FAILED -> trouble!!.detail
            else -> if (update?.mandatory == true) L10n.text(R.string.update_required_detail)
                else visitorIp?.takeIf { it != "—" }?.let { L10n.text(R.string.exposed_ip, it) } ?: L10n.text(R.string.exposed_plain)
        })
        // The first connection ends the two steps: the squares fill and say "ready", then the tab bar comes.
        if (connected && !onboarded) {
            onboarded = true; getSharedPreferences("preferences", MODE_PRIVATE).edit().putBoolean("onboarded", true).apply()
            stepsRow?.let { fillSteps(it, STEPS + 1) }
            handler.postDelayed({ if (!isDestroyed && page == "connect") render() }, 3000)
        }
        showChecks(if (state == LinkState.FAILED) Guidance.checks() else null)
        shownState = state; shownTrouble = trouble
        showCurrentNode()
    }
    /** The four-step check under a network failure; while it shows, the location row and the usage step aside so the page still fits. */
    private fun showChecks(checks: List<Check>?) {
        val card = checksCard ?: return
        if (checks == shownChecks) return
        shownChecks = checks
        card.removeAllViews()
        card.visibility = if (checks == null) View.GONE else View.VISIBLE
        nodeRow?.visibility = if (checks == null) View.VISIBLE else View.GONE
        usageRow?.visibility = if (checks == null) View.VISIBLE else View.GONE
        checks?.forEach { c ->
            card.addView(row(30).apply {
                setPadding(0, 0, 0, 0)
                addView(View(this@MainActivity).apply { setBackgroundColor(when (c.status) { Check.OK -> Palette.secondary; Check.BAD -> Palette.fair; else -> Palette.selected }) },
                    LinearLayout.LayoutParams(7.dp, 7.dp).apply { marginEnd = 10.dp })
                addView(text(L10n.text(c.label), 13f, Palette.secondary).apply { maxLines = 1 })
                addView(text(c.value, 13f, when (c.status) { Check.BAD -> Palette.fair; Check.SKIP -> Palette.faint; else -> Palette.text }).apply {
                    maxLines = 1; ellipsize = TextUtils.TruncateAt.END; gravity = Gravity.END
                }, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = 12.dp })
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
                contentDescription = L10n.text(c.label) + ": " + c.value
            }, LinearLayout.LayoutParams(-1, 30.dp))
        }
    }
    /** Sends the check and the attempt's id; the toast gives the reference the admin finds in 运行日志. */
    private fun sendCheck() {
        val request = ConnectionStateStore.request; val node = ConnectionStateStore.nodeId; val summary = Guidance.summary()
        Thread { api.attempt = request.ifEmpty { null }; api.report("CONNECT_CHECK", node, summary) }.start()
        Toast.makeText(this, L10n.text(R.string.check_sent, request.take(6).uppercase().ifEmpty { "—" }), Toast.LENGTH_LONG).show()
    }
    /** What a failure's button does: try again, or go where the cause is fixed. */
    private fun trouble(what: String?) {
        when (what) {
            null -> toggleConnection()
            "retry" -> toggleConnection()
            "devices" -> { page = "devices"; render() }
            "nodes" -> { page = "nodes"; render() }
            "account" -> { page = "account"; render() }
            "automatic" -> { select("", "", ""); toggleConnection() }
            "settings" -> try { startActivity(Intent(android.provider.Settings.ACTION_VPN_SETTINGS)) } catch (_: Exception) { }
            "wifi" -> try { startActivity(Intent(android.provider.Settings.ACTION_WIFI_SETTINGS)) } catch (_: Exception) { }
            "send" -> sendCheck()
            "update" -> update?.let { installUpdate(it) } ?: checkForUpdate(announce = true)
            "signin" -> {
                // The chosen location stays; only the session goes.
                ConnectionStateStore.errorCode = ""; ConnectionStateStore.messageId = R.string.not_connected
                api.saveSecret("token", null); page = "connect"; render()
            }
        }
    }
    /** During the first run, the step on the right (two squares and "n/2"); afterwards nothing. */
    private fun sectionRow(step: Int?): View {
        if (step == null) return View(this)
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL or Gravity.END
            stepsRow = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(8.dp, 0, 4.dp, 0) }
                .also { fillSteps(it, step); addView(it, LinearLayout.LayoutParams(-2, -2)) }
        }
    }
    /** Steps 1–2 done, current or to come; 3 is "ready" after the first connection. */
    private fun fillSteps(row: LinearLayout, step: Int) {
        row.removeAllViews()
        for (i in 1..STEPS) row.addView(View(this).apply {
            background = GradientDrawable().apply {
                when {
                    i < step -> setColor(Palette.alpha(Palette.text, 190))
                    i == step -> setColor(Palette.accent)
                    else -> setColor(Palette.selected)
                }
            }
        }, LinearLayout.LayoutParams(6.dp, 6.dp).apply { marginEnd = 3.dp })
        val ready = step > STEPS
        row.addView(mono(if (ready) L10n.text(R.string.onboarding_ready) else L10n.number(step) + "/" + L10n.number(STEPS), 11f, if (ready) Palette.accent else Palette.secondary),
            LinearLayout.LayoutParams(-2, -2).apply { marginStart = 5.dp })
        row.contentDescription = if (ready) L10n.text(R.string.onboarding_ready) else "$step/$STEPS"
    }
    /** A quiet amber-tinted note: what is about to happen, then what to do. */
    private fun note(title: String, detail: String) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; setPadding(12.dp, 11.dp, 12.dp, 11.dp)
        background = rounded(Palette.alpha(Palette.accent, 22), 14)
        addView(mono("i", 11f, Palette.onAccent).apply { gravity = Gravity.CENTER; letterSpacing = 0f; background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Palette.accent) } },
            LinearLayout.LayoutParams(18.dp, 18.dp).apply { marginEnd = 12.dp; topMargin = 1.dp })
        addView(LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL
            addView(text(title, 13f))
            addView(text(detail, 12f, Palette.secondary), LinearLayout.LayoutParams(-2, -2).apply { topMargin = 2.dp })
        }, LinearLayout.LayoutParams(0, -2, 1f))
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
        Haptics.press(window.decorView)
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
        add(sectionRow(if (onboarded) null else 1), bottom = 12)
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
            work({ if (origin != null) api.origin = origin; api.login(address, secret) }) {
                // A failure from before sign-in (an expired session) is over now.
                if (!ConnectionStateStore.active) { ConnectionStateStore.errorCode = ""; ConnectionStateStore.messageId = R.string.not_connected }
                password.setText(""); page = "connect"; render(); handler.postDelayed(updateCheck, 1500)
            }
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
        pageTitle(L10n.text(R.string.locations), retest)
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
                    Haptics.tick(it); prefs.edit().putString("routing", value).apply(); render()
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
        // Advanced: favorite locations in their own group above the rest; press and hold a row for its options.
        val advanced = Advanced.enabled(this)
        val favorites = Advanced.favorites(this)
        val favoriteRows = mutableListOf<View>()
        for ((node, quality) in ranked) {
            val name = node.getString("name"); val region = node.optString("region").takeIf { it.isNotBlank() && it != "null" && it != name } ?: ""
            if (!("$name $region").contains(query, ignoreCase = true)) continue
            val id = node.getString("id"); val code = Directory.code(id, name)
            val unreachable = quality != null && quality.latency == null
            val states = lineStates(quality)
            val locked = Advanced.lock(this, id)
            val note = listOfNotNull(linesNote(quality) ?: region.ifEmpty { null }, locked.ifEmpty { null }?.let { L10n.text(R.string.protocol_only, protocolName(it)) }).joinToString(" · ").ifEmpty { null }
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
                if (advanced) setOnLongClickListener { if (!busy) nodeOptions(id, name) { show(list, ranked, query) }; true }
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
            if (id in favorites) favoriteRows.add(item) else rows.add(item)
        }
        fun header(title: Int) = list.addView(text(L10n.text(title), 13f, Palette.secondary).apply { setPadding(4.dp, 0, 0, 0) }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 20.dp; bottomMargin = 8.dp })
        if (favoriteRows.isNotEmpty()) { header(R.string.favorites); list.addView(group(favoriteRows, inset = 66)) }
        if (rows.isNotEmpty() || favoriteRows.isEmpty()) header(R.string.all_locations)
        when {
            rows.isNotEmpty() -> list.addView(group(rows, inset = 66))
            favoriteRows.isNotEmpty() -> {}
            ranked.isEmpty() -> list.addView(text(L10n.text(R.string.no_locations_available_refresh_later_or_contact_your_administrator), 14f, Palette.secondary).apply { setPadding(4.dp, 4.dp, 4.dp, 4.dp) })
            else -> list.addView(text(L10n.text(R.string.no_matching_locations_try_another_search), 14f, Palette.secondary).apply { setPadding(4.dp, 4.dp, 4.dp, 4.dp) })
        }
        if (advanced && ranked.isNotEmpty()) list.addView(text(L10n.text(R.string.node_hold_hint), 12f, Palette.faint).apply { setPadding(4.dp, 0, 4.dp, 0) }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 12.dp })
    }
    /** A protocol's name as the advanced views show it. */
    private fun protocolName(transport: String) = if (transport == "reality-alt") L10n.text(R.string.reality_alt) else Transports.label(transport)
    /** Advanced: a location's options, favorite and protocol lock; a changed lock reconnects that location at once. */
    private fun nodeOptions(id: String, name: String, redraw: () -> Unit) {
        val favorite = id in Advanced.favorites(this)
        val locked = Advanced.lock(this, id)
        val protocolValue = if (locked.isEmpty()) L10n.text(R.string.automatic) else protocolName(locked)
        sheet(name, listOf(L10n.text(if (favorite) R.string.favorite_remove else R.string.favorite_add), L10n.text(R.string.protocol) + " · " + protocolValue), -1) { i ->
            if (i == 0) { Advanced.favorite(this, id, !favorite); redraw(); return@sheet }
            val options = listOf("") + Advanced.protocols
            sheet(L10n.text(R.string.protocol), options.map { if (it.isEmpty()) L10n.text(R.string.automatic) else protocolName(it) }, options.indexOf(locked), L10n.text(R.string.protocol_lock_detail)) { pick ->
                if (options[pick] == locked) return@sheet
                Advanced.setLock(this, id, options[pick]); redraw()
                if (ConnectionStateStore.active && ConnectionStateStore.nodeId == id) reconnect()
            }
        }
    }
    private fun select(id: String, name: String, code: String) {
        val moving = ConnectionStateStore.active && id != ConnectionStateStore.nodeId
        Haptics.tick(window.decorView)
        selectedId = id; selectedName = name; selectedCode = code; page = "connect"
        getSharedPreferences("preferences", MODE_PRIVATE).edit().putString("nodeId", id).putString("nodeName", name).putString("nodeCode", code).apply()
        render()
        // Connected (or reconnecting): one tap moves the VPN to the new location.
        if (moving) reconnect()
    }
    /** Ends the connection and starts a fresh one a moment after the old service is gone. */
    private fun reconnect() {
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
            add(group(listOf(
                settingRow(L10n.text(R.string.authorized_devices), "${L10n.number(data.optInt("used"))} / ${deviceLimit(data)}") { page = "devices"; render() },
                settingRow(L10n.text(R.string.qr_scan_computer), "") { scanComputer() },
                settingRow(L10n.text(R.string.change_password), "") { resetPassword(email, L10n.text(R.string.reset_change_detail, email), L10n.text(R.string.reset_link_sent_to, email)) },
                settingRow(L10n.text(R.string.language), currentLanguage().second) { chooseLanguage() },
                settingRow(L10n.text(R.string.appearance), L10n.text(if (Palette.theme == "moon") R.string.theme_moon else R.string.theme_amber)) { chooseAppearance() },
                // The globe on the home page marks this device's city; someone sharing screenshots can leave it out.
                settingRow(L10n.text(R.string.globe_show_me), L10n.text(if (VisitorPlace.shown(this)) R.string.setting_on else R.string.setting_off)) {
                    val shown = VisitorPlace.shown(this)
                    sheet(L10n.text(R.string.globe_show_me), listOf(L10n.text(R.string.setting_off), L10n.text(R.string.setting_on)), if (shown) 1 else 0, L10n.text(R.string.globe_show_me_detail)) { i ->
                        if ((i == 1) != shown) { VisitorPlace.show(this, i == 1); render() }
                    }
                },
                // Android's own kill switch: Always-on VPN with "Block connections without VPN" in system settings.
                settingRow(L10n.text(R.string.kill_switch), "") {
                    AlertDialog.Builder(this@MainActivity).setTitle(L10n.text(R.string.kill_switch)).setMessage(L10n.text(R.string.kill_switch_android_detail))
                        .setPositiveButton(L10n.text(R.string.open_vpn_settings)) { _, _ -> try { startActivity(Intent(android.provider.Settings.ACTION_VPN_SETTINGS)) } catch (_: Exception) { } }
                        .setNegativeButton(L10n.text(R.string.cancel), null).show()
                },
                settingRow(L10n.text(R.string.per_app_routing), appsValue()) { page = "apps"; render() },
                settingRow(L10n.text(R.string.rules_title), rulesValue()) { page = "rules"; render() },
            ) + listOf(
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
    // ---- Per-app routing (AppRouting): three modes and, for the two that name apps, the list of launcher apps.
    /** Loaded once per run, off the UI thread (the package manager is slow with many apps). */
    private var launchable: List<AppRouting.App>? = null
    private fun appsValue(): String {
        val mode = AppRouting.mode(this); val count = AppRouting.apps(this).size
        return when {
            mode == AppRouting.ALL || count == 0 -> L10n.text(R.string.apps_all_value)
            mode == AppRouting.ONLY -> L10n.text(R.string.apps_only_value, L10n.number(count))
            else -> L10n.text(R.string.apps_except_value, L10n.number(count))
        }
    }
    private fun radio(on: Boolean) = FrameLayout(this).apply {
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(if (on) Palette.accent else Palette.selected) }
        if (on) addView(View(this@MainActivity).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Palette.onAccent) } }, FrameLayout.LayoutParams(7.dp, 7.dp, Gravity.CENTER))
    }
    private fun checkbox(box: FrameLayout, on: Boolean) {
        box.removeAllViews()
        box.background = rounded(if (on) Palette.accent else Palette.selected, 5)
        if (on) box.addView(icon(R.drawable.ic_check, Palette.onAccent, 14), FrameLayout.LayoutParams(14.dp, 14.dp, Gravity.CENTER))
    }
    private fun rulesValue(): String {
        val count = Advanced.rules(this).size
        return if (count == 0) L10n.text(R.string.rules_none) else L10n.text(R.string.rules_count, L10n.number(count))
    }
    /** Advanced: the person's own routing rules, one per line, ahead of smart routing; kept on this device. */
    private fun rulesPage() {
        subPageTitle(L10n.text(R.string.rules_title)) { page = "account"; render() }
        add(text(L10n.text(R.string.rules_help), 13f, Palette.secondary).apply { setPadding(4.dp, 0, 4.dp, 0) }, top = 4)
        val status = text("", 12f, Palette.secondary).apply { setPadding(4.dp, 0, 4.dp, 0) }
        fun recount(value: String) {
            val states = value.lines().map { Advanced.ruleState(it.trim()) }
            status.text = L10n.text(R.string.rules_status, L10n.number(states.count { it == 1 }), L10n.number(states.count { it == -1 }))
        }
        val editor = EditText(this).apply {
            setText(Advanced.rulesText(this@MainActivity)); hint = "example.com, direct\n+.ads.example, block\n10.8.0.0/16, proxy"
            typeface = Typeface.MONOSPACE; textSize = 13f; setTextColor(Palette.text); setHintTextColor(Palette.faint); textCursorDrawableTint()
            gravity = Gravity.TOP or Gravity.START; minLines = 8; isSingleLine = false; setHorizontallyScrolling(false)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            background = rounded(Palette.surface, 12); setPadding(14.dp, 12.dp, 14.dp, 12.dp)
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { recount(s.toString()) }
                override fun afterTextChanged(s: Editable?) {}
            })
        }
        add(editor, top = 16)
        recount(editor.text.toString())
        add(status, top = 8)
        add(primaryButton(L10n.text(R.string.rules_save)) {
            val before = Advanced.rules(this)
            Advanced.saveRules(this, editor.text.toString())
            val changed = before != Advanced.rules(this)
            val live = changed && ConnectionStateStore.active && ConnectionStateStore.since > 0
            Toast.makeText(this, L10n.text(if (live) R.string.rules_saved_live else R.string.rules_saved), Toast.LENGTH_SHORT).show()
            if (live) applyRules(null, false) { applied ->
                if (!applied) { Toast.makeText(this, L10n.text(R.string.rules_saved_reconnect), Toast.LENGTH_SHORT).show(); reconnect() }
            }
            page = "account"; render()
        }, height = 52.dp, top = 16)
    }
    private fun appsPage() {
        subPageTitle(L10n.text(R.string.per_app_routing)) { page = "account"; render() }
        val mode = AppRouting.mode(this)
        val modes = listOf(
            Triple(AppRouting.ALL, R.string.apps_mode_all, R.string.apps_mode_all_detail),
            Triple(AppRouting.ONLY, R.string.apps_mode_only, R.string.apps_mode_only_detail),
            Triple(AppRouting.EXCEPT, R.string.apps_mode_except, R.string.apps_mode_except_detail))
        add(group(modes.map { (value, title, detail) ->
            val on = value == mode
            LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; minimumHeight = 62.dp; setPadding(16.dp, 14.dp, 16.dp, 14.dp)
                addView(radio(on), LinearLayout.LayoutParams(18.dp, 18.dp).apply { marginEnd = 14.dp; topMargin = 2.dp })
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(text(L10n.text(title), 15f, Palette.text, if (on) 600 else 400))
                    addView(text(L10n.text(detail), 12.5f, Palette.secondary), LinearLayout.LayoutParams(-2, -2).apply { topMargin = 4.dp })
                }, LinearLayout.LayoutParams(0, -2, 1f))
                contentDescription = L10n.text(title) + ", " + L10n.text(detail) + if (on) L10n.text(R.string.current_page) else ""
                setOnClickListener { if (!on) { AppRouting.setMode(this@MainActivity, value); render() } }
            }
        }))
        val note = L10n.text(R.string.apps_apply_next) + if (mode != AppRouting.ALL) " " + L10n.text(R.string.apps_lockdown_note) else ""
        add(text(note, 12f, Palette.secondary).apply { setPadding(4.dp, 0, 4.dp, 0) }, top = 8)
        if (mode == AppRouting.ALL) return

        val selected = AppRouting.apps(this).toMutableSet()
        val count = text("", 12f, Palette.accent).apply { gravity = Gravity.END; if (L10n.locale.language != "zh") { typeface = Typeface.MONOSPACE; letterSpacing = 0.08f } }
        fun showCount() { count.text = L10n.text(R.string.apps_selected, L10n.number(selected.size)) }
        showCount()
        add(count, top = 20, bottom = 8).setPadding(4.dp, 0, 4.dp, 0)
        var query = ""
        var redraw: () -> Unit = {}
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        add(LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; background = rounded(Palette.surface, 12); setPadding(14.dp, 0, 4.dp, 0)
            addView(icon(R.drawable.ic_search, Palette.secondary, 16))
            addView(field(L10n.text(R.string.search_apps), kind = InputType.TYPE_TEXT_VARIATION_NORMAL).apply {
                background = null; setPadding(10.dp, 0, 10.dp, 0)
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { query = s.toString().trim(); redraw() }
                    override fun afterTextChanged(s: Editable?) {}
                })
            }, LinearLayout.LayoutParams(0, -1, 1f))
        }, height = 44.dp, bottom = 10)
        add(list)
        fun show(apps: List<AppRouting.App>) {
            // Selected apps first, in the order this page opened with: ticking a box never moves a row.
            val opened = AppRouting.apps(this)
            val ordered = apps.filter { it.packageName in opened } + apps.filter { it.packageName !in opened }
            val draw = {
                list.removeAllViews()
                val shown = ordered.filter { query.isEmpty() || it.label.contains(query, true) || it.packageName.contains(query, true) }
                if (shown.isNotEmpty()) list.addView(group(shown.map { app ->
                    val box = FrameLayout(this)
                    row(58).apply {
                        addView(ImageView(this@MainActivity).apply { setImageDrawable(app.icon); scaleType = ImageView.ScaleType.FIT_CENTER }, LinearLayout.LayoutParams(34.dp, 34.dp).apply { marginEnd = 14.dp })
                        addView(LinearLayout(this@MainActivity).apply {
                            orientation = LinearLayout.VERTICAL
                            addView(text(app.label, 15f).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END })
                            addView(text(app.packageName, 11f, Palette.faint).apply { typeface = Typeface.MONOSPACE; maxLines = 1; ellipsize = TextUtils.TruncateAt.END }, LinearLayout.LayoutParams(-2, -2).apply { topMargin = 2.dp })
                        }, LinearLayout.LayoutParams(0, -2, 1f))
                        checkbox(box, app.packageName in selected)
                        addView(box, LinearLayout.LayoutParams(20.dp, 20.dp).apply { marginStart = 12.dp })
                        // Announced as a checkbox with its state, like the system's own app lists.
                        contentDescription = app.label; isSelected = app.packageName in selected
                        accessibilityDelegate = object : View.AccessibilityDelegate() {
                            override fun onInitializeAccessibilityNodeInfo(host: View, info: android.view.accessibility.AccessibilityNodeInfo) {
                                super.onInitializeAccessibilityNodeInfo(host, info)
                                info.className = android.widget.CheckBox::class.java.name; info.isCheckable = true; info.isChecked = app.packageName in selected
                            }
                        }
                        setOnClickListener {
                            if (!selected.remove(app.packageName)) selected.add(app.packageName)
                            AppRouting.setApps(this@MainActivity, selected); checkbox(box, app.packageName in selected); showCount(); isSelected = app.packageName in selected
                        }
                    }
                }, inset = 64), LinearLayout.LayoutParams(-1, -2))
            }
            redraw = draw; draw()
        }
        launchable?.let { show(it); return }
        progress?.visibility = View.VISIBLE
        Thread {
            val apps = try { AppRouting.launchable(applicationContext) } catch (_: Exception) { emptyList() }
            runOnUiThread {
                launchable = apps
                if (!busy) progress?.visibility = View.INVISIBLE
                if (!isDestroyed && page == "apps" && list.isAttachedToWindow) show(apps)
            }
        }.start()
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
    private fun sheet(title: String, options: List<String>, checked: Int, note: String? = null, onPick: (Int) -> Unit) {
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
        if (note != null) box.addView(text(note, 13f, Palette.secondary).apply { setPadding(4.dp, 0, 4.dp, 0) }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 12.dp })
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
        // Advanced: each line by its protocol's name instead of its number.
        val advanced = Advanced.enabled(this)
        fun lineTitle(index: Int) = if (advanced) protocolName(Latency.lineOrder[index]) else lineName(index)
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
        // This node's lines (Line 1…4), each with its delay; the one carrying traffic is tinted and named on the label
        // row ("in use" inside every cell took the room the names need).
        val linesUsed = text("", 12f, Palette.accent).apply { maxLines = 1 }
        val linesLabel = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; visibility = View.GONE
            addView(text(L10n.text(R.string.check_lines), 12f, Palette.secondary).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(linesUsed, LinearLayout.LayoutParams(-2, -2).apply { marginStart = 8.dp })
        }
        box.addView(linesLabel, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 14.dp })
        class LineBox(val view: View, val name: TextView, val value: TextView, val cell: LineCells)
        val lineGrid = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        val lineBoxes = Latency.lineOrder.indices.map { i ->
            val cell = LineCells(this).apply { states = listOf(LineCells.WAIT) }
            val value = text("—", 12f, Palette.faint).apply { typeface = Typeface.MONOSPACE; maxLines = 1 }
            val name = text(lineTitle(i), 13f).apply { maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
            val view = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(10.dp, 0, 10.dp, 0)
                background = rounded(Palette.surface, 8)
                addView(cell, LinearLayout.LayoutParams(6.dp, 6.dp).apply { marginEnd = 8.dp })
                addView(name, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = 6.dp })
                addView(value)
            }
            if (i % 2 == 0) lineGrid.addView(LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }, LinearLayout.LayoutParams(-1, 34.dp).apply { if (i > 0) topMargin = 6.dp })
            (lineGrid.getChildAt(lineGrid.childCount - 1) as LinearLayout).addView(view, LinearLayout.LayoutParams(0, -1, 1f).apply { if (i % 2 == 1) marginStart = 6.dp })
            LineBox(view, name, value, cell)
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
                // Short and never cut: the delay, or a dash (grey: not offered, red: no answer, explained below).
                b.value.text = if (ms != null && ms >= 0) L10n.text(R.string.latency_ms, L10n.number(ms)) else "—"
                b.value.setTextColor(when { ms == null -> Palette.faint; ms < 0 -> Palette.danger; else -> Palette.text })
                val inUse = name == current
                b.view.background = rounded(if (inUse) Palette.alpha(Palette.accent, 36) else Palette.surface, 8)
                b.name.setTypeface(null, if (inUse) Typeface.BOLD else Typeface.NORMAL)
                val spoken = when { ms == null -> L10n.text(R.string.line_off); ms < 0 -> L10n.text(R.string.line_down); else -> L10n.text(R.string.latency_ms, L10n.number(ms)) }
                b.view.contentDescription = listOfNotNull(lineTitle(i), spoken, if (inUse) L10n.text(R.string.line_in_use) else null).joinToString(", ")
            }
            val usedIndex = Latency.lineOrder.indexOf(current)
            linesUsed.text = if (usedIndex >= 0) L10n.text(R.string.line_in_use) + " · " + lineTitle(usedIndex) else ""
            val down = Latency.lineOrder.withIndex().filter { (lines[it.value] ?: 0) < 0 }
            val used = Latency.lineOrder.indexOf(current).takeIf { it >= 0 && (lines[current] ?: -1) >= 0 }
            val note = if (down.isNotEmpty() && used != null) L10n.text(R.string.check_lines_note, down.joinToString(if (L10n.locale.language == "zh") "、" else ", ") { lineTitle(it.index) }, lineTitle(used)) else ""
            val hop = if (advanced && current == "hysteria2") L10n.text(R.string.hop_note) else ""
            val shown = listOf(note, hop).filter { it.isNotEmpty() }.joinToString("\n")
            lineNote.text = shown; lineNote.visibility = if (shown.isEmpty()) View.GONE else View.VISIBLE
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
        val speedNote = text(L10n.text(R.string.speed_hint), 13f, Palette.secondary).apply { maxLines = 2; minHeight = sp(13f) + 6.dp }
        speedCard.addView(speedNote, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 12.dp })
        box.addView(speedCard, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 18.dp })
        val speedButton = text(L10n.text(R.string.speed_start), 15f, Palette.onAccent, 600).apply { gravity = Gravity.CENTER; background = pressable(Palette.accent, 12) }
        box.addView(speedButton, LinearLayout.LayoutParams(-1, 48.dp).apply { topMargin = 18.dp })
        var speedLine = ""
        fun lineLabel(name: String) = Latency.lineOrder.indexOf(name).takeIf { it >= 0 }?.let { lineTitle(it) }
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
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); intent.data?.let { qrFromLink(it) }
        if (intent.action == "android.service.quicksettings.action.QS_TILE_PREFERENCES" && api.secret("token") != null && !busy) { page = "nodes"; render() }
    }

    // ---- Signing in a computer with this phone ("扫码登录电脑", server/qr-login.ts): scan, see which computer and from
    // where, confirm. The computer gets its own session; it takes a device slot when it connects.
    private fun scanComputer() {
        com.google.zxing.integration.android.IntentIntegrator(this).setDesiredBarcodeFormats(com.google.zxing.integration.android.IntentIntegrator.QR_CODE)
            .setPrompt(L10n.text(R.string.qr_scan_prompt)).setBeepEnabled(false).setOrientationLocked(false).initiateScan()
    }
    /** Opened from the system camera (tracknothing://qr-login?c=…) or read by the scanner. */
    private fun qrFromLink(link: android.net.Uri) {
        if (link.scheme != "tracknothing" || link.host != "qr-login") return
        val code = link.getQueryParameter("c").orEmpty()
        if (api.secret("token") == null) { alert(L10n.text(R.string.qr_sign_in_first)); return }
        if (!Regex("^[A-Za-z0-9_-]{32,64}$").matches(code)) { alert(L10n.text(R.string.qr_invalid)); return }
        executor.execute {
            val result = try { api.request("qr-login/scan", JSONObject().put("code", code)) } catch (e: Exception) { runOnUiThread { qrFailed(e) }; return@execute }
            runOnUiThread { if (!isDestroyed) confirmComputer(code, result) }
        }
    }
    private fun qrFailed(e: Exception) {
        if (isDestroyed) return
        when ((e as? ApiFailure)?.code) {
            "QR_EXPIRED" -> alert(L10n.text(R.string.qr_expired))
            "QR_INVALID" -> alert(L10n.text(R.string.qr_invalid))
            else -> alert(friendly(e))
        }
    }
    private fun confirmComputer(code: String, info: JSONObject) {
        val name = info.optString("deviceName").ifBlank { info.optString("platform") }
        val country = info.optString("country").takeIf { it.length == 2 }?.let { java.util.Locale("", it).getDisplayCountry(L10n.locale) } ?: L10n.text(R.string.qr_unknown_place)
        val slot = when {
            info.optString("kind") == "portal" -> L10n.text(R.string.qr_confirm_web)
            !info.optBoolean("newDevice") -> L10n.text(R.string.qr_confirm_known)
            else -> L10n.text(R.string.qr_confirm_slot, L10n.number(info.optInt("used")), if (info.isNull("limit")) L10n.text(R.string.devices_unlimited) else L10n.number(info.optInt("limit")))
        }
        fun answer(approve: Boolean) = executor.execute {
            try {
                api.request("qr-login/approve", JSONObject().put("code", code).put("approve", approve))
                if (approve) runOnUiThread { if (!isDestroyed) android.widget.Toast.makeText(this, L10n.text(R.string.qr_signed_in), android.widget.Toast.LENGTH_SHORT).show() }
            } catch (e: Exception) { runOnUiThread { qrFailed(e) } }
        }
        AlertDialog.Builder(this).setTitle(L10n.text(R.string.qr_confirm_title)).setMessage(L10n.text(R.string.qr_confirm_place, name, country) + "\n\n" + slot)
            .setPositiveButton(L10n.text(R.string.qr_confirm_action)) { _, _ -> answer(true) }
            .setNegativeButton(L10n.text(R.string.cancel)) { _, _ -> answer(false) }
            .setOnCancelListener { answer(false) }.show()
    }

    @Deprecated("Activity result compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == com.google.zxing.integration.android.IntentIntegrator.REQUEST_CODE) {
            val text = com.google.zxing.integration.android.IntentIntegrator.parseActivityResult(requestCode, resultCode, data)?.contents ?: return
            val link = try { android.net.Uri.parse(text) } catch (_: Exception) { null }
            if (link?.scheme == "tracknothing" && link.host == "qr-login") qrFromLink(link) else alert(L10n.text(R.string.qr_invalid))
            return
        }
        // Refused or dismissed the system's VPN prompt: the connect page says so, with "try again" and the VPN settings.
        if (requestCode == 10) {
            if (resultCode == RESULT_OK) startConnection()
            else { ConnectionStateStore.failed("VPN_PERMISSION_REQUIRED", R.string.allow_the_system_vpn_permission_to_connect); showState() }
        }
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
    /** Where each location is (latitude, longitude), for the globe. */
    val places = ConcurrentHashMap<String, DoubleArray>()
    fun remember(list: org.json.JSONArray) {
        for (i in 0 until list.length()) list.optJSONObject(i)?.let { node ->
            val id = node.getString("id")
            nodes[id] = node.getString("name") to node.optString("countryCode").takeIf { it.length == 2 }?.uppercase()
            Latency.probes(node).takeIf { it.isNotEmpty() }?.let { list -> probes[id] = list.joinToString(",") { (host, port) -> (if (host.contains(':')) "[$host]" else host) + ":" + port } }
            node.optString("region").takeIf { it.isNotBlank() && it != "null" }?.let { regions[id] = it }
            node.optJSONArray("test")?.takeIf { it.length() > 0 }?.let { tests[id] = it }
            node.optJSONObject("place")?.let { p -> if (p.has("lat") && p.has("lon")) places[id] = doubleArrayOf(p.optDouble("lat"), p.optDouble("lon")) }
        }
    }
    /** The country code, or the name's first letter when the location has no region. */
    fun code(id: String, name: String): String = nodes[id]?.second ?: name.trim().take(1).uppercase()
}

/**
 * Where this device is, coarsely (a city), as the service saw it the last time the app asked while not connected:
 * kept on the device only, for the globe on the home page. The person can leave it off the globe (我的).
 */
object VisitorPlace {
    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences("preferences", Context.MODE_PRIVATE)
    fun save(context: Context, place: org.json.JSONObject) {
        if (!place.has("lat") || !place.has("lon")) return
        prefs(context).edit().putString("visitorPlace", place.toString()).apply()
    }
    fun spot(context: Context): Spot? {
        val place = prefs(context).getString("visitorPlace", null)?.let { try { org.json.JSONObject(it) } catch (_: Exception) { null } } ?: return null
        val names = place.optJSONObject("names")
        val name = names?.let { n -> listOf(L10n.locale.language, "en").firstNotNullOfOrNull { n.optString(it).takeIf { v -> v.isNotBlank() } } } ?: ""
        return Spot(place.optDouble("lat"), place.optDouble("lon"), name)
    }
    fun shown(context: Context) = prefs(context).getBoolean("globeShowMe", true)
    fun show(context: Context, on: Boolean) { prefs(context).edit().putBoolean("globeShowMe", on).apply() }
}
