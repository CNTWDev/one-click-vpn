package com.veilbird.client

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.provider.OpenableColumns
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.view.View
import java.io.File
import java.text.NumberFormat
import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Time this device spent connected, per UTC day, kept for 90 days. Counted here only (the server knows traffic, not
 * time); the usage page's trail shows it as "hidden here". Ticked by the service's health loop.
 */
object HiddenTime {
    private const val KEY = "hiddenSeconds"
    private var last = 0L
    private var pending = 0.0
    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences("preferences", Context.MODE_PRIVATE)
    private fun day(at: Long) = java.time.Instant.ofEpochMilli(at).atZone(java.time.ZoneOffset.UTC).toLocalDate().toString()
    @Synchronized fun tick(context: Context, connected: Boolean) {
        val now = SystemClock.elapsedRealtime()
        // A gap over two minutes is a paused loop (the phone slept), not two minutes known to be connected.
        if (connected && last > 0) pending += min(120.0, max(0.0, (now - last) / 1000.0))
        last = if (connected) now else 0L
        if (pending >= 60 || (!connected && pending > 0)) flush(context)
    }
    @Synchronized private fun flush(context: Context) {
        if (pending <= 0) return
        val saved = saved(context)
        val today = day(System.currentTimeMillis())
        saved.put(today, saved.optDouble(today, 0.0) + pending); pending = 0.0
        val oldest = day(System.currentTimeMillis() - 91L * 86_400_000)
        val kept = org.json.JSONObject()
        saved.keys().forEach { if (it >= oldest) kept.put(it, saved.optDouble(it, 0.0)) }
        prefs(context).edit().putString(KEY, kept.toString()).apply()
    }
    private fun saved(context: Context) = try { org.json.JSONObject(prefs(context).getString(KEY, "{}") ?: "{}") } catch (_: Exception) { org.json.JSONObject() }
    /** Hours connected over the last [days] days, today included. */
    @Synchronized fun hours(context: Context, days: Int): Double {
        val saved = saved(context)
        val since = day(System.currentTimeMillis() - (days - 1L) * 86_400_000)
        var total = pending
        saved.keys().forEach { if (it >= since) total += saved.optDouble(it, 0.0) }
        return total / 3600
    }
    fun text(hours: Double): String {
        val format = NumberFormat.getNumberInstance(L10n.locale).apply { minimumFractionDigits = 0; maximumFractionDigits = if (hours < 10) 1 else 0 }
        return L10n.text(R.string.trail_hours, format.format(hours))
    }
}

/** One exit on the trail: where it is and its share of the traffic (the busiest is 1). */
data class TrailExit(val spot: Spot, val weight: Double)

/**
 * The trail: every location this account went out from in the range, lit by how much went through it. With the
 * home city, arcs from it; without (the poster's default), rings at the exits only, so nothing points home.
 * Same drawing as the Mac (Trail.swift) and Windows (Trail.cs).
 */
