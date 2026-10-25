package com.veilbird.client

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.provider.Settings
import com.veilbird.core.Core
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URLEncoder
import java.util.UUID

/** A newer build. `urls` (a CDN mirror) are tried first, then `path` on every API origin the app knows. */
class UpdateInfo(val version: String, val build: Int, val sha256: String, val sizeBytes: Long, val mandatory: Boolean,
                 val notes: String, val urls: List<String>, val path: String)
class ReleaseStatus(val update: UpdateInfo?, val announcement: String)
/** The core's download progress (clients/core/download.go). `seconds` is -1 until the rate has settled. */
class DownloadState(val state: String, val received: Long, val size: Long, val seconds: Long, val source: String, val error: String, val detail: String) {
    companion object {
        fun parse(text: String) = JSONObject(text).let {
            DownloadState(it.optString("state"), it.optLong("received"), it.optLong("size"), it.optLong("seconds", -1), it.optString("source"), it.optString("error"), it.optString("detail"))
        }
    }
}

/**
 * Self-update for directly distributed APKs: the Controller's release catalog says which build is current,
 * the core downloads it (CDN first, then the API origins, resuming a broken transfer) and checks its published
 * SHA-256, and the system installer (which also enforces the same signing key) installs it.
 */
class Updater(private val context: Context, private val api: NativeApi) {
    private val prefs = context.getSharedPreferences("veilbird", Context.MODE_PRIVATE)
    private val folder get() = File(context.cacheDir, "updates").apply { mkdirs() }

    /** Stable random id: places this install in a staged-rollout bucket, nothing more. */
    val installation: String get() = prefs.getString("installation", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("installation", it).apply() }

    /** arm64 phones get the arm64 APK (one copy of the core); everything else the universal one. */
    private val arch get() = if (Build.SUPPORTED_ABIS.firstOrNull() == "arm64-v8a") "arm64" else "universal"

    /** When the release catalog last answered: the app checks again after a few hours in the foreground. */
    var checkedAt: Long
        get() = prefs.getLong("update_checked_at", 0)
        private set(value) { prefs.edit().putLong("update_checked_at", value).apply() }

    /** Newest build for this install (staged rollouts included) plus the operator's announcement. */
    fun check(): ReleaseStatus? {
        if (api.origin.isEmpty()) return null
        val query = "platform=android&arch=$arch&build=${BuildConfig.VERSION_CODE}&installation=${URLEncoder.encode(installation, "UTF-8")}"
        val data = api.get("/api/v1/client-releases/latest?$query")
        checkedAt = System.currentTimeMillis()
        val latest = data.optJSONObject("latest")
        val update = if (BuildConfig.SELF_UPDATE && latest != null && data.optBoolean("updateAvailable") && latest.optString("distribution") == "direct") {
            // Servers before the download mirror send only the release URL.
            val downloads = data.optJSONObject("downloads")
            val urls = downloads?.optJSONArray("urls")?.let { list -> (0 until list.length()).map { list.optString(it) }.filter { it.startsWith("https://") } } ?: listOf(latest.getString("url"))
            UpdateInfo(latest.getString("version"), latest.getInt("build"), latest.getString("sha256"), latest.getLong("sizeBytes"), data.optBoolean("mandatory"),
                latest.optString("notes", "").take(400), urls, downloads?.optString("path", "").orEmpty())
        } else null
        return ReleaseStatus(update, data.optString("announcement", "").take(500))
    }

    /** A "later" on the banner hides that build for three days; a newer build shows again at once. */
    fun dismissed(update: UpdateInfo) = !update.mandatory && prefs.getInt("update_dismissed_build", 0) == update.build &&
        System.currentTimeMillis() - prefs.getLong("update_dismissed_at", 0) < 3 * 86_400_000L
    fun dismiss(update: UpdateInfo) { prefs.edit().putInt("update_dismissed_build", update.build).putLong("update_dismissed_at", System.currentTimeMillis()).apply() }

