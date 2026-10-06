package com.northstar.client

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.URI
import java.io.ByteArrayOutputStream
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.HttpsURLConnection

class ApiFailure(val code: String) : Exception(code)
class NativeApi(context: Context) {
    private val prefs = context.getSharedPreferences("northstar", Context.MODE_PRIVATE)
    private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private val alias = "northstar-device-v1"
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
        if (!store.containsAlias("northstar-storage")) KeyGenerator.getInstance("AES", "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("northstar-storage", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun b64(value: ByteArray) = Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    fun secret(name: String): String? = prefs.getString(name, null)?.let {
        try {
            val parts = it.split('.')
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, store.getKey("northstar-storage", null) as SecretKey, GCMParameterSpec(128, Base64.decode(parts[0], Base64.URL_SAFE)))
                String(doFinal(Base64.decode(parts[1], Base64.URL_SAFE)), Charsets.UTF_8)
            }
        } catch (_: Exception) { prefs.edit().remove(name).apply(); null }
    }
    fun saveSecret(name: String, value: String?) {
        if (value == null) { prefs.edit().remove(name).apply(); return }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, store.getKey("northstar-storage", null)) }
        prefs.edit().putString(name, b64(cipher.iv) + "." + b64(cipher.doFinal(value.toByteArray()))).apply()
    }
    fun request(path: String, body: JSONObject? = null): JSONObject {
        if (origin.isEmpty()) throw ApiFailure("SERVER_REQUIRED")
        val connection = URI("${origin}/api/v2/native/$path").toURL().openConnection() as HttpsURLConnection
        connection.connectTimeout = 10000; connection.readTimeout = 10000; connection.instanceFollowRedirects = false
        connection.setRequestProperty("Accept", "application/json")
        if (path != "login") secret("token")?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
        try {
            if (body != null) {
                connection.requestMethod = "POST"; connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val code = connection.responseCode
            val bytes = (if (code in 200..299) connection.inputStream else connection.errorStream)?.use { stream ->
                val buffer = ByteArray(8192)
                val output = ByteArrayOutputStream()
                while (true) { val count = stream.read(buffer); if (count < 0) break; output.write(buffer, 0, count); if (output.size() > 262144) throw ApiFailure("INVALID_RESPONSE") }
                output.toByteArray()
            } ?: byteArrayOf()
            if (bytes.size > 262144) throw ApiFailure("INVALID_RESPONSE")
            val data = try { JSONObject(String(bytes, Charsets.UTF_8)) } catch (_: Exception) { throw ApiFailure("SERVICE_UNAVAILABLE") }
            if (code !in 200..299) throw ApiFailure(data.optString("code", "SERVICE_UNAVAILABLE"))
            return data
        } finally { connection.disconnect() }
    }
    fun login(email: String, password: String) {
        val pub = store.getCertificate(alias).publicKey as ECPublicKey
        fun fixed(bytes: ByteArray) = ByteArray(32 - bytes.takeLast(32).size) + bytes.takeLast(32).toByteArray()
        val key = JSONObject().put("kty", "EC").put("crv", "P-256").put("x", b64(fixed(pub.w.affineX.toByteArray()))).put("y", b64(fixed(pub.w.affineY.toByteArray())))
        val data = request("login", JSONObject().put("email", email).put("password", password).put("identityKey", key).put("platform", "android").put("deviceName", android.os.Build.MODEL))
        saveSecret("token", data.getString("accessToken"))
    }
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
fun friendly(error: Throwable): String = when ((error as? ApiFailure)?.code) {
    "DEVICE_LIMIT_REACHED" -> "授权设备已满，请到「账号」解除一台旧设备的授权后重试。"
    "DEVICE_REVOKED" -> "这台设备的授权已解除，请联系管理员。"
    "INVALID_CREDENTIALS" -> "邮箱或密码不正确。"
    "AUTH_REQUIRED" -> "登录已过期，请重新登录。"
    "MEMBERSHIP_EXPIRED" -> "账号使用期限已到，请联系管理员续期。"
    "ACCOUNT_UNAVAILABLE" -> "账号尚未启用或已停用，请联系管理员。"
    "MANAGED_ACCESS_REQUIRED" -> "请联系管理员开通 NORTHSTAR 客户端访问。"
    "NODE_UNAVAILABLE", "NODE_FULL" -> "该节点暂时不可用，请选择其他节点或自动选择。"
    "CLIENT_ACCESS_NOT_ENABLED" -> "服务端尚未启用客户端访问，请联系管理员。"
    "SERVER_REQUIRED" -> "请先填写 HTTPS 服务地址。"
    "RATE_LIMITED" -> "操作太频繁，请稍后重试。"
    else -> "暂时无法连接服务，请检查网络后重试。"
}
