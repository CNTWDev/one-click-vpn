package com.veilbird.client

import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** Quick Settings tile: connect or disconnect from the notification shade with the saved location and routing. */
class ToggleTile : TileService() {
    override fun onStartListening() { refresh() }
    override fun onClick() {
        if (ConnectionStateStore.active) {
            startService(Intent(this, ConnectionService::class.java).setAction("disconnect"))
        } else if (NativeApi(this).secret("token") == null || VpnService.prepare(this) != null) {
            // Sign-in or the system VPN permission needs the app.
            open(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } else {
            try { startForegroundService(Intent(this, ConnectionService::class.java)) }
            catch (_: Exception) { open(Intent(this, MainActivity::class.java).putExtra("connect", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
        qsTile?.let { it.state = Tile.STATE_UNAVAILABLE; it.updateTile() }
        android.os.Handler(mainLooper).postDelayed({ refresh() }, 1500)
    }
    private fun open(intent: Intent) {
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 2, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        else @Suppress("DEPRECATION") startActivityAndCollapse(intent)
    }
    private fun refresh() {
        val tile = qsTile ?: return
        tile.state = if (ConnectionStateStore.active) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = "TrackNothing"
        if (Build.VERSION.SDK_INT >= 29) tile.subtitle = ConnectionStateStore.message
        tile.updateTile()
    }
}
