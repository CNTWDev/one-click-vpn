package com.veilbird.client

import android.os.SystemClock

/**
 * The connection as the person sees it, the same seven states on every client (Apple Link, Windows Link):
 * each has one drawing of the portrait, one title, one detail and one action.
 */
enum class LinkState { IDLE, CONNECTING, SWITCHING, CONNECTED, RECONNECTING, WAITING, FAILED }

/** What went wrong, said as the cause, the next step and the button that takes it (the second one is optional). */
data class Trouble(val title: String, val detail: String, val primary: Int, val primaryDo: String, val secondary: Int? = null, val secondaryDo: String? = null)

object Guidance {
    fun state(): LinkState {
        val s = ConnectionStateStore
        if (!s.active) return if (s.errorCode.isNotEmpty() || s.messageId !in listOf(R.string.not_connected, R.string.disconnected)) LinkState.FAILED else LinkState.IDLE
        return when (s.messageId) {
            R.string.waiting_for_network -> LinkState.WAITING
            R.string.reconnecting_status, R.string.location_retrying -> LinkState.RECONNECTING
            R.string.confirming_connection_status -> if (s.since > 0) LinkState.SWITCHING else LinkState.CONNECTING
            else -> if (s.since > 0) LinkState.CONNECTED else LinkState.CONNECTING
        }
    }
    /** Seconds until the next try while reconnecting. */
    fun countdown(): Long = maxOf(0L, (ConnectionStateStore.retryAt - SystemClock.elapsedRealtime() + 999) / 1000)
    fun phase(): String = L10n.text(when (ConnectionStateStore.phase) { 0 -> R.string.phase_route; 1 -> R.string.phase_tunnel; else -> R.string.phase_confirm })

    /** The cause of the last failure. [automatic]: the location is left to the app. Actions: retry, devices, automatic, nodes, signin, settings, account, update. */
    fun trouble(automatic: Boolean): Trouble {
        val node = ConnectionStateStore.node
        return when (ConnectionStateStore.errorCode) {
            "DEVICE_LIMIT_REACHED" -> Trouble(L10n.text(R.string.error_device_title), L10n.text(R.string.error_device_detail), R.string.manage_devices_action, "devices", R.string.retry_action, "retry")
            "HANDSHAKE_TIMEOUT", "NODE_UNAVAILABLE", "NODE_FULL" ->
                if (automatic) Trouble(L10n.text(R.string.error_node_title, node), L10n.text(R.string.error_node_auto_detail), R.string.retry_action, "retry", R.string.change_location_action, "nodes")
                else Trouble(L10n.text(R.string.error_node_title, node), L10n.text(R.string.error_node_detail), R.string.use_automatic_action, "automatic", R.string.change_location_action, "nodes")
            "MEMBERSHIP_EXPIRED", "ACCESS_EXPIRED" -> Trouble(L10n.text(R.string.error_expired_title), L10n.text(R.string.error_expired_detail), R.string.retry_action, "retry")
            "QUOTA_EXHAUSTED" -> Trouble(L10n.text(R.string.error_quota_title), L10n.text(R.string.error_quota_detail), R.string.retry_action, "retry")
            "AUTH_REQUIRED" -> Trouble(L10n.text(R.string.error_session_title), L10n.text(R.string.error_session_detail), R.string.sign_in_again_action, "signin")
            "VPN_PERMISSION_REQUIRED" -> Trouble(L10n.text(R.string.permission_needed_title), L10n.text(R.string.error_permission_detail), R.string.retry_action, "retry", R.string.open_settings_short, "settings")
            "DEVICE_REVOKED" -> Trouble(L10n.text(R.string.error_revoked_title), L10n.text(R.string.error_revoked_detail), R.string.view_account_action, "account")
            "CLIENT_UPDATE_REQUIRED" -> Trouble(L10n.text(R.string.error_update_title), L10n.text(R.string.error_update_detail), R.string.update_now, "update")
            "LEASE_EXPIRED" -> Trouble(L10n.text(R.string.error_lease_title), L10n.text(R.string.error_lease_detail), R.string.connect_again_action, "retry")
            "ACCOUNT_UNAVAILABLE", "MANAGED_ACCESS_REQUIRED", "CLIENT_ACCESS_NOT_ENABLED" ->
                Trouble(L10n.text(R.string.error_account_title), ConnectionStateStore.message, R.string.retry_action, "retry")
            "" -> Trouble(L10n.text(R.string.connect_failed_title), ConnectionStateStore.message, R.string.retry_action, "retry")
            else -> Trouble(L10n.text(R.string.error_service_title), L10n.text(R.string.error_service_detail), R.string.retry_action, "retry")
        }
    }
}
