package com.veilbird.client

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.view.Gravity
import android.view.View
import android.widget.ProgressBar
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.format.DateUtils
import android.text.InputType
import android.text.TextWatcher
import android.text.Editable
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.wireguard.android.backend.GoBackend
import org.json.JSONObject
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
    private var selectedName = L10n.text(R.string.automatic_recommended)
    private var page = "connect"
    private var busy = false
    private var status: TextView? = null
    private var connectButton: Button? = null
    private var visible = false
    private var progress: ProgressBar? = null
    private val ink = Color.rgb(24, 39, 49)
    private val teal = Color.rgb(0, 122, 100)
    private val muted = Color.rgb(91, 105, 112)
    private val canvas = Color.rgb(248, 246, 238)
    private val mint = Color.rgb(226, 247, 240)
    private val good = Color.rgb(0, 140, 96)
    private val fair = Color.rgb(196, 132, 0)
    private val poor = Color.rgb(190, 60, 45)
    private var power: TextView? = null
    private var stats: TextView? = null
    private var nodeTitle: TextView? = null
    private var nodeDetail: TextView? = null
    private var nodeDot: View? = null
    private val refresh = object : Runnable {
        override fun run() {
            val active = ConnectionStateStore.active
            status?.text = ConnectionStateStore.message
            connectButton?.text = if (active) L10n.text(R.string.disconnect_action) else L10n.text(R.string.connect_action)
            power?.apply {
                val on = active && ConnectionStateStore.since > 0
                background = rounded(if (on) teal else mint, 48); setTextColor(if (on) Color.WHITE else teal)
            }
            stats?.apply {
                val since = ConnectionStateStore.since
                visibility = if (active && since > 0) View.VISIBLE else View.INVISIBLE
                if (since > 0) text = L10n.text(R.string.connection_stats, DateUtils.formatElapsedTime((SystemClock.elapsedRealtime() - since) / 1000), mbps(ConnectionStateStore.rxRate), mbps(ConnectionStateStore.txRate))
            }
            showCurrentNode()
            if (visible) handler.postDelayed(this, 1000)
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); api = NativeApi(this); updater = Updater(this, api)
        val settings = getSharedPreferences("preferences", MODE_PRIVATE)
        selectedId = settings.getString("nodeId", "")!!; selectedName = settings.getString("nodeName", L10n.text(R.string.automatic_recommended))!!
        render(); checkForUpdate()
    }
    override fun onResume() { super.onResume(); visible = true; handler.post(refresh) }
    override fun onPause() { visible = false; handler.removeCallbacks(refresh); super.onPause() }
    override fun onDestroy() { executor.shutdown(); super.onDestroy() }
    private fun rounded(color: Int, radius: Int = 16) = GradientDrawable().apply { setColor(color); cornerRadius = radius.dp.toFloat() }
    private fun surface(color: Int, radius: Int = 16) = RippleDrawable(ColorStateList.valueOf(Color.argb(35, 0, 80, 65)), rounded(color, radius), rounded(Color.WHITE, radius))
    private fun label(text: String, size: Float = 15f) = TextView(this).apply {
        this.text = text; textSize = size; setTextColor(if (size >= 18) ink else muted)
        if (size >= 18) typeface = Typeface.create("sans-serif", Typeface.BOLD)
        setPadding(0, 4.dp, 0, 8.dp); setLineSpacing(2.dp.toFloat(), 1f)
    }
    private fun styleButton(view: Button, primary: Boolean = false, danger: Boolean = false) = view.apply {
        minHeight = 48.dp; minimumHeight = 48.dp; textSize = 15f; isAllCaps = false; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        background = surface(if (primary) teal else if (danger) Color.rgb(255, 238, 234) else mint, 14)
        setTextColor(if (primary) Color.WHITE else if (danger) Color.rgb(163, 49, 37) else teal)
        setPadding(16.dp, 10.dp, 16.dp, 10.dp)
        stateListAnimator = null
    }
    private fun button(text: String, action: () -> Unit): Button = styleButton(Button(this), text in listOf(L10n.text(R.string.connect_action), L10n.text(R.string.disconnect_action), L10n.text(R.string.sign_in_and_start)), text in listOf(L10n.text(R.string.revoke_access), L10n.text(R.string.sign_out))).apply {
        this.text = text; setOnClickListener { if (!busy) action() }
    }.also { content.addView(it, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 6.dp; bottomMargin = 6.dp }) }
    private fun card(title: String, detail: String) {
        content.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; background = rounded(Color.WHITE, 16); setPadding(16.dp, 8.dp, 16.dp, 8.dp)
            addView(label(title, 18f)); addView(label(detail, 14f))
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 4.dp; bottomMargin = 8.dp })
    }
    private fun field(hint: String, value: String = "", password: Boolean = false, uri: Boolean = false) = EditText(this).apply {
        this.hint = hint; setText(value); setSingleLine(true); inputType = InputType.TYPE_CLASS_TEXT or when {password -> InputType.TYPE_TEXT_VARIATION_PASSWORD; uri -> InputType.TYPE_TEXT_VARIATION_URI; else -> InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS}
        textSize = 15f; setTextColor(ink); setHintTextColor(muted); setPadding(14.dp, 8.dp, 14.dp, 8.dp)
        background = rounded(Color.WHITE, 12).apply { setStroke(1.dp, Color.rgb(222, 226, 220)) }
    }.also { content.addView(it, LinearLayout.LayoutParams(-1, 48.dp).apply { bottomMargin = 10.dp }) }
    private val Int.dp get() = (this * resources.displayMetrics.density).toInt()
    private fun mbps(bytesPerSecond: Long) = String.format(L10n.locale, "%.1f", bytesPerSecond * 8 / 1_000_000.0)
    private fun gradeColor(quality: Quality?) = when (quality?.grade) {
        R.string.quality_good -> good; R.string.quality_fair -> fair; R.string.quality_poor -> poor; else -> Color.rgb(190, 196, 192)
    }
    private fun dot(color: Int) = View(this).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) } }
    /** "86 ms · Good", or the grade alone when nothing answered. */
    private fun summary(quality: Quality) = quality.latency?.let { L10n.text(R.string.latency_ms, L10n.number(it)) + " · " + L10n.text(quality.grade) } ?: L10n.text(quality.grade)
    /** A tappable list row: status dot, title with a muted detail line, and an optional value on the right. */
    private fun row(title: String, detail: String, dotColor: Int, trailing: String = "", trailingColor: Int = muted, selected: Boolean = false, onClick: () -> Unit): LinearLayout {
        val titleView = label(title, 15f).apply { setTextColor(ink); typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL); setPadding(0, 0, 0, 0); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        val detailView = label(detail, 13f).apply { setPadding(0, 2.dp, 0, 0); visibility = if (detail.isEmpty()) View.GONE else View.VISIBLE }
        val dotView = dot(dotColor)
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; minimumHeight = 56.dp
            background = surface(if (selected) mint else Color.WHITE, 14); setPadding(14.dp, 8.dp, 14.dp, 8.dp)
            isClickable = true; setOnClickListener { if (!busy) onClick() }
            addView(dotView, LinearLayout.LayoutParams(10.dp, 10.dp).apply { marginEnd = 12.dp })
            addView(LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL; addView(titleView); addView(detailView) }, LinearLayout.LayoutParams(0, -2, 1f))
            if (trailing.isNotEmpty()) addView(label(trailing, 15f).apply { setTextColor(trailingColor); typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL); setPadding(12.dp, 0, 0, 0) })
            tag = Triple(titleView, detailView, dotView)
        }
    }
    private fun showCurrentNode() {
        val title = nodeTitle ?: return
        val active = ConnectionStateStore.active
        val id = if (active) ConnectionStateStore.nodeId else selectedId
        val quality = Latency.recent[id].takeIf { id.isNotEmpty() }
        title.text = when { active -> ConnectionStateStore.node; selectedId.isEmpty() -> L10n.text(R.string.automatic_recommended); else -> selectedName }
        nodeDetail?.text = when {
            quality != null -> summary(quality)
            !active && selectedId.isEmpty() -> L10n.text(R.string.auto_detail)
            else -> L10n.text(R.string.tap_to_change)
        }
        nodeDot?.background = (nodeDot?.background as? GradientDrawable)?.apply { setColor(if (quality == null && !active && selectedId.isEmpty()) teal else gradeColor(quality)) }
    }
    private fun chooseLanguage() {
        val values = listOf("system", "en", "zh", "ru")
        AlertDialog.Builder(this).setTitle(L10n.text(R.string.language))
            .setSingleChoiceItems(arrayOf(L10n.text(R.string.language_system), "English", "简体中文", "Русский"), values.indexOf(L10n.preference.substringBefore('-'))) { dialog, which ->
                dialog.dismiss(); L10n.select(values[which]); if (android.os.Build.VERSION.SDK_INT < 33) recreate()
            }.setNegativeButton(L10n.text(R.string.cancel), null).show()
    }
    private fun render() {
        status = null; connectButton = null; power = null; stats = null; nodeTitle = null; nodeDetail = null; nodeDot = null
        val side = maxOf(16.dp, (resources.displayMetrics.widthPixels - 560.dp) / 2)
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(side, 12.dp, side, 16.dp) }
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(canvas); fitsSystemWindows = true }
        root.addView(ScrollView(this).apply { isFillViewport = true; addView(content) }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        val signedIn = api.secret("token") != null
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        header.addView(label("Veilbird", 18f).apply { setPadding(0, 0, 0, 0) }, LinearLayout.LayoutParams(0, -2, 1f))
        // Signed in, the language setting lives on the account page; before that it is the only way to change it.
        if (!signedIn) header.addView(label(L10n.text(R.string.language), 14f).apply {
            setTextColor(teal); setPadding(12.dp, 10.dp, 12.dp, 10.dp); background = surface(canvas, 12); setOnClickListener { chooseLanguage() }
        })
        content.addView(header, LinearLayout.LayoutParams(-1, 44.dp))
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { isIndeterminate = true; indeterminateTintList = ColorStateList.valueOf(teal); visibility = if (busy) View.VISIBLE else View.INVISIBLE }
        content.addView(progress, LinearLayout.LayoutParams(-1, 4.dp).apply { bottomMargin = 4.dp })
        if (announcement.isNotBlank()) content.addView(label(announcement, 14f).apply { setTextColor(ink); background = rounded(mint, 14); setPadding(14.dp, 10.dp, 14.dp, 10.dp) }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 8.dp })
        update?.let { available ->
            card(L10n.text(R.string.update_available, available.version), L10n.text(if (available.mandatory) R.string.update_required_detail else R.string.update_available_detail))
            button(L10n.text(R.string.update_now)) { installUpdate(available) }
        }
        if (!signedIn) { login(); return }
        val nav = LinearLayout(this).apply { setPadding(8.dp, 6.dp, 8.dp, 6.dp); setBackgroundColor(Color.WHITE) }
        for ((tab, title) in listOf("connect" to L10n.text(R.string.connect_tab), "nodes" to L10n.text(R.string.locations), "account" to L10n.text(R.string.account))) nav.addView(styleButton(Button(this)).apply {
            text = title; isSelected = tab == page; background = surface(if (isSelected) mint else Color.WHITE, 12)
            setTextColor(if (isSelected) teal else muted); contentDescription = title + if (isSelected) L10n.text(R.string.current_page) else ""
            maxLines = 1; setPadding(4.dp, 0, 4.dp, 0)
            setOnClickListener { if (!busy) { page = tab; render() } }
        }, LinearLayout.LayoutParams(0, 48.dp, 1f).apply { marginStart = 4.dp; marginEnd = 4.dp })
        root.addView(nav)
        when (page) {
            "connect" -> home()
            "nodes" -> nodes()
            else -> account()
        }
        handler.removeCallbacks(refresh); if (visible) handler.post(refresh)
    }
    /** Everything needed to connect fits on one phone screen: state, current location, one button. */
    private fun home() {
        power = label("⏻", 36f).apply { gravity = Gravity.CENTER; setPadding(0, 0, 0, 0); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO; background = rounded(mint, 48); setTextColor(teal) }
        content.addView(power, LinearLayout.LayoutParams(96.dp, 96.dp).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = 20.dp; bottomMargin = 12.dp })
        status = label(ConnectionStateStore.message, 20f).apply { gravity = Gravity.CENTER; setPadding(0, 0, 0, 0) }.also { content.addView(it, LinearLayout.LayoutParams(-1, -2)) }
        stats = label("", 13f).apply { gravity = Gravity.CENTER; setPadding(0, 4.dp, 0, 0); visibility = View.INVISIBLE; maxLines = 1 }.also { content.addView(it, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 16.dp }) }
        val current = row("", " ", teal, "›", muted) { page = "nodes"; render() }
        @Suppress("UNCHECKED_CAST") (current.tag as Triple<TextView, TextView, View>).let { (t, d, v) -> nodeTitle = t; nodeDetail = d; nodeDot = v }
        current.contentDescription = L10n.text(R.string.tap_to_change)
        content.addView(current, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 6.dp })
        if (update?.mandatory != true || ConnectionStateStore.active) connectButton = button(if (ConnectionStateStore.active) L10n.text(R.string.disconnect_action) else L10n.text(R.string.connect_action)) {
            if (ConnectionStateStore.active) startService(Intent(this, ConnectionService::class.java).setAction("disconnect"))
            else { val consent = GoBackend.VpnService.prepare(this); if (consent != null) startActivityForResult(consent, 10) else startConnection() }
        }.apply { minHeight = 52.dp; minimumHeight = 52.dp }
        showCurrentNode()
    }
    private fun login() {
        content.addView(label(L10n.text(R.string.your_world_one_tap_away), 26f).apply { setPadding(0, 12.dp, 0, 4.dp) })
        content.addView(label(L10n.text(R.string.sign_in_to_veilbird_no_imports_or_configuration_needed)))
        val server = if (BuildConfig.API_ORIGIN.isEmpty()) field(L10n.text(R.string.server_address_url), api.origin, uri = true) else null
        content.addView(label(L10n.text(R.string.email), 13f)); val email = field(L10n.text(R.string.enter_email))
        content.addView(label(L10n.text(R.string.password), 13f)); val password = field(L10n.text(R.string.enter_password), password = true)
        button(L10n.text(R.string.sign_in_and_start)) {
            val origin = server?.text?.toString(); val address = email.text.toString(); val secret = password.text.toString()
            if (address.isBlank() || secret.isEmpty()) { alert(L10n.text(R.string.enter_your_email_and_password)); return@button }
            work({ if (origin != null) api.origin = origin; api.login(address, secret) }) { password.setText(""); render(); checkForUpdate() }
        }
    }
    private var measuring = false
    private fun nodes() {
        val active = ConnectionStateStore.active
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        header.addView(label(L10n.text(R.string.locations), 20f).apply { setPadding(0, 0, 0, 0) }, LinearLayout.LayoutParams(0, -2, 1f))
        val retest = label(L10n.text(if (measuring) R.string.measuring_latency else R.string.retest_latency), 14f).apply {
            setTextColor(if (active) muted else teal); setPadding(12.dp, 10.dp, 12.dp, 10.dp); background = surface(canvas, 12)
        }
        if (!active) header.addView(retest)
        content.addView(header, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 4.dp })
        // While connected, probes would run through the tunnel, so the list keeps the last results and the server's order.
        if (active) content.addView(label(L10n.text(R.string.test_after_disconnecting), 13f))
        val auto = row(L10n.text(R.string.automatic_recommended), L10n.text(R.string.auto_detail), teal, if (selectedId.isEmpty()) "✓" else "", teal, selectedId.isEmpty()) { select("", L10n.text(R.string.automatic_recommended)) }
        content.addView(auto, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 8.dp })
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        work({ api.request("nodes").getJSONArray("nodes") }) { nodes ->
            var query = ""
            var ranked: List<Pair<JSONObject, Quality?>> = Latency.unmeasured(nodes).map { (node, _) -> node to Latency.recent[node.getString("id")] }
                .sortedBy { it.second?.score ?: Long.MAX_VALUE }
            if (nodes.length() == 0) content.addView(label(L10n.text(R.string.no_locations_available_refresh_later_or_contact_your_administrator)))
            if (nodes.length() > 6) field(L10n.text(R.string.search_locations_or_regions)).apply {
                inputType = InputType.TYPE_CLASS_TEXT
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { query = s.toString(); show(list, ranked, query) }
                    override fun afterTextChanged(s: Editable?) {}
                })
            }
            content.addView(list)
            show(list, ranked, query)
            fun measure() {
                if (measuring || ConnectionStateStore.active) return
                measuring = true; retest.text = L10n.text(R.string.measuring_latency); progress?.visibility = View.VISIBLE
                Thread {
                    val result = try { Latency.rank(nodes) } catch (_: Exception) { null }
                    runOnUiThread {
                        measuring = false
                        if (isDestroyed) return@runOnUiThread
                        if (!busy) progress?.visibility = View.INVISIBLE
                        retest.text = L10n.text(R.string.retest_latency)
                        if (result != null && list.isAttachedToWindow) { ranked = result; show(list, ranked, query) }
                    }
                }.start()
            }
            retest.setOnClickListener { measure() }
            // Fresh results are kept for the session; opening the page again does not probe every node again.
            if (!active && ranked.any { it.second == null }) measure()
        }
    }
    private fun show(list: LinearLayout, ranked: List<Pair<JSONObject, Quality?>>, query: String) {
        list.removeAllViews()
        for ((node, quality) in ranked) {
            val region = node.optString("region")
            if (!(node.getString("name") + " " + region).contains(query, ignoreCase = true)) continue
            val id = node.getString("id")
            val detail = listOfNotNull(
                region.takeIf { it.isNotBlank() && it != "null" },
                quality?.takeIf { it.latency != null }?.let { L10n.text(R.string.node_quality_detail, L10n.number(it.jitter), L10n.number(it.loss)) },
                (quality?.load ?: node.takeUnless { it.isNull("load") }?.optInt("load"))?.let { L10n.text(R.string.node_load, L10n.number(it)) },
            ).joinToString(" · ")
            val trailing = when {
                quality == null -> if (measuring) "…" else ""
                quality.latency == null -> L10n.text(R.string.quality_unreachable)
                else -> L10n.text(R.string.latency_ms, L10n.number(quality.latency))
            }
            list.addView(row(node.getString("name"), detail, gradeColor(quality), trailing, if (quality == null) muted else gradeColor(quality), id == selectedId) {
                select(id, node.getString("name"))
            }.apply { contentDescription = node.getString("name") + ", " + (quality?.let { summary(it) } ?: "") + if (id == selectedId) L10n.text(R.string.current_page) else "" },
                LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 6.dp })
        }
        if (list.childCount == 0 && ranked.isNotEmpty()) list.addView(label(L10n.text(R.string.no_matching_locations_try_another_search)))
    }
    private fun select(id: String, name: String) {
        if (ConnectionStateStore.active) { alert(L10n.text(R.string.disconnect_before_selecting_another_location)); return }
        selectedId = id; selectedName = name; page = "connect"; render()
        getSharedPreferences("preferences", MODE_PRIVATE).edit().putString("nodeId", id).putString("nodeName", name).apply()
    }
    private fun account() {
        content.addView(label(L10n.text(R.string.my_veilbird), 20f).apply { setPadding(0, 0, 0, 8.dp) })
        work({ api.request("account") }) { data ->
            card(data.getString("name"), data.getString("email") + "\n" + L10n.text(R.string.account_valid_until, L10n.date(data.optString("expiresAt"))))
            data.optJSONObject("traffic")?.let { traffic -> card(L10n.text(R.string.traffic_30_days), "↑ ${android.text.format.Formatter.formatFileSize(this, traffic.optString("uploadBytes", "0").toLongOrNull() ?: 0)}   ↓ ${android.text.format.Formatter.formatFileSize(this, traffic.optString("downloadBytes", "0").toLongOrNull() ?: 0)}") }
            content.addView(label(L10n.text(R.string.account_device_quota, L10n.number(data.getInt("used")), L10n.number(data.getInt("limit"))), 18f).apply { setPadding(0, 8.dp, 0, 4.dp) })
            content.addView(label(L10n.text(R.string.new_devices_are_added_on_their_first_connection_when)))
            val devices = data.getJSONArray("devices")
            var deviceCount = 0
            for (i in 0 until devices.length()) {
                val d = devices.getJSONObject(i)
                if (d.getString("status") == "revoked") continue
                deviceCount++
                card(d.getString("name") + if (d.getBoolean("isCurrent")) L10n.text(R.string.this_device) else "", d.optString("platform", L10n.text(R.string.authorized_devices)))
                if (d.getString("status") == "revoking") content.addView(label(L10n.text(R.string.revoking_access_the_slot_is_usually_released_within_about)))
                else button(L10n.text(R.string.revoke_access)) {
                    AlertDialog.Builder(this).setTitle(L10n.text(R.string.revoke_this_device_s_access)).setMessage(L10n.text(R.string.this_device_will_no_longer_be_able_to_connect)).setNegativeButton(L10n.text(R.string.cancel), null).setPositiveButton(L10n.text(R.string.revoke_access)) { _, _ ->
                        work({ api.action("revoke", JSONObject().put("enrollmentId", d.getString("id"))) }) {
                            if (d.getBoolean("isCurrent") && ConnectionStateStore.active) startService(Intent(this, ConnectionService::class.java).setAction("disconnect"))
                            render()
                        }
                    }.show()
                }
            }
            if (deviceCount == 0) content.addView(label(L10n.text(R.string.no_authorized_devices_yet_they_appear_after_their_first)))
            button(L10n.text(R.string.refresh_devices)) { render() }
            button(L10n.text(R.string.language)) { chooseLanguage() }
            button(L10n.text(R.string.sign_out)) {
                if (ConnectionStateStore.active) { alert(L10n.text(R.string.disconnect_the_vpn_before_signing_out)); return@button }
                work({ try { api.request("logout", JSONObject()) } finally { api.saveSecret("token", null) } }) { render() }
            }
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
    /** Background check; failures are silent because the next launch checks again. */
    private fun checkForUpdate() {
        Thread {
            val found = try { updater.check() } catch (_: Exception) { null } ?: return@Thread
            runOnUiThread {
                if (!isDestroyed && (found.update?.build != update?.build || found.announcement != announcement)) { update = found.update; announcement = found.announcement; if (!busy) render() }
            }
        }.start()
    }
    private fun installUpdate(available: UpdateInfo) {
        if (!updater.canInstall()) { alert(L10n.text(R.string.update_allow_installs)); startActivity(updater.installPermissionIntent()); return }
        status?.text = L10n.text(R.string.update_downloading)
        work({ updater.downloadAndInstall(available) }) {}
    }
    private fun alert(message: String) { AlertDialog.Builder(this).setTitle("Veilbird").setMessage(message).setPositiveButton(L10n.text(R.string.got_it), null).show() }
    private fun startConnection() { startForegroundService(Intent(this, ConnectionService::class.java).putExtra("nodeId", selectedId)) }
    @Deprecated("Activity result compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 10) { if (resultCode == RESULT_OK) startConnection() else alert(L10n.text(R.string.allow_the_system_vpn_permission_to_connect)) }
    }
}
