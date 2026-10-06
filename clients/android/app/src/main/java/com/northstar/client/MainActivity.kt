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
    private var selectedName = "自动选择 · 推荐"
    private var page = "连接"
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
            status?.text = ConnectionStateStore.message + "\n" + (if (ConnectionStateStore.active) ConnectionStateStore.node else selectedName) + "\n" + ConnectionStateStore.bytes
            connectButton?.text = if (ConnectionStateStore.active) "断开连接" else "一键连接"
            if (visible) handler.postDelayed(this, 1000)
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); api = NativeApi(this)
        val settings = getSharedPreferences("preferences", MODE_PRIVATE)
        selectedId = settings.getString("nodeId", "")!!; selectedName = settings.getString("nodeName", "自动选择 · 推荐")!!
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
    private fun button(text: String, action: () -> Unit): Button = styleButton(Button(this), text in listOf("一键连接", "断开连接", "登录并开始"), text in listOf("解除授权", "退出登录")).apply {
        this.text = text; setOnClickListener { if (!busy) action() }
    }.also { content.addView(it, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8.dp; bottomMargin = 8.dp }) }
    private fun card(title: String, detail: String) {
        content.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; background = rounded(Color.WHITE, 24); setPadding(20.dp, 12.dp, 20.dp, 12.dp)
            addView(label(title, 21f)); addView(label(detail, 15f))
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 8.dp; bottomMargin = 12.dp })
    }
    private fun field(hint: String, value: String = "", password: Boolean = false) = EditText(this).apply {
        this.hint = hint; setText(value); setSingleLine(true); inputType = InputType.TYPE_CLASS_TEXT or when {password -> InputType.TYPE_TEXT_VARIATION_PASSWORD; hint.startsWith("服务地址") -> InputType.TYPE_TEXT_VARIATION_URI; else -> InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS}
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
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { isIndeterminate = true; indeterminateTintList = ColorStateList.valueOf(teal); visibility = if (busy) View.VISIBLE else View.GONE }
        content.addView(progress, LinearLayout.LayoutParams(-1, 4.dp))
        if (api.secret("token") == null) { login(); return }
        val nav = LinearLayout(this).apply { setPadding(12.dp, 10.dp, 12.dp, 10.dp); setBackgroundColor(Color.WHITE) }
        for (tab in listOf("连接", "节点", "我的")) nav.addView(styleButton(Button(this)).apply {
            text = tab; isSelected = tab == page; background = surface(if (isSelected) mint else Color.WHITE, 16)
            setTextColor(if (isSelected) teal else muted); contentDescription = tab + if (isSelected) "，当前页面" else ""
            setOnClickListener { if (!busy) { page = tab; render() } }
        }, LinearLayout.LayoutParams(0, 56.dp, 1f).apply { marginStart = 4.dp; marginEnd = 4.dp })
        root.addView(nav)
        when (page) {
            "连接" -> {
                content.addView(label("连接，自在一点。", 30f))
                content.addView(label("选好位置，剩下的交给 NORTHSTAR。"))
                content.addView(label("⏻", 64f).apply { gravity = Gravity.CENTER; setTextColor(teal); background = rounded(mint, 80); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }, LinearLayout.LayoutParams(144.dp, 144.dp).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = 24.dp; bottomMargin = 16.dp })
                status = label(ConnectionStateStore.message, 20f).apply { gravity = Gravity.CENTER; background = rounded(Color.WHITE, 24); setPadding(18.dp, 22.dp, 18.dp, 22.dp) }.also { content.addView(it, LinearLayout.LayoutParams(-1, -2)) }
                connectButton = button(if (ConnectionStateStore.active) "断开连接" else "一键连接") {
                    if (ConnectionStateStore.active) startService(Intent(this, ConnectionService::class.java).setAction("disconnect"))
                    else { val consent = GoBackend.VpnService.prepare(this); if (consent != null) startActivityForResult(consent, 10) else startConnection() }
                }
                button("更换连接位置  ›") { page = "节点"; render() }
                content.addView(label("默认自动选择可用节点。第一次连接需要允许系统 VPN 权限。"))
            }
            "节点" -> nodes()
            else -> account()
        }
    }
    private fun login() {
        content.addView(label("世界很大，\n一点即达。", 34f)); content.addView(label("登录 NORTHSTAR，无需导入或配置。"))
        card("随心选择，自在连接", "自动选择可用位置，也能自由指定节点。")
        val server = if (BuildConfig.API_ORIGIN.isEmpty()) field("服务地址 https://…", api.origin) else null
        content.addView(label("邮箱", 14f)); val email = field("输入邮箱")
        content.addView(label("密码", 14f)); val password = field("输入密码", password = true)
        button("登录并开始") {
            val origin = server?.text?.toString(); val address = email.text.toString(); val secret = password.text.toString()
            if (address.isBlank() || secret.isEmpty()) { alert("请填写邮箱和密码。"); return@button }
            work({ if (origin != null) api.origin = origin; api.login(address, secret) }) { password.setText(""); render() }
        }
    }
    private fun nodes() {
        content.addView(label("你想从哪里连接？", 28f))
        content.addView(label(if (ConnectionStateStore.active) "请先断开连接，再更换位置。" else "选好位置后，返回首页一键连接。"))
        button("自动选择 · 推荐") { select("", "自动选择 · 推荐") }
        work({ api.request("nodes") }) { data ->
            val nodes = data.getJSONArray("nodes")
            if (nodes.length() == 0) content.addView(label("暂无可用节点，请稍后刷新或联系管理员。"))
            val search = field("搜索节点或地区").apply { inputType = InputType.TYPE_CLASS_TEXT }
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
                if (list.childCount == 0 && nodes.length() > 0) list.addView(label("没有匹配的位置，试试其他关键词。"))
            }
            filter("")
            search.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { filter(s.toString()) }
                override fun afterTextChanged(s: Editable?) {}
            })
            button("刷新节点") { render() }
        }
    }
    private fun select(id: String, name: String) {
        if (ConnectionStateStore.active) { alert("请先断开连接，再选择新的连接位置。"); return }
        selectedId = id; selectedName = name; page = "连接"; render()
        getSharedPreferences("preferences", MODE_PRIVATE).edit().putString("nodeId", id).putString("nodeName", name).apply()
    }
    private fun account() {
        content.addView(label("我的 NORTHSTAR", 28f))
        content.addView(label("账号、用量和设备，都在这里。"))
        work({ api.request("account") }) { data ->
            card(data.getString("name"), data.getString("email") + "\n有效期 · ${if (data.isNull("expiresAt")) "不限期" else data.getString("expiresAt").take(10)}")
            data.optJSONObject("traffic")?.let { traffic -> card("近 30 天流量", "↑ ${android.text.format.Formatter.formatFileSize(this, traffic.optString("uploadBytes", "0").toLongOrNull() ?: 0)}   ↓ ${android.text.format.Formatter.formatFileSize(this, traffic.optString("downloadBytes", "0").toLongOrNull() ?: 0)}") }
            content.addView(label("授权设备   ${data.getInt("used")} / ${data.getInt("limit")}", 22f))
            content.addView(label("未满额度时，新设备首次连接会自动加入。"))
            val devices = data.getJSONArray("devices")
            var deviceCount = 0
            for (i in 0 until devices.length()) {
                val d = devices.getJSONObject(i)
                if (d.getString("status") == "revoked") continue
                deviceCount++
                card(d.getString("name") + if (d.getBoolean("isCurrent")) " · 本机" else "", d.optString("platform", "授权设备"))
                if (d.getString("status") == "revoking") content.addView(label("解除中，通常最多约 5 分钟后释放额度。"))
                else button("解除授权") {
                    AlertDialog.Builder(this).setTitle("解除这台设备的授权？").setMessage("这台设备将不能继续连接。节点同步后释放额度，离线节点最多等待约 5 分钟。").setNegativeButton("取消", null).setPositiveButton("解除授权") { _, _ ->
                        work({ api.action("revoke", JSONObject().put("enrollmentId", d.getString("id"))) }) {
                            if (d.getBoolean("isCurrent") && ConnectionStateStore.active) startService(Intent(this, ConnectionService::class.java).setAction("disconnect"))
                            render()
                        }
                    }.show()
                }
            }
            if (deviceCount == 0) content.addView(label("还没有授权设备，首次连接后会出现在这里。"))
            button("刷新设备状态") { render() }
            button("退出登录") {
                if (ConnectionStateStore.active) { alert("请先断开 VPN，再退出登录。"); return@button }
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
    private fun alert(message: String) { AlertDialog.Builder(this).setTitle("NORTHSTAR").setMessage(message).setPositiveButton("知道了", null).show() }
    private fun startConnection() { startForegroundService(Intent(this, ConnectionService::class.java).putExtra("nodeId", selectedId)) }
    @Deprecated("Activity result compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 10) { if (resultCode == RESULT_OK) startConnection() else alert("允许系统 VPN 权限后才能连接。") }
    }
}
