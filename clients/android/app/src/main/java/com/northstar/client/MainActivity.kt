package com.northstar.client

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
    private val refresh = object : Runnable {
        override fun run() {
            status?.text = ConnectionStateStore.message + "\n" + (if (ConnectionStateStore.active) ConnectionStateStore.node else if (selectedId.isEmpty()) L10n.text(R.string.automatic_recommended) else selectedName) + "\n" + ConnectionStateStore.bytes
            connectButton?.text = if (ConnectionStateStore.active) L10n.text(R.string.disconnect_action) else L10n.text(R.string.connect_action)
            if (visible) handler.postDelayed(this, 1000)
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); api = NativeApi(this)
        val settings = getSharedPreferences("preferences", MODE_PRIVATE)
        selectedId = settings.getString("nodeId", "")!!; selectedName = settings.getString("nodeName", L10n.text(R.string.automatic_recommended))!!
        render()
    }
    override fun onResume() { super.onResume(); visible = true; handler.post(refresh) }
    override fun onPause() { visible = false; handler.removeCallbacks(refresh); super.onPause() }
    override fun onDestroy() { executor.shutdown(); super.onDestroy() }
    private fun rounded(color: Int, radius: Int = 20) = GradientDrawable().apply { setColor(color); cornerRadius = radius.dp.toFloat() }
    private fun surface(color: Int, radius: Int = 20) = RippleDrawable(ColorStateList.valueOf(Color.argb(35, 0, 80, 65)), rounded(color, radius), rounded(Color.WHITE, radius))
    private fun label(text: String, size: Float = 16f) = TextView(this).apply {
        this.text = text; textSize = size; setTextColor(if (size >= 20) ink else muted)
        if (size >= 20) typeface = Typeface.create("sans-serif", Typeface.BOLD)
        setPadding(0, 8.dp, 0, 12.dp); setLineSpacing(3.dp.toFloat(), 1f)
    }
    private fun styleButton(view: Button, primary: Boolean = false, danger: Boolean = false) = view.apply {
        minHeight = 56.dp; textSize = 16f; isAllCaps = false; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        background = surface(if (primary) teal else if (danger) Color.rgb(255, 238, 234) else mint, 18)
        setTextColor(if (primary) Color.WHITE else if (danger) Color.rgb(163, 49, 37) else teal)
        setPadding(18.dp, 14.dp, 18.dp, 14.dp)
        stateListAnimator = null
    }
    private fun button(text: String, action: () -> Unit): Button = styleButton(Button(this), text in listOf(L10n.text(R.string.connect_action), L10n.text(R.string.disconnect_action), L10n.text(R.string.sign_in_and_start)), text in listOf(L10n.text(R.string.revoke_access), L10n.text(R.string.sign_out))).apply {
        this.text = text; setOnClickListener { if (!busy) action() }
    }.also { content.addView(it, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8.dp; bottomMargin = 8.dp }) }
    private fun card(title: String, detail: String) {
        content.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; background = rounded(Color.WHITE, 24); setPadding(20.dp, 12.dp, 20.dp, 12.dp)
            addView(label(title, 21f)); addView(label(detail, 15f))
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8.dp; bottomMargin = 12.dp })
    }
    private fun field(hint: String, value: String = "", password: Boolean = false, uri: Boolean = false) = EditText(this).apply {
        this.hint = hint; setText(value); setSingleLine(true); inputType = InputType.TYPE_CLASS_TEXT or when {password -> InputType.TYPE_TEXT_VARIATION_PASSWORD; uri -> InputType.TYPE_TEXT_VARIATION_URI; else -> InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS}
        textSize = 16f; setTextColor(ink); setHintTextColor(muted); setPadding(18.dp, 12.dp, 18.dp, 12.dp)
        background = rounded(Color.WHITE, 16).apply { setStroke(1.dp, Color.rgb(222, 226, 220)) }
    }.also { content.addView(it, LinearLayout.LayoutParams(-1, 58.dp).apply { bottomMargin = 14.dp }) }
    private val Int.dp get() = (this * resources.displayMetrics.density).toInt()
    private fun render() {
        status = null; connectButton = null
        val side = maxOf(24.dp, (resources.displayMetrics.widthPixels - 640.dp) / 2)
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(side, 24.dp, side, 24.dp) }
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(canvas); fitsSystemWindows = true }
        root.addView(ScrollView(this).apply { isFillViewport = true; addView(content) }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        content.addView(label("✦  NORTHSTAR", 22f))
        button(L10n.text(R.string.language)) {
            val values = listOf("system", "en", "zh", "ru")
            AlertDialog.Builder(this).setTitle(L10n.text(R.string.language))
                .setSingleChoiceItems(arrayOf(L10n.text(R.string.language_system), "English", "简体中文", "Русский"), values.indexOf(L10n.preference.substringBefore('-'))) { dialog, which ->
                    dialog.dismiss(); L10n.select(values[which]); if (android.os.Build.VERSION.SDK_INT < 33) recreate()
                }.setNegativeButton(L10n.text(R.string.cancel), null).show()
        }
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { isIndeterminate = true; indeterminateTintList = ColorStateList.valueOf(teal); visibility = if (busy) View.VISIBLE else View.GONE }
        content.addView(progress, LinearLayout.LayoutParams(-1, 4.dp))
        if (api.secret("token") == null) { login(); return }
        val nav = LinearLayout(this).apply { setPadding(12.dp, 10.dp, 12.dp, 10.dp); setBackgroundColor(Color.WHITE) }
        for ((tab, title) in listOf("connect" to L10n.text(R.string.connect_tab), "nodes" to L10n.text(R.string.locations), "account" to L10n.text(R.string.account))) nav.addView(styleButton(Button(this)).apply {
            text = title; isSelected = tab == page; background = surface(if (isSelected) mint else Color.WHITE, 16)
            setTextColor(if (isSelected) teal else muted); contentDescription = title + if (isSelected) L10n.text(R.string.current_page) else ""
            setOnClickListener { if (!busy) { page = tab; render() } }
        }, LinearLayout.LayoutParams(0, 56.dp, 1f).apply { marginStart = 4.dp; marginEnd = 4.dp })
        root.addView(nav)
        when (page) {
            "connect" -> {
                content.addView(label(L10n.text(R.string.connect_with_ease), 30f))
                content.addView(label(L10n.text(R.string.choose_a_location_northstar_takes_care_of_the_rest)))
                content.addView(label("⏻", 64f).apply { gravity = Gravity.CENTER; setTextColor(teal); background = rounded(mint, 80); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }, LinearLayout.LayoutParams(144.dp, 144.dp).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = 24.dp; bottomMargin = 16.dp })
                status = label(ConnectionStateStore.message, 20f).apply { gravity = Gravity.CENTER; background = rounded(Color.WHITE, 24); setPadding(18.dp, 22.dp, 18.dp, 22.dp) }.also { content.addView(it, LinearLayout.LayoutParams(-1, -2)) }
                connectButton = button(if (ConnectionStateStore.active) L10n.text(R.string.disconnect_action) else L10n.text(R.string.connect_action)) {
                    if (ConnectionStateStore.active) startService(Intent(this, ConnectionService::class.java).setAction("disconnect"))
                    else { val consent = GoBackend.VpnService.prepare(this); if (consent != null) startActivityForResult(consent, 10) else startConnection() }
                }
                button(L10n.text(R.string.change_location)) { page = "nodes"; render() }
                content.addView(label(L10n.text(R.string.a_location_is_selected_automatically_allow_the_system_vpn)))
            }
            "nodes" -> nodes()
            else -> account()
        }
    }
    private fun login() {
        content.addView(label(L10n.text(R.string.your_world_one_tap_away), 34f)); content.addView(label(L10n.text(R.string.sign_in_to_northstar_no_imports_or_configuration_needed)))
        card(L10n.text(R.string.your_location_your_connection), L10n.text(R.string.connect_automatically_or_choose_your_own_location))
        val server = if (BuildConfig.API_ORIGIN.isEmpty()) field(L10n.text(R.string.server_address_url), api.origin, uri = true) else null
        content.addView(label(L10n.text(R.string.email), 14f)); val email = field(L10n.text(R.string.enter_email))
        content.addView(label(L10n.text(R.string.password), 14f)); val password = field(L10n.text(R.string.enter_password), password = true)
        button(L10n.text(R.string.sign_in_and_start)) {
            val origin = server?.text?.toString(); val address = email.text.toString(); val secret = password.text.toString()
            if (address.isBlank() || secret.isEmpty()) { alert(L10n.text(R.string.enter_your_email_and_password)); return@button }
            work({ if (origin != null) api.origin = origin; api.login(address, secret) }) { password.setText(""); render() }
        }
    }
    private fun nodes() {
        content.addView(label(L10n.text(R.string.where_would_you_like_to_connect), 28f))
        content.addView(label(if (ConnectionStateStore.active) L10n.text(R.string.disconnect_before_changing_location) else L10n.text(R.string.choose_a_location_then_connect_from_the_home_screen)))
        button(L10n.text(R.string.automatic_recommended)) { select("", L10n.text(R.string.automatic_recommended)) }
        work({ api.request("nodes") }) { data ->
            val nodes = data.getJSONArray("nodes")
            if (nodes.length() == 0) content.addView(label(L10n.text(R.string.no_locations_available_refresh_later_or_contact_your_administrator)))
            val search = field(L10n.text(R.string.search_locations_or_regions)).apply { inputType = InputType.TYPE_CLASS_TEXT }
            val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            content.addView(list)
            fun filter(query: String) {
                list.removeAllViews()
                for (i in 0 until nodes.length()) {
                    val node = nodes.getJSONObject(i)
                    if (!(node.getString("name") + " " + node.optString("region")).contains(query, ignoreCase = true)) continue
                    list.addView(styleButton(Button(this)).apply {
                        text = node.getString("name") + if (node.getString("id") == selectedId) " ✓" else ""
                        background = surface(if (node.getString("id") == selectedId) mint else Color.WHITE, 22)
                        gravity = Gravity.CENTER_VERTICAL or Gravity.START
                        minHeight = 56.dp; isAllCaps = false
                        setOnClickListener { if (!busy) select(node.getString("id"), node.getString("name")) }
                    }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = 12.dp })
                }
                if (list.childCount == 0 && nodes.length() > 0) list.addView(label(L10n.text(R.string.no_matching_locations_try_another_search)))
            }
            filter("")
            search.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { filter(s.toString()) }
                override fun afterTextChanged(s: Editable?) {}
            })
            button(L10n.text(R.string.refresh_locations)) { render() }
        }
    }
    private fun select(id: String, name: String) {
        if (ConnectionStateStore.active) { alert(L10n.text(R.string.disconnect_before_selecting_another_location)); return }
        selectedId = id; selectedName = name; page = "connect"; render()
        getSharedPreferences("preferences", MODE_PRIVATE).edit().putString("nodeId", id).putString("nodeName", name).apply()
    }
    private fun account() {
        content.addView(label(L10n.text(R.string.my_northstar), 28f))
        content.addView(label(L10n.text(R.string.your_account_usage_and_devices_in_one_place)))
        work({ api.request("account") }) { data ->
            card(data.getString("name"), data.getString("email") + "\n" + L10n.text(R.string.account_valid_until, L10n.date(data.optString("expiresAt"))))
            data.optJSONObject("traffic")?.let { traffic -> card(L10n.text(R.string.traffic_30_days), "↑ ${android.text.format.Formatter.formatFileSize(this, traffic.optString("uploadBytes", "0").toLongOrNull() ?: 0)}   ↓ ${android.text.format.Formatter.formatFileSize(this, traffic.optString("downloadBytes", "0").toLongOrNull() ?: 0)}") }
            content.addView(label(L10n.text(R.string.account_device_quota, L10n.number(data.getInt("used")), L10n.number(data.getInt("limit"))), 22f))
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
            try { val result = task(); runOnUiThread { busy = false; progress?.visibility = View.GONE; if (!isDestroyed) success(result) } }
            catch (e: Exception) { runOnUiThread { busy = false; progress?.visibility = View.GONE; if (!isDestroyed) { if ((e as? ApiFailure)?.code == "AUTH_REQUIRED") { api.saveSecret("token", null); render() }; alert(friendly(e)) } } }
        }
    }
    private fun alert(message: String) { AlertDialog.Builder(this).setTitle("NORTHSTAR").setMessage(message).setPositiveButton(L10n.text(R.string.got_it), null).show() }
    private fun startConnection() { startForegroundService(Intent(this, ConnectionService::class.java).putExtra("nodeId", selectedId)) }
    @Deprecated("Activity result compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 10) { if (resultCode == RESULT_OK) startConnection() else alert(L10n.text(R.string.allow_the_system_vpn_permission_to_connect)) }
    }
}
