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
    const val GROUP = "Veilbird"
    const val TEST_URL = "https://www.gstatic.com/generate_204"
    private const val MEMORY_DAYS = 7L
    private val privateNetworks = listOf("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16")
    // Same small rule sets as the subscription profiles (server/mihomo-config.mjs), fetched through the tunnel.
    private const val RULE_SETS = "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo"

    /**
     * A short, one-way label for the network the device uses outside the VPN: the carrier code on
     * mobile data, or a hash of the Wi-Fi network's DNS servers, domain and gateway. Nothing that
     * names the network is stored.
     */
    fun networkKey(context: Context): String {
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

    /** The whole mihomo configuration for one node; JSON is valid YAML. */
    fun config(proxies: List<JSONObject>, order: List<String>, fd: Int, smart: Boolean): String {
        fun array(vararg values: String) = JSONArray().apply { values.forEach { put(it) } }
        val dns = JSONObject().put("enable", true).put("ipv6", false).put("enhanced-mode", "fake-ip").put("fake-ip-range", "198.18.0.1/16")
            .put("fake-ip-filter", array("+.lan", "+.local", "localhost.ptlogin2.qq.com", "+.msftconnecttest.com", "+.msftncsi.com", "time.*.com", "+.ntp.org.cn"))
            .put("respect-rules", true)
            .put("default-nameserver", array("223.5.5.5", "119.29.29.29"))
            .put("nameserver", array("https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"))
            .put("proxy-server-nameserver", array("https://doh.pub/dns-query", "223.5.5.5"))
        if (smart) dns.put("nameserver-policy", JSONObject().put("rule-set:private_domain,cn_domain", array("https://doh.pub/dns-query", "https://dns.alidns.com/dns-query")))
        val rules = JSONArray()
        privateNetworks.forEach { rules.put("IP-CIDR,$it,DIRECT,no-resolve") }
        if (smart) listOf("RULE-SET,private_domain,DIRECT", "RULE-SET,cn_domain,DIRECT", "RULE-SET,cn_ip,DIRECT").forEach { rules.put(it) }
        rules.put("MATCH,$GROUP")
        fun ruleSet(kind: String, name: String, behavior: String) = JSONObject().put("type", "http").put("behavior", behavior).put("format", "mrs")
            .put("url", "$RULE_SETS/$kind/$name.mrs").put("path", "./rules/$kind-$name.mrs").put("interval", 86400).put("proxy", GROUP)
        val config = JSONObject()
            .put("mode", "rule").put("log-level", "silent").put("ipv6", false).put("find-process-mode", "off")
            .put("unified-delay", true).put("tcp-concurrent", true).put("geo-auto-update", false)
            .put("profile", JSONObject().put("store-selected", false).put("store-fake-ip", false))
            .put("dns", dns)
            // The app owns the tun (VpnService) and excludes itself from it, so mihomo neither routes nor binds.
            .put("tun", JSONObject().put("enable", true).put("stack", "gvisor").put("file-descriptor", fd).put("auto-route", false)
                .put("auto-detect-interface", false).put("dns-hijack", array("any:53")).put("mtu", 1500))
            .put("proxies", JSONArray(proxies))
            .put("proxy-groups", JSONArray().put(JSONObject().put("name", GROUP).put("type", "fallback").put("proxies", JSONArray(order))
                .put("url", TEST_URL).put("interval", 300).put("lazy", false)))
            .put("rules", rules)
        if (smart) config.put("rule-providers", JSONObject().put("private_domain", ruleSet("geosite", "private", "domain"))
            .put("cn_domain", ruleSet("geosite", "cn", "domain")).put("cn_ip", ruleSet("geoip", "cn", "ipcidr")))
        return config.toString()
    }

    /** "name=delay,..." from Core.probe; -1 means no answer. */
    fun parseProbe(result: String): Map<String, Long> = result.split(',').filter { '=' in it }
        .associate { it.substringBefore('=') to (it.substringAfter('=').toLongOrNull() ?: -1L) }
}
