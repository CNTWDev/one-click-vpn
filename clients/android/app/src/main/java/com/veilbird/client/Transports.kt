package com.veilbird.client

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.telephony.TelephonyManager
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/**
 * How the app reaches a node. Every node offers the same ladder, lightest first: WireGuard
 * (UDP, least CPU and battery), Hysteria2 with obfuscation (UDP, fast on lossy links), VLESS
 * REALITY (TCP 443, looks like an ordinary HTTPS site) and REALITY over XHTTP (TCP, plain
 * HTTP requests, for networks that cut long-lived TLS streams). All are tried at once; the
 * first one that answers in ladder order carries traffic. A transport that failed on a network
 * while another worked goes to the end of the ladder there for a week.
 */
object Transports {
    val ladder = listOf("wireguard", "hysteria2", "reality", "xhttp")
    const val GROUP = "TrackNothing"
    const val TEST_URL = "https://www.gstatic.com/generate_204"
    private const val MEMORY_DAYS = 7L

    /**
     * A short, one-way label for the network the device uses outside the VPN: the carrier code on
     * mobile data, or a hash of the Wi-Fi network's DNS servers, domain and gateway. Nothing that
     * names the network is stored.
     */
    fun networkKey(context: Context): String = try { readNetworkKey(context) } catch (_: SecurityException) { "unknown" }

    /** Only a hint for transport memory: a failure to read the network must never stop a connection. */
    private fun readNetworkKey(context: Context): String {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        @Suppress("DEPRECATION")
        val networks = manager.allNetworks.mapNotNull { network -> manager.getNetworkCapabilities(network)?.let { network to it } }
            .filter { (_, caps) -> !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) }
            .sortedBy { (_, caps) -> if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) 1 else 0 }
        val (network, caps) = networks.firstOrNull() ?: return "unknown"
        val raw = if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
            "cell:" + (context.getSystemService(TelephonyManager::class.java)?.networkOperator ?: "")
        } else {
            val link = manager.getLinkProperties(network)
            "lan:" + listOf(link?.dnsServers?.joinToString(","), link?.domains, link?.routes?.mapNotNull { it.gateway?.hostAddress }?.sorted()?.joinToString(",")).joinToString("|")
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray())
        return raw.substringBefore(':') + ":" + digest.take(6).joinToString("") { "%02x".format(it) }
    }

    private fun memory(context: Context) = context.getSharedPreferences("transports", Context.MODE_PRIVATE)

    /** Transports that failed on this network within the last week, while another one worked. */
    fun blocked(context: Context, network: String): Set<String> {
        val entry = try { JSONObject(memory(context).getString(network, "{}")!!) } catch (_: Exception) { JSONObject() }
        val cutoff = System.currentTimeMillis() - MEMORY_DAYS * 86400000
        return entry.keys().asSequence().filter { entry.optLong(it) > cutoff }.toSet()
    }

    fun remember(context: Context, network: String, failed: Collection<String>, working: Collection<String>) {
        val prefs = memory(context)
        val entry = try { JSONObject(prefs.getString(network, "{}")!!) } catch (_: Exception) { JSONObject() }
        val now = System.currentTimeMillis()
        failed.forEach { entry.put(it, now) }; working.forEach { entry.remove(it) }
        val editor = prefs.edit()
        // Forget networks not seen for a week, so the memory stays a handful of entries.
        for ((key, value) in prefs.all) {
            val stale = try { JSONObject(value as String).let { e -> e.keys().asSequence().none { e.optLong(it) > now - MEMORY_DAYS * 86400000 } } } catch (_: Exception) { true }
            if (stale && key != network) editor.remove(key)
        }
        if (entry.length() == 0) editor.remove(network) else editor.putString(network, entry.toString())
        editor.apply()
    }

    /** Ladder order, with transports this network blocked moved to the end. */
    fun order(names: Collection<String>, blocked: Set<String>): List<String> =
        ladder.filter { it in names }.sortedBy { if (it in blocked) 1 else 0 }

    /** WireGuard as a mihomo proxy: the app holds the private key, the lease gives the rest. */
    fun wireguard(lease: JSONObject, privateKey: String): JSONObject {
        val wg = lease.getJSONObject("wireguard")
        val endpoint = wg.getString("endpoint")
        val host = endpoint.substringBeforeLast(':').removePrefix("[").removeSuffix("]")
        return JSONObject().put("name", "wireguard").put("type", "wireguard").put("server", host).put("port", endpoint.substringAfterLast(':').toInt())
            .put("ip", wg.getString("address").substringBefore('/')).put("private-key", privateKey).put("public-key", wg.getString("serverPublicKey"))
            .put("allowed-ips", JSONArray().put("0.0.0.0/0")).put("udp", true).put("mtu", 1280)
            .put("remote-dns-resolve", true).put("dns", wg.getJSONArray("dns"))
    }

    /** What the core needs to build the configuration (clients/core/config.go): the same on every app. */
    fun options(proxies: List<JSONObject>, order: List<String>, fd: Int, smart: Boolean): String =
        JSONObject().put("platform", "android").put("fd", fd).put("smart", smart).put("proxies", JSONArray(proxies)).put("order", JSONArray(order)).toString()

    /** "name=delay,..." from Core.probe; -1 means no answer. */
    fun parseProbe(result: String): Map<String, Long> = result.split(',').filter { '=' in it }
        .associate { it.substringBefore('=') to (it.substringAfter('=').toLongOrNull() ?: -1L) }
}
