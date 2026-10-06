package com.veilbird.client

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.UUID
import javax.net.ssl.HttpsURLConnection

class UpdateInfo(val version: String, val build: Int, val url: String, val sha256: String, val sizeBytes: Long, val mandatory: Boolean)
class ReleaseStatus(val update: UpdateInfo?, val announcement: String)

/**
 * Self-update for directly distributed APKs: the Controller's release catalog says
 * which build is current, the APK is verified against its published SHA-256, and
 * the system installer (which also enforces the same signing key) asks the user to confirm.
 */
class Updater(private val context: Context, private val api: NativeApi) {
    private val prefs = context.getSharedPreferences("veilbird", Context.MODE_PRIVATE)

    /** Stable random id: places this install in a staged-rollout bucket, nothing more. */
    val installation: String get() = prefs.getString("installation", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("installation", it).apply() }

    /** Newest build for this install (staged rollouts included) plus the operator's announcement. */
    fun check(): ReleaseStatus? {
        if (api.origin.isEmpty()) return null
        val query = "platform=android&arch=universal&build=${BuildConfig.VERSION_CODE}&installation=${URLEncoder.encode(installation, "UTF-8")}"
        val data = get("${api.origin}/api/v1/client-releases/latest?$query")
        val latest = data.optJSONObject("latest")
        val update = if (BuildConfig.SELF_UPDATE && latest != null && data.optBoolean("updateAvailable") && latest.optString("distribution") == "direct")
            UpdateInfo(latest.getString("version"), latest.getInt("build"), latest.getString("url"), latest.getString("sha256"), latest.getLong("sizeBytes"), data.optBoolean("mandatory"))
        else null
        return ReleaseStatus(update, data.optString("announcement", "").take(500))
    }

    /** False when the user must first allow installs from this app in system settings. */
    fun canInstall() = context.packageManager.canRequestPackageInstalls()
    fun installPermissionIntent() = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun downloadAndInstall(update: UpdateInfo) {
        val uri = URI(update.url)
        if (uri.scheme != "https" || update.sizeBytes <= 0 || update.sizeBytes > 512L * 1024 * 1024 || !update.sha256.matches(Regex("^[0-9a-f]{64}$"))) throw ApiFailure("UPDATE_FAILED")
        val dir = File(context.cacheDir, "updates").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
        val file = File(dir, "veilbird-${update.build}.apk")
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        val connection = uri.toURL().openConnection() as HttpsURLConnection
        connection.connectTimeout = 15000; connection.readTimeout = 30000
        try {
            if (connection.responseCode != 200) throw ApiFailure("UPDATE_FAILED")
            connection.inputStream.use { input -> file.outputStream().use { output ->
                val buffer = ByteArray(65536)
                while (true) {
                    val count = input.read(buffer); if (count < 0) break
                    total += count; if (total > update.sizeBytes) throw ApiFailure("UPDATE_FAILED")
                    digest.update(buffer, 0, count); output.write(buffer, 0, count)
                }
            } }
        } finally { connection.disconnect() }
        val actual = digest.digest().joinToString("") { "%02x".format(it) }
        if (total != update.sizeBytes || actual != update.sha256) { file.delete(); throw ApiFailure("UPDATE_FAILED") }
        // Never hand the installer a different app, even if the catalog were wrong.
        val archive = context.packageManager.getPackageArchiveInfo(file.path, 0)
        if (archive?.packageName != context.packageName) { file.delete(); throw ApiFailure("UPDATE_FAILED") }
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            file.inputStream().use { input -> session.openWrite("veilbird.apk", 0, file.length()).use { output -> input.copyTo(output); session.fsync(output) } }
            val callback = PendingIntent.getBroadcast(context, id, Intent(context, UpdateInstallReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            session.commit(callback.intentSender)
        }
    }

    private fun get(url: String): JSONObject {
        val connection = URI(url).toURL().openConnection() as HttpsURLConnection
        connection.connectTimeout = 10000; connection.readTimeout = 10000; connection.instanceFollowRedirects = false
        connection.setRequestProperty("Accept", "application/json")
        try {
            if (connection.responseCode != 200) throw ApiFailure("SERVICE_UNAVAILABLE")
            val text = connection.inputStream.use { stream -> val bytes = ByteArray(65537); var size = 0
                while (size < bytes.size) { val count = stream.read(bytes, size, bytes.size - size); if (count < 0) break; size += count }
                if (size > 65536) throw ApiFailure("INVALID_RESPONSE"); String(bytes, 0, size, Charsets.UTF_8) }
            return JSONObject(text)
        } finally { connection.disconnect() }
    }
}

/** Shows the system confirmation when the installer needs it; other outcomes are reported by the system UI. */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE) != PackageInstaller.STATUS_PENDING_USER_ACTION) return
        @Suppress("DEPRECATION")
        val confirm = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)) ?: return
        context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