object TrailDraw {
    /** Seen from above the middle of the exits (and home), weighted by traffic. */
    fun centre(exits: List<TrailExit>, home: Spot?): DoubleArray {
        var x = 0.0; var y = 0.0; var z = 0.0
        fun add(s: Spot, w: Double) {
            val p = s.lat * PI / 180; val l = s.lon * PI / 180
            x += w * cos(p) * sin(l); y += w * sin(p); z += w * cos(p) * cos(l)
        }
        exits.forEach { add(it.spot, .3 + it.weight) }
        home?.let { add(it, 1.3) }
        val n = sqrt(x * x + y * y + z * z)
        if (n < 1e-6) return doubleArrayOf(home?.lat ?: 25.0, home?.lon ?: 110.0)
        return doubleArrayOf(min(50.0, max(-35.0, asin(y / n) * 180 / PI)), atan2(x, z) * 180 / PI)
    }
    /** Draws the trail on a globe of [size] pixels centred at (cx, cy); [sphere] is Earth.lattice for the same view. */
    fun draw(canvas: Canvas, cx: Float, cy: Float, size: Float, view: DoubleArray, sphere: Bitmap?, exits: List<TrailExit>, home: Spot?, labels: Boolean, labelPx: Float, bounds: RectF) {
        val radius = size / 2; val u = size / 320f
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        if (sphere != null) { paint.alpha = (255 * .55f).toInt(); canvas.drawBitmap(sphere, null, RectF(cx - radius, cy - radius, cx + radius, cy + radius), paint); paint.alpha = 255 }
        fun screen(p: DoubleArray) = floatArrayOf(cx + (p[0] * radius).toFloat(), cy - (p[1] * radius).toFloat(), if (p[2] > 0 || hypot(p[0], p[1]) > 1) 1f else 0f)
        fun place(s: Spot) = screen(Earth.project(s.lat, s.lon, 0.0, view[0], view[1]))
        val order = exits.sortedBy { it.weight }
        val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
        for (e in order) {
            val end = place(e.spot); if (end[2] == 0f) continue
            val w = e.weight.toFloat()
            if (home != null) {
                val path = arc(home, e.spot, view, cx, cy, radius)
                stroke.strokeWidth = (7 * w + 2) * u; stroke.color = Palette.alpha(Palette.accent, (255 * (.07f + .08f * w)).toInt()); canvas.drawPath(path, stroke)
                stroke.strokeWidth = 1.6f * u; stroke.color = Palette.alpha(Palette.accent, (255 * (.35f + .55f * w)).toInt()); canvas.drawPath(path, stroke)
            } else {
                stroke.strokeWidth = max(1f, u)
                for (i in 1..2) {
                    stroke.color = Palette.alpha(Palette.accent, (255 * (.12f + .3f * w) / i).toInt())
                    canvas.drawCircle(end[0], end[1], (8 + 10 * w) * u * i * 1.3f, stroke)
                }
            }
        }
        for (e in order) {
            val p = place(e.spot); if (p[2] == 0f) continue
            val w = e.weight.toFloat(); val r = (10 + 16 * w) * u
            paint.shader = RadialGradient(p[0], p[1], r, intArrayOf(Palette.alpha(Palette.accent, (255 * (.25f + .4f * w)).toInt()), Palette.alpha(Palette.accent, 0)), null, Shader.TileMode.CLAMP)
            canvas.drawCircle(p[0], p[1], r, paint); paint.shader = null
            val side = max(4f, (4 + 3 * w) * u)
            paint.color = Palette.alpha(Palette.light, (255 * (.6f + .4f * w)).toInt())
            canvas.drawRect(p[0] - side / 2, p[1] - side / 2, p[0] + side / 2, p[1] + side / 2, paint)
        }
        if (home != null) {
            val p = place(home)
            if (p[2] != 0f) {
                stroke.strokeWidth = max(1f, u); stroke.color = Palette.alpha(Palette.text, 102); canvas.drawCircle(p[0], p[1], 8 * u, stroke)
                val side = max(4f, 5 * u); paint.color = Palette.alpha(Palette.text, 242)
                canvas.drawRect(p[0] - side / 2, p[1] - side / 2, p[0] + side / 2, p[1] + side / 2, paint)
            }
        }
        if (!labels) return
        // The busiest visible exits get a name; one that would cover another is left out.
        val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = labelPx; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL); setShadowLayer(3 * u, 0f, 0f, Color.argb(230, 0, 0, 0)) }
        val taken = mutableListOf<RectF>()
        for (e in exits.sortedByDescending { it.weight }.take(4)) {
            val p = place(e.spot); if (p[2] == 0f || e.spot.label.isEmpty()) continue
            val top = e.weight > .9
            label.color = if (top) Palette.accent else Palette.alpha(Palette.text, 191)
            val tw = label.measureText(e.spot.label)
            var x = p[0] + 12 * u
            if (x + tw > bounds.right - 4) x = p[0] - 12 * u - tw
            val rect = RectF(x, p[1] - labelPx * 1.5f, x + tw, p[1] - labelPx * .2f)
            if (taken.any { RectF.intersects(RectF(it.left - 4, it.top - 2, it.right + 4, it.bottom + 2), rect) }) continue
            taken.add(rect)
            canvas.drawText(e.spot.label, x, rect.bottom - labelPx * .2f, label)
        }
    }
    /** A great circle lifted off the ground, flattened until it stays in the frame, cut where it passes behind. */
    private fun arc(a: Spot, b: Spot, view: DoubleArray, cx: Float, cy: Float, radius: Float): Path {
        val w = Earth.angle(a.lat, a.lon, b.lat, b.lon)
        var lift = max(.06, .08 + .28 * w / PI)
        var points = emptyList<FloatArray>()
        for (attempt in 0 until 5) {
            var far = 0.0
            points = (0..80).map { i ->
                val t = i / 80.0
                val gc = Earth.slerp(a.lat, a.lon, b.lat, b.lon, t)
                val p = Earth.project(gc[0], gc[1], lift * sin(PI * t), view[0], view[1])
                far = max(far, hypot(p[0], p[1]))
                floatArrayOf(cx + (p[0] * radius).toFloat(), cy - (p[1] * radius).toFloat(), if (p[2] > 0 || hypot(p[0], p[1]) > 1) 1f else 0f)
            }
            if (far < 1.04) break
            lift *= .7
        }
        val path = Path(); var open = false
        for (q in points) {
            if (q[2] == 0f || hypot(q[0] - cx, q[1] - cy) > radius * .93f) { open = false; continue }
            if (open) path.lineTo(q[0], q[1]) else { path.moveTo(q[0], q[1]); open = true }
        }
        return path
    }
}