    /** False when the user must first allow installs from this app in system settings. */
    fun canInstall() = context.packageManager.canRequestPackageInstalls()
    fun installPermissionIntent() = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun file(update: UpdateInfo) = File(folder, "veilbird-${update.build}.apk")
    /** The verified APK of this build, when an earlier download already finished. */
    fun downloaded(update: UpdateInfo) = file(update).takeIf { it.isFile && it.length() == update.sizeBytes }

    /** Blocks until the download ends; the UI reads progress() meanwhile. A partial file of the same build resumes. */
    fun download(update: UpdateInfo): DownloadState {
        // Other builds' files (finished or partial) are stale.
        folder.listFiles()?.filter { !it.name.startsWith("veilbird-${update.build}.apk") }?.forEach { it.delete() }
        val request = JSONObject().put("urls", JSONArray(update.urls)).put("origins", JSONArray(api.origins())).put("path", update.path)
            .put("file", file(update).path).put("sha256", update.sha256).put("size", update.sizeBytes)
        Journal.add("update: download ${update.version}+${update.build} (${update.sizeBytes / 1024} KB, ${if (update.urls.isEmpty()) "server" else "mirror first"})")
        val result = DownloadState.parse(Core.download(api.home, request.toString()))
        Journal.add("update: ${result.state}${if (result.source.isNotEmpty()) " via ${result.source}" else ""}${if (result.error.isNotEmpty()) " (${result.error}${if (result.detail.isNotEmpty()) ": " + Journal.scrub(result.detail) else ""})" else ""}")
        if (result.state == "failed") api.report("UPDATE_DOWNLOAD_FAILED", detail = "${update.build} ${result.error} ${Journal.scrub(result.detail)}".trim().take(200))
        return result
    }
    fun progress(): DownloadState = DownloadState.parse(Core.downloadProgress())
    fun cancel() = Core.cancelDownload()

    /** Hands the verified APK to the system installer. Throws ApiFailure("UPDATE_PACKAGE") for a different app. */
    fun install(update: UpdateInfo, reconnect: Boolean) {
        val file = downloaded(update) ?: throw ApiFailure("UPDATE_FAILED")
        // Never hand the installer a different app, even if the catalog were wrong.
        val archive = context.packageManager.getPackageArchiveInfo(file.path, 0)
        if (archive?.packageName != context.packageName) { file.delete(); Journal.add("update: package ${archive?.packageName ?: "unreadable"}"); throw ApiFailure("UPDATE_PACKAGE") }
        // Installing replaces the running app and its VPN: the new version reconnects (UpdatedReceiver).
        prefs.edit().putBoolean("reconnect_after_update", reconnect).apply()
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
        Journal.add("update: handed ${update.build} to the installer")
    }
}

/** Shows the system confirmation when the installer needs it and journals a refusal (e.g. a different signing key). */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status != PackageInstaller.STATUS_PENDING_USER_ACTION) {
            if (status != PackageInstaller.STATUS_SUCCESS) {
                Journal.add("update: installer status $status ${Journal.scrub(intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))}")
                context.getSharedPreferences("veilbird", Context.MODE_PRIVATE).edit().putBoolean("reconnect_after_update", false).apply()
            }
            return
        }
        @Suppress("DEPRECATION")
        val confirm = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)) ?: return
        context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

/** After an update replaced the app, reconnects when the VPN was on before the install. */
class UpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val prefs = context.getSharedPreferences("veilbird", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("reconnect_after_update", false)) return
        prefs.edit().putBoolean("reconnect_after_update", false).apply()
        Journal.add("update: installed ${BuildConfig.VERSION_NAME}+${BuildConfig.VERSION_CODE}, reconnecting")
        // VPN consent survives an update; without it there is nothing to start from the background.
        if (VpnService.prepare(context) != null) return
        try { context.startForegroundService(Intent(context, ConnectionService::class.java)) } catch (e: Exception) { Journal.add("update: reconnect failed (${e.javaClass.simpleName})") }
    }
}
