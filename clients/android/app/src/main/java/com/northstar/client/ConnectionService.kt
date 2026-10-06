package com.northstar.client

import android.app.*
import android.content.Intent
import android.os.IBinder
import android.os.SystemClock
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import com.wireguard.crypto.KeyPair
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

object ConnectionStateStore {
    @Volatile var active = false
    @Volatile var message = "未连接"
    @Volatile var node = "自动选择"
    @Volatile var bytes = ""
}
class ConnectionService : Service(), Tunnel {
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private lateinit var api: NativeApi
    private lateinit var backend: GoBackend
    private var nodeId = ""
    private val keyPair = KeyPair()
    private var deadline = 0L
    private var renewAt = 0L
    private var stopping = false
    private var startedAt = 0L
    override fun getName() = "northstar"
    override fun onStateChange(state: Tunnel.State) { if (state == Tunnel.State.DOWN) ConnectionStateStore.active = false }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate(); api = NativeApi(this); backend = GoBackend(this)
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("vpn", "VPN 连接", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "disconnect") { worker.execute { stopConnection("已断开") }; return START_NOT_STICKY }
        if (ConnectionStateStore.active) return START_NOT_STICKY
        startForeground(1, notification("正在连接…"))
        ConnectionStateStore.active = true; ConnectionStateStore.message = "正在授权并连接…"
        nodeId = intent?.getStringExtra("nodeId") ?: ""
        worker.execute {
            try {
                val lease = acquire()
                val wg = lease.getJSONObject("wireguard")
                val dns = wg.getJSONArray("dns")
                val config = """
                    [Interface]
                    PrivateKey = ${keyPair.privateKey.toBase64()}
                    Address = ${wg.getString("address")}
                    DNS = ${(0 until dns.length()).joinToString(", ") { dns.getString(it) }}
                    MTU = 1280
                    [Peer]
                    PublicKey = ${wg.getString("serverPublicKey")}
                    Endpoint = ${wg.getString("endpoint")}
                    AllowedIPs = 0.0.0.0/0, ::/0
                    PersistentKeepalive = 25
                """.trimIndent()
                backend.setState(this, Tunnel.State.UP, Config.parse(config.byteInputStream()))
                startedAt = SystemClock.elapsedRealtime(); ConnectionStateStore.message = "正在确认连接…"
                worker.scheduleWithFixedDelay({ tick() }, 2, 5, TimeUnit.SECONDS)
            } catch (e: Exception) { stopConnection(friendly(e)) }
        }
        return START_NOT_STICKY
    }
    private fun acquire(): JSONObject {
        val input = JSONObject().put("publicKey", keyPair.publicKey.toBase64())
        if (nodeId.isNotEmpty()) input.put("nodeId", nodeId)
        val lease = api.action("connect", input)
        nodeId = lease.getString("nodeId")
        val remaining = (Instant.parse(lease.getString("expiresAt")).toEpochMilli() - System.currentTimeMillis()).coerceAtMost(300000)
        if (remaining <= 0) throw ApiFailure("ACCESS_EXPIRED")
        deadline = SystemClock.elapsedRealtime() + remaining; renewAt = SystemClock.elapsedRealtime() + 90000
        ConnectionStateStore.node = lease.getString("nodeName")
        for (attempt in 0 until 15) {
            if (SystemClock.elapsedRealtime() >= deadline) throw ApiFailure("ACCESS_EXPIRED")
            if (api.request("status/${lease.getString("leaseId")}").getBoolean("ready")) return lease
            Thread.sleep(1000)
        }
        throw ApiFailure("NODE_UNAVAILABLE")
    }
    private fun tick() {
        if (stopping) return
        try {
            if (SystemClock.elapsedRealtime() >= deadline) { stopConnection("连接授权已过期，请重新连接。"); return }
            if (SystemClock.elapsedRealtime() >= renewAt) {
                try { acquire() } catch (e: ApiFailure) {
                    if (e.code in listOf("AUTH_REQUIRED", "DEVICE_REVOKED", "MEMBERSHIP_EXPIRED", "ACCOUNT_UNAVAILABLE", "MANAGED_ACCESS_REQUIRED")) { stopConnection(friendly(e)); return }
                    renewAt = SystemClock.elapsedRealtime() + 15000
                } catch (_: Exception) { renewAt = SystemClock.elapsedRealtime() + 15000 }
            }
            val stats = backend.getStatistics(this)
            val handshake = stats.peers().maxOfOrNull { stats.peer(it)?.latestHandshakeEpochMillis() ?: 0 } ?: 0
            if (handshake > 0 && System.currentTimeMillis() - handshake < 180000) ConnectionStateStore.message = "已连接"
            else {
                ConnectionStateStore.message = "正在确认连接…"
                if (SystemClock.elapsedRealtime() - startedAt > 45000) { stopConnection("节点未响应，请换一个节点重试。"); return }
            }
            ConnectionStateStore.bytes = "↑ ${stats.totalTx() / 1024} KB   ↓ ${stats.totalRx() / 1024} KB"
            getSystemService(NotificationManager::class.java).notify(1, notification(ConnectionStateStore.message))
        } catch (_: Exception) { stopConnection("连接已中断，请重试。") }
    }
    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, ConnectionService::class.java).setAction("disconnect"), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, "vpn").setContentTitle("NORTHSTAR").setContentText(text).setSmallIcon(android.R.drawable.ic_lock_lock).setContentIntent(open).setOngoing(true).addAction(Notification.Action.Builder(null, "断开", stop).build()).build()
    }
    private fun stopConnection(message: String) {
        if (stopping) return
        stopping = true
        try { backend.setState(this, Tunnel.State.DOWN, null) } catch (_: Exception) { }
        ConnectionStateStore.active = false; ConnectionStateStore.message = message; ConnectionStateStore.bytes = ""
        try { api.action("disconnect", JSONObject()) } catch (_: Exception) { }
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    override fun onDestroy() {
        worker.shutdownNow()
        try { backend.setState(this, Tunnel.State.DOWN, null) } catch (_: Exception) { }
        ConnectionStateStore.active = false; super.onDestroy()
    }
}