/** The trail on the usage page. */
class TrailGlobe(context: Context) : View(context) {
    var exits: List<TrailExit> = emptyList(); set(value) { field = value; invalidate() }
    var home: Spot? = null; set(value) { field = value; invalidate() }
    private var cache: Bitmap? = null
    private var cacheKey = ""
    private val d = resources.displayMetrics.density
    override fun onDetachedFromWindow() { cache?.recycle(); cache = null; cacheKey = ""; super.onDetachedFromWindow() }
    override fun onDraw(canvas: Canvas) {
        val s = min(width, height); if (s <= 0 || exits.isEmpty()) return
        val view = TrailDraw.centre(exits, home)
        val key = "$s ${view[0].toInt()} ${view[1].toInt()} ${Palette.theme}"
        val sphere = cache?.takeIf { key == cacheKey && !it.isRecycled } ?: Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888).also {
            Earth.lattice(it, view[0], view[1]); cache?.recycle(); cache = it; cacheKey = key
        }
        TrailDraw.draw(canvas, width / 2f, height / 2f, s.toFloat(), view, sphere, exits, home, true, 12 * d, RectF(0f, 0f, width.toFloat(), height.toFloat()))
    }
}

/** The shared picture: 1080×1920, no IP and no account; the home city only when the person turns it on. */
object TrailPoster {
    fun render(context: Context, exits: List<TrailExit>, home: Spot?, range: String, stats: List<Pair<String, String>>): Bitmap {
        val w = 1080; val h = 1920; val k = 3f // drawn as a 360×640 page, three pixels to the point
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap); canvas.drawColor(Palette.ground)
        val left = 30 * k; val right = w - 30 * k
        var y = 34 * k
        context.getDrawable(R.drawable.ic_stat_mark)?.mutate()?.apply { setTint(Palette.accent); setBounds(left.toInt(), y.toInt(), (left + 16 * k).toInt(), (y + 16 * k).toInt()); draw(canvas) }
        val pixel = Pixel.font(context)
        val word = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = pixel; textSize = 11 * k; color = Palette.text; letterSpacing = .04f }
        canvas.drawText("TRACKNOTHING", left + 24 * k, y + 12 * k, word)
        y += 16 * k + 14 * k
        val title = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Typeface.create("sans-serif-light", Typeface.NORMAL); textSize = 26 * k; color = Palette.text }
        val layout = StaticLayout.Builder.obtain(L10n.text(R.string.trail_poster_title), 0, L10n.text(R.string.trail_poster_title).length, title, (right - left).toInt())
            .setAlignment(Layout.Alignment.ALIGN_NORMAL).setMaxLines(2).build()
        canvas.save(); canvas.translate(left, y); layout.draw(canvas); canvas.restore()
        y += layout.height + 6 * k
        val small = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12 * k; color = Palette.faint; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL) }
        canvas.drawText(range, left, y + 12 * k, small)
        y += 16 * k + 14 * k
        val globe = 300 * k
        val view = TrailDraw.centre(exits, home)
        val sphere = Bitmap.createBitmap(globe.toInt(), globe.toInt(), Bitmap.Config.ARGB_8888).also { Earth.lattice(it, view[0], view[1]) }
        TrailDraw.draw(canvas, w / 2f, y + globe / 2, globe, view, sphere, exits, home, true, 11 * k, RectF(0f, 0f, w.toFloat(), h.toFloat()))
        sphere.recycle()
        y += globe + 14 * k
        drawStats(canvas, stats, left, right, y, 26 * k, pixel, k)
        val slogan = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 13 * k; color = Palette.secondary }
        canvas.drawText(L10n.text(R.string.trail_poster_slogan), left, h - 34 * k, slogan)
        return bitmap
    }
    /** Three figures side by side: the number in the dot face, its unit small beside it, the name under it. */
    fun drawStats(canvas: Canvas, stats: List<Pair<String, String>>, left: Float, right: Float, top: Float, size: Float, pixel: Typeface, k: Float) {
        val column = (right - left + 12 * k) / stats.size
        val number = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { typeface = pixel; textSize = size }
        val unit = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = size * .5f; color = Palette.secondary; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL) }
        val name = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11 * k; color = Palette.secondary }
        stats.forEachIndexed { i, (value, caption) ->
            val x = left + i * column
            val parts = value.split(' ', limit = 2)
            number.color = if (i == 0) Palette.accent else Palette.text
            canvas.drawText(parts[0], x, top + size, number)
            if (parts.size > 1) canvas.drawText(" " + parts[1], x + number.measureText(parts[0]), top + size, unit)
            canvas.drawText(caption, x, top + size + 4 * k + 11 * k, name)
        }
    }
    /** Writes the poster where PosterProvider serves it and returns its address. */
    fun file(context: Context, bitmap: Bitmap): Uri {
        val dir = File(context.cacheDir, "posters").apply { mkdirs() }
        File(dir, PosterProvider.NAME).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return Uri.parse("content://${context.packageName}.posters/${PosterProvider.NAME}")
    }
    /** Saves to Pictures/TrackNothing (Android 10+, no permission needed); false when it could not. */
    fun save(context: Context, bitmap: Bitmap): Boolean {
        if (android.os.Build.VERSION.SDK_INT < 29) return false
        val values = ContentValues().apply {
            put(android.provider.MediaStore.Images.Media.DISPLAY_NAME, "TrackNothing-${System.currentTimeMillis() / 1000}.png")
            put(android.provider.MediaStore.Images.Media.MIME_TYPE, "image/png")
            put(android.provider.MediaStore.Images.Media.RELATIVE_PATH, "Pictures/TrackNothing")
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return false
        return try { resolver.openOutputStream(uri)?.use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) } == true } catch (_: Exception) { resolver.delete(uri, null, null); false }
    }
}

/** Hands the last poster to the app the person shares it with (read-only, only with the grant on the share). */
class PosterProvider : ContentProvider() {
    companion object { const val NAME = "trail.png" }
    private fun file() = File(File(context!!.cacheDir, "posters"), NAME)
    override fun onCreate() = true
    override fun getType(uri: Uri) = "image/png"
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (uri.lastPathSegment != NAME || mode != "r") throw SecurityException("read only")
        return ParcelFileDescriptor.open(file(), ParcelFileDescriptor.MODE_READ_ONLY)
    }
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns).apply { addRow(columns.map { if (it == OpenableColumns.SIZE) file().length() else if (it == OpenableColumns.DISPLAY_NAME) "TrackNothing.png" else null }) }
    }
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}
