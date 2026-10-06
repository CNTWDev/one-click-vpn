package com.veilbird.client

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
    @Volatile var messageId = R.string.not_connected
    val message: String get() = L10n.text(messageId)
    @Volatile var node = L10n.text(R.string.automatic)
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
    override fun getName() = "veilbird"
    override fun onStateChange(state: Tunnel.State) { if (state == Tunnel.State.DOWN) ConnectionStateStore.active = false }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate(); api = NativeApi(this); backend = GoBackend(this)
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("vpn", L10n.text(R.string.vpn_connection), NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "disconnect") { worker.execute { stopConnection(R.string.disconnected) }; return START_NOT_STICKY }
        if (ConnectionStateStore.active) return START_NOT_STICKY
        startForeground(1, notification(L10n.text(R.string.connecting)))
        ConnectionStateStore.active = true; ConnectionStateStore.messageId = R.string.authorizing_and_connecting
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
                startedAt = SystemClock.elapsedRealtime(); ConnectionStateStore.messageId = R.string.confirming_connection_status
                worker.scheduleWithFixedDelay({ tick() }, 2, 5, TimeUnit.SECONDS)
                api.report("")
            } catch (e: Exception) { api.report((e as? ApiFailure)?.code ?: "CONNECT_FAILED", nodeId); stopConnection(friendlyResource(e)) }
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
            // After Doze the lease may already have lapsed: one renewal attempt before closing the tunnel.
            if (SystemClock.elapsedRealtime() >= renewAt || SystemClock.elapsedRealtime() >= deadline) {
                try { acquire(); startedAt = maxOf(startedAt, SystemClock.elapsedRealtime()) } catch (e: ApiFailure) {
                    if (e.code in listOf("AUTH_REQUIRED", "DEVICE_REVOKED", "MEMBERSHIP_EXPIRED", "ACCOUNT_UNAVAILABLE", "MANAGED_ACCESS_REQUIRED", "CLIENT_UPDATE_REQUIRED")) { api.report(e.code, nodeId); stopConnection(friendlyResource(e)); return }
                    renewAt = SystemClock.elapsedRealtime() + 15000
                } catch (_: Exception) { renewAt = SystemClock.elapsedRealtime() + 15000 }
                if (SystemClock.elapsedRealtime() >= deadline) { api.report("LEASE_RENEWAL_FAILED", nodeId); stopConnection(R.string.connection_authorization_expired_connect_again); return }
            }
            val stats = backend.getStatistics(this)
            val handshake = stats.peers().maxOfOrNull { stats.peer(it)?.latestHandshakeEpochMillis() ?: 0 } ?: 0
            if (handshake > 0 && System.currentTimeMillis() - handshake < 180000) ConnectionStateStore.messageId = R.string.connected_status
            else {
                ConnectionStateStore.messageId = R.string.confirming_connection_status
                if (SystemClock.elapsedRealtime() - startedAt > 45000) { api.report("HANDSHAKE_TIMEOUT", nodeId); stopConnection(R.string.this_location_is_not_responding_try_another); return }
            }
            ConnectionStateStore.bytes = "↑ ${stats.totalTx() / 1024} KB   ↓ ${stats.totalRx() / 1024} KB"
            getSystemService(NotificationManager::class.java).notify(1, notification(ConnectionStateStore.message))
        } catch (_: Exception) { api.report("TUNNEL_ERROR", nodeId); stopConnection(R.string.connection_interrupted_try_again) }
    }
    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, ConnectionService::class.java).setAction("disconnect"), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, "vpn").setContentTitle("Veilbird").setContentText(text).setSmallIcon(android.R.drawable.ic_lock_lock).setContentIntent(open).setOngoing(true).addAction(Notification.Action.Builder(null, L10n.text(R.string.disconnect_status), stop).build()).build()
    }
    private fun stopConnection(message: Int) {
        if (stopping) return
        stopping = true
        try { backend.setState(this, Tunnel.State.DOWN, null) } catch (_: Exception) { }
        ConnectionStateStore.active = false; ConnectionStateStore.messageId = message; ConnectionStateStore.bytes = ""
        try { api.action("disconnect", JSONObject()) } catch (_: Exception) { }
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    override fun onDestroy() {
        worker.shutdownNow()
        try { backend.setState(this, Tunnel.State.DOWN, null) } catch (_: Exception) { }
        ConnectionStateStore.active = false; super.onDestroy()
    }
}
