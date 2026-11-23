package com.veilbird.client

import android.os.SystemClock

/**
 * The connection as the person sees it, the same seven states on every client (Apple Link, Windows Link):
 * each has one drawing of the portrait, one title, one detail and one action.
 */
enum class LinkState { IDLE, CONNECTING, SWITCHING, CONNECTED, RECONNECTING, WAITING, FAILED }

/** One row of the check shown under a failure: what was checked, what it found, and whether that step passed. */
data class Check(val label: Int, val value: String, val status: Int) { companion object { const val OK = 0; const val BAD = 1; const val SKIP = 2 } }

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

    /**
     * The four steps a connection takes (network, server, lines, tunnel) and where the last attempt stopped, for
     * failures of the network itself; null for a refusal of the account or the device, which has its own cause.
     */
    fun checks(): List<Check>? {
        val s = ConnectionStateStore
        val ok = L10n.text(R.string.diag_ok); val skip = L10n.text(R.string.diag_not_started)
        fun row(label: Int, value: String, status: Int) = Check(label, value, status)
        val network = when (s.networkState) {
            "captive" -> row(R.string.diag_network, L10n.text(R.string.diag_captive), Check.BAD)
            "offline" -> row(R.string.diag_network, L10n.text(R.string.diag_no_internet), Check.BAD)
            else -> row(R.string.diag_network, ok, Check.OK)
        }
        val rest = listOf(R.string.diag_server, R.string.diag_lines, R.string.diag_tunnel)
        if (network.status == Check.BAD && s.errorCode in NETWORK) return listOf(network) + rest.map { row(it, skip, Check.SKIP) }
        val reached = row(R.string.diag_server, L10n.text(R.string.diag_reached), Check.OK)
        return when (s.errorCode) {
            "SERVICE_UNAVAILABLE" -> listOf(network, row(R.string.diag_server, L10n.text(R.string.diag_unreached), Check.BAD), row(R.string.diag_lines, skip, Check.SKIP), row(R.string.diag_tunnel, skip, Check.SKIP))
            "HANDSHAKE_TIMEOUT" -> listOf(network, reached,
                row(R.string.diag_lines, if (s.lines > 0) L10n.text(R.string.diag_lines_blocked, L10n.number(s.lines)) else L10n.text(R.string.diag_all_blocked), Check.BAD), row(R.string.diag_tunnel, skip, Check.SKIP))
            "VPN_PERMISSION_REQUIRED" -> listOf(network, row(R.string.diag_server, skip, Check.SKIP), row(R.string.diag_lines, skip, Check.SKIP), row(R.string.diag_tunnel, L10n.text(R.string.diag_no_permission), Check.BAD))
            "CONNECT_FAILED", "" -> listOf(network, reached, row(R.string.diag_lines, skip, Check.SKIP), row(R.string.diag_tunnel, L10n.text(R.string.diag_tunnel_failed), Check.BAD))
            else -> null
        }
    }
    /** The check as one line for the report a person sends: "network=ok server=bad lines=skip tunnel=skip". */
    fun summary(): String = checks()?.joinToString(" ") { c ->
        val name = when (c.label) { R.string.diag_network -> "network"; R.string.diag_server -> "server"; R.string.diag_lines -> "lines"; else -> "tunnel" }
        name + "=" + when (c.status) { Check.OK -> "ok"; Check.BAD -> "bad"; else -> "skip" }
    }?.let { "$it net=${ConnectionStateStore.networkState} code=${ConnectionStateStore.errorCode.ifEmpty { "CONNECT_FAILED" }}" } ?: "code=${ConnectionStateStore.errorCode}"
    /** Failures the network itself can cause (a Wi-Fi sign-in page or no network then explains them better). */
    private val NETWORK = setOf("SERVICE_UNAVAILABLE", "HANDSHAKE_TIMEOUT", "CONNECT_FAILED", "")
    /** The second line while connected over a line the network forced, or empty. */
    fun bypass(): String {
        val b = ConnectionStateStore.bypass
        return when {
            b.startsWith("udp:") -> L10n.text(R.string.bypass_udp, Transports.label(b.removePrefix("udp:")))
            b == "port" -> L10n.text(R.string.bypass_port)
            else -> ""
        }
    }

    /** The cause of the last failure. [automatic]: the location is left to the app. Actions: retry, devices, automatic, nodes, signin, settings, account, update. */
    fun trouble(automatic: Boolean): Trouble {
        val node = ConnectionStateStore.node
        val code = ConnectionStateStore.errorCode
        // The network explains a network failure first: a Wi-Fi sign-in page, or no network at all.
        if (code in NETWORK) when (ConnectionStateStore.networkState) {
            "captive" -> return Trouble(L10n.text(R.string.error_captive_title), L10n.text(R.string.error_captive_detail), R.string.open_network_settings, "wifi", R.string.retry_action, "retry")
            "offline" -> return Trouble(L10n.text(R.string.error_no_internet_title), L10n.text(R.string.error_no_internet_detail), R.string.open_network_settings, "wifi", R.string.retry_action, "retry")
        }
        return when (code) {
            "DEVICE_LIMIT_REACHED" -> Trouble(L10n.text(R.string.error_device_title), L10n.text(R.string.error_device_detail), R.string.manage_devices_action, "devices", R.string.retry_action, "retry")
            // Automatic already tried the fastest locations: the server answered, the lines did not.
            "HANDSHAKE_TIMEOUT" -> if (automatic) Trouble(L10n.text(R.string.error_lines_title), L10n.text(R.string.error_lines_detail), R.string.change_location_action, "nodes", R.string.send_check_action, "send")
                else Trouble(L10n.text(R.string.error_node_title, node), L10n.text(R.string.error_node_detail), R.string.use_automatic_action, "automatic", R.string.send_check_action, "send")
            "NODE_UNAVAILABLE", "NODE_FULL" ->
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
            "", "CONNECT_FAILED" -> Trouble(L10n.text(R.string.connect_failed_title), ConnectionStateStore.message, R.string.retry_action, "retry", R.string.send_check_action, "send")
            else -> Trouble(L10n.text(R.string.error_service_title), L10n.text(R.string.error_service_detail), R.string.retry_action, "retry")
        }
    }
}
