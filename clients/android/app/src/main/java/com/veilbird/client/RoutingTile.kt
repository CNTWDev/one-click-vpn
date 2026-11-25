package com.veilbird.client

import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** Quick Settings tile: smart routing on (smart) or off (global). Like the app, it changes only while disconnected. */
class RoutingTile : TileService() {
    private val prefs get() = getSharedPreferences("preferences", MODE_PRIVATE)
    override fun onStartListening() { refresh() }
    override fun onClick() {
        if (ConnectionStateStore.active) return
        prefs.edit().putString("routing", if (prefs.getString("routing", "smart") == "smart") "global" else "smart").apply()
        refresh()
    }
    private fun refresh() {
        val tile = qsTile ?: return
        val smart = prefs.getString("routing", "smart") == "smart"
        tile.label = L10n.text(R.string.routing_tile)
        // Connected: shown but not changeable (the app asks to disconnect first, too).
        tile.state = if (ConnectionStateStore.active) Tile.STATE_UNAVAILABLE else if (smart) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.updateTile()
    }
}
