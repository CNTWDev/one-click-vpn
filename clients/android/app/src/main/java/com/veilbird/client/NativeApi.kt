package com.veilbird.client

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.URI
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import com.veilbird.core.Core
import org.json.JSONArray
import java.io.File

class ApiFailure(val code: String) : Exception(code)

/**
 * The TrackNothing API. Calls go through the core (Core.fetch): the address the app was given, the other API
 * domains the server lists (every site plus backup domains), addresses that worked before and DNS over HTTPS,
 * so a blocked domain or poisoned DNS does not lock the app out.
 */
class NativeApi(context: Context) {
    private val prefs = context.getSharedPreferences("veilbird", Context.MODE_PRIVATE)
    private val home = File(context.filesDir, "core").apply { mkdirs() }.path
    private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private val alias = "veilbird-device-v1"
    var origin: String
        get() = BuildConfig.API_ORIGIN.ifEmpty { prefs.getString("origin", "")!! }
        set(value) {
            val uri = URI(value.trim())
            require(uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.userInfo == null && uri.rawQuery == null && uri.fragment == null && uri.path in listOf("", "/"))
            prefs.edit().putString("origin", value.trim().trimEnd('/')).apply()
        }
    init {
        if (!store.containsAlias(alias)) KeyPairGenerator.getInstance("EC", "AndroidKeyStore").apply {
            initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN).setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build())
        }.generateKeyPair()
        if (!store.containsAlias("veilbird-storage")) KeyGenerator.getInstance("AES", "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("veilbird-storage", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun b64(value: ByteArray) = Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    fun secret(name: String): String? = prefs.getString(name, null)?.let {
        try {
            val parts = it.split('.')
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, store.getKey("veilbird-storage", null) as SecretKey, GCMParameterSpec(128, Base64.decode(parts[0], Base64.URL_SAFE)))
                String(doFinal(Base64.decode(parts[1], Base64.URL_SAFE)), Charsets.UTF_8)
            }
        } catch (_: Exception) { prefs.edit().remove(name).apply(); null }
    }
    fun saveSecret(name: String, value: String?) {
        if (value == null) { prefs.edit().remove(name).apply(); return }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, store.getKey("veilbird-storage", null)) }
        prefs.edit().putString(name, b64(cipher.iv) + "." + b64(cipher.doFinal(value.toByteArray()))).apply()
    }
    /** Set by the VPN service for the length of one connection attempt. */
    @Volatile var attempt: String? = null

    /**
     * Every origin of this server, best first: the one that answered last, the others the server listed, and the
     * address the app was given. Another address means another server: only that one until it answers.
     */
    private fun origins(): List<String> {
        val saved = prefs.getString("origins", "")!!.split('\n').filter { it.isNotEmpty() }
        return if (origin in saved) saved else listOf(origin)
    }
    @Synchronized private fun remember(answered: String?, offered: JSONArray?) {
        var list = origins()
        if (offered != null) list = (0 until offered.length()).map { offered.optString(it) }.filter { it.startsWith("https://") }.take(12) + origin
        if (!answered.isNullOrEmpty()) list = listOf(answered) + (list - answered)
        prefs.edit().putString("origins", list.distinct().take(14).joinToString("\n")).apply()
    }
    /** One call through the core: status and body of the first origin that answered. */
    private fun send(method: String, path: String, body: JSONObject?, headers: Map<String, String>, timeoutMs: Int = 15000): Pair<Int, String> {
        if (origin.isEmpty()) throw ApiFailure("SERVER_REQUIRED")
        val tried = origins()
        val all = JSONObject().put("Accept", "application/json")
        headers.forEach { (name, value) -> all.put(name, value) }
        val request = JSONObject().put("origins", JSONArray(tried)).put("method", method).put("path", path).put("timeoutMs", timeoutMs).put("headers", all)
        if (body != null) { all.put("Content-Type", "application/json"); request.put("body", body.toString()) }
        val reply = try { JSONObject(Core.fetch(home, request.toString())) } catch (_: Exception) { throw ApiFailure("SERVICE_UNAVAILABLE") }
        reply.optString("error").takeIf { it.isNotEmpty() }?.let { Journal.add("api: unreachable (${Journal.scrub(it)})"); throw ApiFailure("SERVICE_UNAVAILABLE") }
        val answered = reply.optString("origin")
        if (answered.isNotEmpty() && answered != tried.first()) { Journal.add("api: answered by another address"); remember(answered, null) }
        return reply.optInt("status") to reply.optString("body")
    }
    fun request(path: String, body: JSONObject? = null): JSONObject {
        // Lets the server require an upgrade (CLIENT_UPDATE_REQUIRED) and track version adoption.
        val headers = mutableMapOf("X-Veilbird-Client" to "android/${BuildConfig.VERSION_NAME}+${BuildConfig.VERSION_CODE}")
        if (path != "login") secret("token")?.let { headers["Authorization"] = "Bearer $it" }
        // One id per connection attempt: the server's runtime log lines for it carry the same id.
        attempt?.let { headers["X-Request-Id"] = it }
        val (code, text) = send(if (body == null) "GET" else "POST", "/api/v2/native/$path", body, headers)
        val data = try { JSONObject(text) } catch (_: Exception) { throw ApiFailure("SERVICE_UNAVAILABLE") }
        if (code !in 200..299) throw ApiFailure(data.optString("code", "SERVICE_UNAVAILABLE"))
        data.optJSONArray("apiOrigins")?.let { remember(null, it) }
        return data
    }
    /** A public GET (release catalog) over the same origins. */
    fun get(pathAndQuery: String): JSONObject {
        val (code, text) = send("GET", pathAndQuery, null, emptyMap())
        if (code != 200) throw ApiFailure("SERVICE_UNAVAILABLE")
        return try { JSONObject(text) } catch (_: Exception) { throw ApiFailure("INVALID_RESPONSE") }
    }
    /**
     * Queues a connection failure code and a scrubbed error text (no keys, addresses or traffic)
     * and sends the queue when the service is reachable; the network is often what just failed.
     */
    @Synchronized fun report(code: String, nodeId: String = "", detail: String = "", network: String = "", at: String? = null) {
        val queue = try { org.json.JSONArray(prefs.getString("diagnostics", "[]")) } catch (_: Exception) { org.json.JSONArray() }
        if (code.isNotEmpty()) queue.put(JSONObject().put("code", code).put("at", at ?: java.time.Instant.now().toString()).apply {
            if (nodeId.isNotEmpty()) put("nodeId", nodeId)
            if (detail.isNotEmpty()) put("detail", detail)
            if (network.isNotEmpty()) put("network", network)
            attempt?.let { put("attempt", it) }
        })
        while (queue.length() > 20) queue.remove(0)
        prefs.edit().putString("diagnostics", queue.toString()).apply()
        if (queue.length() == 0 || secret("token") == null) return
        try { request("diagnostics", JSONObject().put("events", queue)); prefs.edit().remove("diagnostics").apply() } catch (_: Exception) { }
    }
    fun login(email: String, password: String) {
        val pub = store.getCertificate(alias).publicKey as ECPublicKey
        fun fixed(bytes: ByteArray) = ByteArray(32 - bytes.takeLast(32).size) + bytes.takeLast(32).toByteArray()
        val key = JSONObject().put("kty", "EC").put("crv", "P-256").put("x", b64(fixed(pub.w.affineX.toByteArray()))).put("y", b64(fixed(pub.w.affineY.toByteArray())))
        val data = request("login", JSONObject().put("email", email).put("password", password).put("identityKey", key).put("platform", "android").put("deviceName", android.os.Build.MODEL))
        saveSecret("token", data.getString("accessToken"))
    }
    /** Emails the Portal's reset link; the answer is the same whether or not the address has an account. */
    fun requestPasswordReset(email: String) { request("password-reset", JSONObject().put("email", email).put("language", L10n.locale.language)) }
    fun action(action: String, input: JSONObject): JSONObject {
        val challenge = request("challenge", JSONObject().put("action", action).put("request", input))
        val der = Signature.getInstance("SHA256withECDSA").run {
            initSign(store.getKey(alias, null) as java.security.PrivateKey)
            update(Base64.decode(challenge.getString("payload"), Base64.URL_SAFE)); sign()
        }
        require(der[0].toInt() == 0x30 && der[2].toInt() == 2)
        val rLength = der[3].toInt() and 255
        val sOffset = 4 + rLength
        require(der[sOffset].toInt() == 2)
        val sLength = der[sOffset + 1].toInt() and 255
        fun fixed(bytes: ByteArray) = ByteArray(32 - bytes.takeLast(32).size) + bytes.takeLast(32).toByteArray()
        val raw = fixed(der.copyOfRange(4, sOffset)) + fixed(der.copyOfRange(sOffset + 2, sOffset + 2 + sLength))
        return request(action, JSONObject().put("challengeId", challenge.getString("id")).put("signature", b64(raw)).put("request", input))
    }
}
fun friendly(error: Throwable): String = L10n.text(friendlyResource(error))
fun friendlyResource(error: Throwable): Int = when ((error as? ApiFailure)?.code) {
    "DEVICE_LIMIT_REACHED" -> R.string.device_limit_reached_revoke_an_old_device_in_account
    "DEVICE_REVOKED" -> R.string.access_for_this_device_has_been_revoked_contact_your
    "INVALID_CREDENTIALS" -> R.string.incorrect_email_or_password
    "AUTH_REQUIRED" -> R.string.your_session_has_expired_sign_in_again
    "MEMBERSHIP_EXPIRED" -> R.string.your_access_has_expired_contact_your_administrator_to_renew
    "QUOTA_EXHAUSTED" -> R.string.quota_exhausted_hint
    "ACCOUNT_UNAVAILABLE" -> R.string.your_account_is_not_active_contact_your_administrator
    "MANAGED_ACCESS_REQUIRED" -> R.string.ask_your_administrator_to_enable_veilbird_client_access
    "NODE_UNAVAILABLE", "NODE_FULL" -> R.string.this_location_is_unavailable_choose_another_or_use_automatic
    "CLIENT_ACCESS_NOT_ENABLED" -> R.string.client_access_is_not_enabled_on_the_server_contact
    "SERVER_REQUIRED" -> R.string.enter_an_https_server_address_first
    "RATE_LIMITED" -> R.string.too_many_attempts_try_again_later
    "PASSWORD_RESET_UNAVAILABLE" -> R.string.password_reset_unavailable
    "INVALID_EMAIL" -> R.string.enter_a_valid_email
    "CLIENT_UPDATE_REQUIRED" -> R.string.client_update_required
    "UPDATE_FAILED" -> R.string.update_failed
    else -> R.string.unable_to_reach_the_service_check_your_network_and
}
