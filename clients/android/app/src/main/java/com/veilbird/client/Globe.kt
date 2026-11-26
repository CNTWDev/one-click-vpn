package com.veilbird.client

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.Typeface
import android.os.SystemClock
import android.util.Base64
import android.view.View
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/** A place on the globe, with the name written beside it (may be empty). */
data class Spot(val lat: Double, val lon: Double, val label: String = "")

/**
 * The land and the sums of the route globe, the same on every client (Apple Globe.swift, Windows Globe.cs) and the
 * Portal (portal-web/src/globe.ts): an orthographic view of the earth, great circles between two places, and the
 * halftone light of the old dot sphere.
 */
object Earth {
    private const val R = PI / 180
    /** 360×180 soft land mask (one value per degree) from the 720×360 bits of LandMask. */
    private val mask: FloatArray by lazy {
        val bits = Base64.decode(LandMask.BASE64, Base64.DEFAULT)
        fun bit(i: Int) = (bits[i shr 3].toInt() shr (i and 7)) and 1
        val w = 360; val h = 180; val m = FloatArray(w * h)
        for (y in 0 until h) for (x in 0 until w) {
            var a = 0
            for (dy in 0..1) for (dx in 0..1) a += bit((2 * y + dy) * 720 + 2 * x + dx)
            // Antarctica stays dark: it would only ever show as a smudge at the bottom of the globe.
            m[y * w + x] = if (y >= 152) 0f else a / 4f
        }
        val o = FloatArray(w * h)
        for (y in 0 until h) for (x in 0 until w) {
            var t = 0f; var n = 0
            for (dy in -1..1) { val yy = y + dy; if (yy < 0 || yy >= h) continue; for (dx in -1..1) { t += m[yy * w + (x + dx + w) % w]; n++ } }
            o[y * w + x] = t / n
        }
        o
    }
    fun land(lat: Double, lon: Double): Float {
        var fx = lon + 180 - 0.5; fx = ((fx % 360) + 360) % 360
        val fy = min(179.0, max(0.0, 90 - lat - 0.5))
        val x0 = floor(fx).toInt(); val y0 = floor(fy).toInt(); val x1 = (x0 + 1) % 360; val y1 = min(179, y0 + 1)
        val tx = (fx - x0).toFloat(); val ty = (fy - y0).toFloat(); val m = mask
        return (m[y0 * 360 + x0] * (1 - tx) + m[y0 * 360 + x1] * tx) * (1 - ty) + (m[y1 * 360 + x0] * (1 - tx) + m[y1 * 360 + x1] * tx) * ty
    }
    /** The old sphere's halftone falloff from its light (upper left). */
    fun light(f: Double) = when { f < .22 -> 1 - f / .22 * .15; f < .48 -> .85 - (f - .22) / .26 * .5; f < .66 -> .35 - (f - .48) / .18 * .27; f < .72 -> .08 - (f - .66) / .06 * .08; else -> 0.0 }
    /** Unit-disk position (y up) and depth of a place lifted h radii above the ground, seen from above (vLat, vLon). */
    fun project(lat: Double, lon: Double, h: Double, vLat: Double, vLon: Double): DoubleArray {
        val p = lat * R; val l = lon * R; val p0 = vLat * R; val l0 = vLon * R; val c = cos(p); val k = 1 + h
        return doubleArrayOf(c * sin(l - l0) * k, (cos(p0) * sin(p) - sin(p0) * c * cos(l - l0)) * k, sin(p0) * sin(p) + cos(p0) * c * cos(l - l0))
    }
    /** The place under a unit-disk point. */
    fun unproject(nx: Double, ny: Double, vLat: Double, vLon: Double): DoubleArray {
        val r = hypot(nx, ny); if (r < 1e-9) return doubleArrayOf(vLat, vLon)
        val c = asin(min(1.0, r)); val p0 = vLat * R
        val lat = asin(cos(c) * sin(p0) + ny * sin(c) * cos(p0) / r)
        val lon = vLon * R + atan2(nx * sin(c), r * cos(c) * cos(p0) - ny * sin(c) * sin(p0))
        return doubleArrayOf(lat / R, lon / R)
    }
    private fun vec(lat: Double, lon: Double) = doubleArrayOf(cos(lat * R) * sin(lon * R), sin(lat * R), cos(lat * R) * cos(lon * R))
    fun angle(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
        val a = vec(aLat, aLon); val b = vec(bLat, bLon)
        return acos(max(-1.0, min(1.0, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])))
    }
    /** The point a fraction t of the way along the great circle from a to b. */
    fun slerp(aLat: Double, aLon: Double, bLat: Double, bLon: Double, t: Double): DoubleArray {
        val w = angle(aLat, aLon, bLat, bLon); if (w < 1e-6) return doubleArrayOf(aLat, aLon)
        val a = vec(aLat, aLon); val b = vec(bLat, bLon); val s = sin(w); val k1 = sin((1 - t) * w) / s; val k2 = sin(t * w) / s
        val x = a[0] * k1 + b[0] * k2; val y = a[1] * k1 + b[1] * k2; val z = a[2] * k1 + b[2] * k2
        return doubleArrayOf(asin(y / sqrt(x * x + y * y + z * z)) / R, atan2(x, z) / R)
    }
    /** The earth as the old sphere's dot lattice, drawn into a square bitmap seen from above (vLat, vLon). */
    fun lattice(bitmap: Bitmap, viewLat: Double, viewLon: Double) {
        val s = bitmap.width
        bitmap.eraseColor(0)
        val canvas = Canvas(bitmap); val dot = Paint(Paint.ANTI_ALIAS_FLAG)
        val pitch = s * 6f / 320f; val r = s * 1.15f / 320f; val radius = s / 2.0
        val lx = s * .42; val ly = s * .34; val light = Palette.light
        var y = pitch / 2.0
        while (y < s) {
            var x = pitch / 2.0
            while (x < s) {
                val nx = (x - radius) / radius; val ny = (radius - y) / radius; val dd = nx * nx + ny * ny
                if (dd <= 1) {
                    val z = sqrt(1 - dd); val ll = Earth.unproject(nx, ny, viewLat, viewLon); val land = Earth.land(ll[0], ll[1])
                    val a = Earth.light(hypot(x - lx, y - ly) / (s * .98)); val limb = min(1.0, z / .18)
                    val al = (land * (.3 + .5 * a) + (1 - land) * (.025 + .08 * a)) * limb
                    if (al >= .02) { dot.color = Palette.alpha(light, (255 * min(1.0, al)).toInt()); canvas.drawCircle(x.toFloat(), y.toFloat(), r * (.72f + .32f * land), dot) }
                }
                x += pitch
            }
            y += pitch
        }
    }
    fun km(a: Spot, b: Spot) = angle(a.lat, a.lon, b.lat, b.lon) * 6371
    fun ease(t: Double) = if (t < .5) 4 * t * t * t else 1 - (-2 * t + 2).pow(3) / 2
}

/**
 * The connect page's globe: the old dot sphere, now the earth. Off, it marks where this device is (a light with a
 * slow ripple); connecting, it turns to show both ends and a light runs the arc to the location; connected, the arc
 * stays lit, the location glows, and the time hidden and the rates sit in its lower half. The globe is the backdrop
 * and stays dim; the route is the bright layer. A still globe is one cached bitmap; it is drawn again only while it
 * turns (1.2 s). Small loops (the ripple, a light on the arc every 3 s) run at most 30 frames a second, only while
 * the view is on screen, and not at all under reduced motion. The same drawing on every client and the Portal.
 */
class Portrait(context: Context) : View(context) {
    private val d = resources.displayMetrics.density
    /** An optional line over the globe (none on the home page). */
    var invite: String = ""
        set(value) { if (field != value) { field = value; invalidate() } }
    /** In the lower half: the time hidden (or the countdown, or the phase), and the rates under it. */
    var centre: String = ""
        set(value) { if (field != value) { field = value; invalidate() } }
    var sub: String = ""
        set(value) { if (field != value) { field = value; invalidate() } }
    var state = LinkState.IDLE
        set(value) {
            if (field == value) return
            // Only a connection being made now lands or fails with a touch: not a reconnect in the background.
            val starting = field == LinkState.CONNECTING || field == LinkState.SWITCHING
            if (starting && value == LinkState.CONNECTED && isShown) Haptics.landed(this, if (still) 0L else 600L)
            if (starting && value == LinkState.FAILED && isShown) Haptics.failed(this)
            field = value; stateAt = SystemClock.uptimeMillis(); aim(); invalidate()
        }
    /** Lines (transports) of the location: "line n of N" while switching. */
    var lines = 4
    /** Where this device is (null: unknown or hidden by the person) and the location it goes out from (null: unknown). */
    var origin: Spot? = null
        set(value) { if (field != value) { field = value; aim(); invalidate() } }
    var exit: Spot? = null
        set(value) { if (field != value) { field = value; aim(); invalidate() } }
    /** Written under the location's name, e.g. "1 760 km"; empty without an origin. */
    var distance: String = ""
        set(value) { if (field != value) { field = value; invalidate() } }
    /** The measured path (RouteHops) once connected: the straight arc unfolds into its stops, then a light relays along it. */
    var route: RoutePath? = null
        set(value) { if (field != value) { field = value; invalidate() } }

    private var stateAt = 0L
    private var moving = false
    private var viewLat = 20.0; private var viewLon = 105.0; private var aimed = false
    private var fromLat = 0.0; private var fromLon = 0.0; private var toLat = 0.0; private var toLon = 0.0; private var turnAt = -1L
    private var cache: Bitmap? = null; private var cacheKey = ""
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()
    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES }

    /** Drawn once into a bitmap (the home screen widget): the settled picture, no animation. */
    var settled = false
    private val still get() = settled || !ValueAnimator.areAnimatorsEnabled()
    private val on get() = state != LinkState.IDLE && state != LinkState.FAILED

    /** Connecting or disconnecting; [moving] turns the globe (1.2 s) instead of jumping. */
    fun set(hidden: Boolean, moving: Boolean) { this.moving = moving; aim(); invalidate() }

    /** Where the globe should face: this device when off, both ends (the route in the upper half) when on. */
    private fun aim() {
        val a = origin; val b = exit
        val (lat, lon) = when {
            on && b != null && a != null -> { val m = Earth.slerp(a.lat, a.lon, b.lat, b.lon, .5); val w = Earth.angle(a.lat, a.lon, b.lat, b.lon) * 180 / PI; (m[0] - 8 - w * .12) to m[1] }
            on && b != null -> (b.lat - 12) to (b.lon - 22)
            a != null -> (a.lat - 14) to a.lon
            b != null -> (b.lat - 14) to b.lon
            else -> return
        }
        val tLat = max(-55.0, min(55.0, lat))
        if (!aimed || !moving || still || width == 0) { viewLat = tLat; viewLon = lon; aimed = true; turnAt = -1; return }
        current()
        fromLat = viewLat; fromLon = viewLon
        var dl = lon - viewLon; dl = ((dl + 540) % 360) - 180
        toLat = tLat; toLon = viewLon + dl; turnAt = SystemClock.uptimeMillis()
    }
    /** Moves the view along its turn; true while it is still turning. */
    private fun current(): Boolean {
        if (turnAt < 0) return false
        val k = min(1.0, (SystemClock.uptimeMillis() - turnAt) / (if (on) 1200.0 else 800.0)); val e = Earth.ease(k)
        viewLat = fromLat + (toLat - fromLat) * e; viewLon = fromLon + (toLon - fromLon) * e
        if (k >= 1) turnAt = -1
        return turnAt >= 0
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        // The page gives the globe the height left over (see MainActivity.home); asked for its own height it answers
        // with its smallest, so a very short screen scrolls a little at worst.
        val h = if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.EXACTLY) MeasureSpec.getSize(heightMeasureSpec) else minOf(w, (MIN * d).toInt())
        setMeasuredDimension(w, h)
    }
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { cache?.recycle(); cache = null; cacheKey = "" }
    override fun onDetachedFromWindow() { cache?.recycle(); cache = null; cacheKey = ""; super.onDetachedFromWindow() }
    private companion object { const val MAX = 280; const val MIN = 140; const val STEP = .42 }

    /** The earth as the old sphere's dot lattice: each dot looks up the land under it; drawn once per view and size. */
    private fun sphere(s: Int): Bitmap {
        val key = "$s ${(viewLat * 100).roundToInt()} ${(viewLon * 100).roundToInt()} ${Palette.theme}"
        cache?.let { if (key == cacheKey && !it.isRecycled) return it }
        val bitmap = cache?.takeIf { !it.isRecycled && it.width == s } ?: Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888).also { cache?.recycle() }
        Earth.lattice(bitmap, viewLat, viewLon)
        cache = bitmap; cacheKey = key
        return bitmap
    }

    override fun onDraw(canvas: Canvas) {
        val s = minOf(width, height, (MAX * d).toInt()); if (s <= 0) return
        val now = SystemClock.uptimeMillis()
        val turning = current()
        val cx = width / 2f; val cy = height / 2f; val radius = s / 2f; val u = s / 320f
        val clock = if (still) 0.0 else now / 1000.0
        val since = if (still) 9.0 else (now - stateAt) / 1000.0
        val breath = (.5 - .5 * cos(clock / 3 * PI * 2)).toFloat()
        val st = state; val connected = st == LinkState.CONNECTED
        val busy = st == LinkState.CONNECTING || st == LinkState.SWITCHING
        val lost = st == LinkState.RECONNECTING || st == LinkState.WAITING
        val dim = when { st == LinkState.FAILED -> .42f; lost -> .5f; connected -> .55f; busy -> .6f; else -> .8f + .12f * breath }
        bitmapPaint.alpha = (255 * dim).toInt()
        canvas.drawBitmap(sphere(s), cx - radius, cy - radius, bitmapPaint)
        // A faint rim of light just outside the globe.
        paint.shader = RadialGradient(cx, cy, radius * 1.09f, intArrayOf(Palette.alpha(Palette.light, (11 * dim).toInt()), Palette.alpha(Palette.light, 0)), floatArrayOf(.917f, 1f), Shader.TileMode.CLAMP)
        path.reset(); path.addCircle(cx, cy, radius * 1.09f, Path.Direction.CW); path.addCircle(cx, cy, radius, Path.Direction.CCW)
        canvas.drawPath(path, paint); paint.shader = null

        fun screen(p: DoubleArray) = floatArrayOf(cx + (p[0] * radius).toFloat(), cy - (p[1] * radius).toFloat(), if (p[2] > 0 || hypot(p[0], p[1]) > 1) 1f else 0f)
        val a = origin; val b = exit
        val accent = Palette.accent; val light = Palette.light
        var bScreen: FloatArray? = null
        if (b != null) bScreen = screen(Earth.project(b.lat, b.lon, 0.0, viewLat, viewLon))
        var loops = !still && (st == LinkState.IDLE && a != null || busy || connected || st == LinkState.RECONNECTING)

        // The measured path: from 2.2 s after landing (or when it arrives), the straight arc fades while the path draws in
        // stop by stop; then it stays, a light relaying along it every 3.6 s.
        val hops = route?.takeIf { connected && b != null && it.stops.isNotEmpty() }
        val unfold = hops?.let { if (still) 99.0 else (now - max(it.at, stateAt + 2200)) / 1000.0 } ?: -1.0
        val unfoldEnd = hops?.let { it.stops.size * STEP + .35 } ?: 0.0
        val direct = if (hops == null) 1f else (1 - min(1.0, max(0.0, unfold / unfoldEnd))).toFloat()
        // The route: a dotted great circle lifted off the ground, with a soft glow under its lit part.
        if (on && b != null && direct > 0f) {
            val start = a?.let { doubleArrayOf(it.lat, it.lon) } ?: Earth.unproject(-.97, -.05, viewLat, viewLon)
            val w = Earth.angle(start[0], start[1], b.lat, b.lon)
            var lift = max(.07, .09 + .3 * w / PI)
            var pts = Array(97) { FloatArray(4) }
            for (attempt in 0 until 4) {
                var far = 0.0
                for (i in 0..96) {
                    val t = i / 96.0; val g = Earth.slerp(start[0], start[1], b.lat, b.lon, t)
                    val p = Earth.project(g[0], g[1], lift * sin(PI * t), viewLat, viewLon)
                    val q = screen(p); pts[i] = floatArrayOf(q[0], q[1], q[2], t.toFloat()); far = max(far, hypot(p[0], p[1]))
                }
                if (far < 1.03 || lift < .04) break
                lift *= .7
            }
            val charge = if (connected) (if (still) 1f else min(1f, (since / .7).toFloat())) else 1f
            if (connected || busy) {
                for ((lw, al) in listOf(10 * u to (if (connected) .10f else .05f), 4 * u to (if (connected) .22f else .08f))) {
                    path.reset(); var open = false
                    for (q in pts) { if (q[3] > charge || q[2] < 1f) { open = false; continue }; if (!open) { path.moveTo(q[0], q[1]); open = true } else path.lineTo(q[0], q[1]) }
                    stroke.strokeWidth = lw; stroke.color = Palette.alpha(accent, (255 * al * direct).toInt()); canvas.drawPath(path, stroke)
                }
            }
            val head = when { busy -> (since / 1.4 % 1).toFloat(); st == LinkState.RECONNECTING -> (since / 4 % 1).toFloat(); connected -> (since / 3 % 1).toFloat(); else -> -1f }
            val size = max(2 * d / 1.6f, 2.7f * u); var gap = 0f
            for (i in 1..96) {
                val q = pts[i]; val p = pts[i - 1]; gap += hypot(q[0] - p[0], q[1] - p[1])
                if (gap < 6.4f * u && i != 1) continue
                gap = 0f
                if (q[2] < 1f) continue
                val t = q[3]; val fade = if (a != null) 1f else min(1f, t / .35f)
                var al = when {
                    connected -> { var v = if (t <= charge) 1f else .3f; val g = head - t; if (!still && since > .7 && g >= 0 && g < .14f) v = max(v, 1 - g / .14f * .2f); v }
                    busy -> { var v = .3f; val g = ((head - t) % 1 + 1) % 1; if (!still && g < .28f) v = max(v, 1 - g / .28f); if (still) v = if (t < .55f) .9f else .3f; v }
                    st == LinkState.RECONNECTING -> { var v = .2f; val g = ((head - t) % 1 + 1) % 1; if (!still && g < .12f) v = max(v, 1 - g / .12f); v }
                    else -> .16f
                } * fade * direct
                paint.color = Palette.alpha(if (al > .95f) light else accent, (255 * min(1f, al)).toInt())
                canvas.drawRect(q[0] - size / 2, q[1] - size / 2, q[0] + size / 2, q[1] + size / 2, paint)
            }
            // A soft light at the head: the runner while connecting, the flash crossing on landing, then one every 3 s.
            val at = when { still -> -1f; busy -> head; connected && since < .7 -> (since / .7).toFloat(); connected -> head; else -> -1f }
            if (at >= 0 && (hops == null || since < .7)) { val q = pts[min(96, (at * 96).roundToInt())]; if (q[2] >= 1f) glow(canvas, q[0], q[1], (if (busy) 13 else 16) * u, light, if (connected && since < .7) .9f else .7f) }
        }
        var stopLabels: List<Pair<Spot, FloatArray>> = emptyList()
        var exitLit = 0f
        if (hops != null && b != null && unfold > 0) {
            val ends = listOf(a?.let { doubleArrayOf(it.lat, it.lon) } ?: Earth.unproject(-.97, -.05, viewLat, viewLon)) + hops.stops.map { doubleArrayOf(it.spot.lat, it.spot.lon) } + listOf(doubleArrayOf(b.lat, b.lon))
            // Each stretch as screen points (x, y, visible, t), its length, and when it draws in.
            class Leg(val pts: List<FloatArray>, val len: Float, val faint: Boolean, val from: Float)
            val legs = mutableListOf<Leg>(); var total = 0f
            for (k in 1 until ends.size) {
                val p0 = ends[k - 1]; val p1 = ends[k]; val w = Earth.angle(p0[0], p0[1], p1[0], p1[1])
                val n = max(12, (64 * w / 1.2).roundToInt()); var lift = max(.015, .03 + .2 * w / PI); var pts = listOf<FloatArray>()
                for (attempt in 0 until 4) {
                    var far = 0.0
                    pts = (0..n).map { i -> val t = i.toDouble() / n; val g = Earth.slerp(p0[0], p0[1], p1[0], p1[1], t); val pr = Earth.project(g[0], g[1], lift * sin(PI * t), viewLat, viewLon); far = max(far, hypot(pr[0], pr[1])); val q = screen(pr); floatArrayOf(q[0], q[1], q[2], t.toFloat()) }
                    if (far < 1.03 || lift < .02) break
                    lift *= .7
                }
                var len = 0f; for (i in 1 until pts.size) len += hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
                val faint = if (k - 1 < hops.stops.size) hops.stops[k - 1].faint else hops.exitFaint
                legs.add(Leg(pts, len, faint, total)); total += len
            }
            val steady = unfold > unfoldEnd + .4
            val cycle = if (steady && !still) ((unfold - unfoldEnd - .4) % 3.6) / 2.2 else -1.0
            val runner = if (cycle in 0.0..1.0) Earth.ease(cycle).toFloat() * total else -1f
            val size = max(2 * d / 1.6f, 2.7f * u)
            legs.forEachIndexed { k, leg ->
                val shown = min(1.0, max(0.0, (unfold - k * STEP) / .35)).toFloat(); if (shown <= 0f) return@forEachIndexed
                if (!leg.faint) for ((lw, al) in listOf(9 * u to .09f, 3.5f * u to .2f)) {
                    path.reset(); var open = false
                    for (q in leg.pts) { if (q[3] > shown || q[2] < 1f) { open = false; continue }; if (!open) { path.moveTo(q[0], q[1]); open = true } else path.lineTo(q[0], q[1]) }
                    stroke.strokeWidth = lw; stroke.color = Palette.alpha(accent, (255 * al).toInt()); canvas.drawPath(path, stroke)
                }
                var gap = 0f; var along = 0f
                for (i in 1 until leg.pts.size) {
                    val q = leg.pts[i]; val p = leg.pts[i - 1]; val step = hypot(q[0] - p[0], q[1] - p[1]); gap += step; along += step
                    if (gap < (if (leg.faint) 12f else 6.2f) * u && i != 1) continue
                    gap = 0f
                    if (q[2] < 1f || q[3] > shown) continue
                    val lit = runner >= 0 && leg.from + along <= runner && leg.from + along > runner - 26 * u
                    paint.color = if (lit) light else Palette.alpha(accent, (255 * (if (leg.faint) .3f else .9f)).toInt())
                    canvas.drawRect(q[0] - size / 2, q[1] - size / 2, q[0] + size / 2, q[1] + size / 2, paint)
                }
                if (runner >= leg.from && runner <= leg.from + leg.len && leg.len > 0) { val q = leg.pts[min(leg.pts.size - 1, ((runner - leg.from) / leg.len * (leg.pts.size - 1)).roundToInt())]; if (q[2] >= 1f) glow(canvas, q[0], q[1], 11 * u, light, .6f) }
            }
            // The stops: a small light that pops in with a ring, and brightens as the runner passes.
            val labels = mutableListOf<Pair<Spot, FloatArray>>()
            hops.stops.forEachIndexed { k, stop ->
                val t1 = unfold - (k * STEP + .35); if (t1 < 0) return@forEachIndexed
                val q = screen(Earth.project(stop.spot.lat, stop.spot.lon, 0.0, viewLat, viewLon)); if (q[2] < 1f) return@forEachIndexed
                if (!still && t1 < .8) { val kk = (t1 / .8).toFloat(); stroke.strokeWidth = max(1f, u); stroke.color = Palette.alpha(light, (255 * (1 - kk) * .7f).toInt()); canvas.drawCircle(q[0], q[1], (4 + 16 * Earth.ease(kk.toDouble()).toFloat()) * u, stroke) }
                val near = if (runner >= 0) abs(runner - legs[k + 1].from) else Float.MAX_VALUE; val hl = if (near < 18 * u) 1 - near / (18 * u) else 0f
                glow(canvas, q[0], q[1], (10 + 6 * hl) * u, light, .25f + .45f * hl)
                val sq = max(4f * d / 1.6f, 4.6f * u) * min(1.0, t1 / .25).toFloat(); paint.color = Palette.alpha(light, 242)
                canvas.drawRect(q[0] - sq / 2, q[1] - sq / 2, q[0] + sq / 2, q[1] + sq / 2, paint)
                labels.add(stop.spot to floatArrayOf(q[0], q[1], min(1.0, t1 / .4).toFloat()))
            }
            stopLabels = labels
            if (runner >= 0) { val near = abs(runner - total); if (near < 18 * u) exitLit = 1 - near / (18 * u) }
        }
        // This device: a light with a ripple while visible; a small white mark in a thin ring once hidden.
        if (a != null) {
            val p = screen(Earth.project(a.lat, a.lon, 0.0, viewLat, viewLon))
            if (p[2] >= 1f) {
                if (!on) {
                    val k = if (st == LinkState.FAILED) .5f else 1f
                    stroke.strokeWidth = max(1f, u)
                    if (!still) for (i in 0..1) {
                        val ph = ((clock / 3 + i * .5) % 1).toFloat()
                        stroke.color = Palette.alpha(light, (255 * (1 - ph) * .65f * k).toInt()); canvas.drawCircle(p[0], p[1], (5 + 24 * ph) * u, stroke)
                    } else { stroke.color = Palette.alpha(light, (64 * k).toInt()); canvas.drawCircle(p[0], p[1], 14 * u, stroke) }
                    glow(canvas, p[0], p[1], 14 * u, light, .5f * k)
                    val sq = max(4 * d / 1.6f, 5 * u); paint.color = Palette.alpha(light, (255 * k).toInt())
                    canvas.drawRect(p[0] - sq / 2, p[1] - sq / 2, p[0] + sq / 2, p[1] + sq / 2, paint)
                } else {
                    stroke.strokeWidth = max(1f, u); stroke.color = Palette.alpha(Palette.text, 90); canvas.drawCircle(p[0], p[1], 7 * u, stroke)
                    val sq = max(3.5f * d / 1.6f, 4.2f * u); paint.color = Palette.alpha(Palette.text, 230)
                    canvas.drawRect(p[0] - sq / 2, p[1] - sq / 2, p[0] + sq / 2, p[1] + sq / 2, paint)
                }
            }
        }
        // The location: bright and glowing once connected, with two shock rings as it lands.
        val bs = bScreen
        if (on && bs != null && bs[2] >= 1f || st == LinkState.FAILED && bs != null && bs[2] >= 1f) {
            bs!!
            when {
                st == LinkState.FAILED -> { val sq = max(4f * d / 1.6f, 4.5f * u); paint.color = Palette.alpha(Palette.fair, 230); canvas.drawRect(bs[0] - sq / 2, bs[1] - sq / 2, bs[0] + sq / 2, bs[1] + sq / 2, paint) }
                connected -> {
                    val flare = if (still || since < .6) 0f else 1 - min(1f, ((since - .6) / .8).toFloat())
                    glow(canvas, bs[0], bs[1], (22 + 16 * flare) * u, accent, .4f + .15f * breath + .45f * max(flare, exitLit))
                    if (!still && since > .6 && since < 2.1) for (i in 0..1) {
                        val k = ((since - .6 - i * .25) / 1.2).toFloat(); if (k <= 0 || k >= 1) continue
                        stroke.color = Palette.alpha(accent, (255 * (1 - k) * .85f).toInt()); stroke.strokeWidth = max(1f, 1.6f * u * (1 - k) + .6f)
                        canvas.drawCircle(bs[0], bs[1], (6 + 64 * Earth.ease(k.toDouble()).toFloat()) * u, stroke)
                    }
                    if (since < 2.2) loops = loops || !still
                    val sq = max(6f * d / 1.6f, 7 * u); paint.color = light
                    canvas.drawRect(bs[0] - sq / 2, bs[1] - sq / 2, bs[0] + sq / 2, bs[1] + sq / 2, paint)
                }
                else -> {
                    val blink = if (busy && !still) .45f + .55f * abs(sin(clock * PI * (if (st == LinkState.SWITCHING) 1.6 else 1.0))).toFloat() else if (lost) .4f else .8f
                    val sq = max(4f * d / 1.6f, 4.5f * u); paint.color = Palette.alpha(accent, (255 * blink).toInt())
                    canvas.drawRect(bs[0] - sq / 2, bs[1] - sq / 2, bs[0] + sq / 2, bs[1] + sq / 2, paint)
                }
            }
        }
        // Names: this device's under its light while off; once on, both ends, each on the side away from the other.
        val fs = max(11 * d, 11.5f * u)
        label.setShadowLayer(5 * d / 2, 0f, 0f, Palette.alpha(Palette.ground, 240))
        label.typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
        val aScreen = a?.let { screen(Earth.project(it.lat, it.lon, 0.0, viewLat, viewLon)) }
        if (a != null && aScreen != null && aScreen[2] >= 1f && a.label.isNotEmpty()) {
            if (!on) put(canvas, a.label, aScreen[0], aScreen[1] + 16 * u + fs * .9f, light, if (st == LinkState.FAILED) .5f else .9f, fs * 1.08f, 0)
            else { val left = bs == null || aScreen[0] < bs[0]; put(canvas, a.label, aScreen[0] + (if (left) -9 else 9) * u, aScreen[1] + fs * 1.3f, Palette.secondary, .85f, fs * 1.08f, if (left) 1 else -1) }
        }
        if ((on || st == LinkState.FAILED) && b != null && bs != null && bs[2] >= 1f && b.label.isNotEmpty()) {
            val left = aScreen != null && bs[0] < aScreen[0]; val bx = bs[0] + (if (left) -14 else 14) * u; val side = if (left) 1 else -1
            put(canvas, b.label, bx, bs[1] - fs * .5f, if (connected) accent else if (st == LinkState.FAILED) Palette.fair else Palette.text, if (connected) 1f else .8f, fs * 1.08f, side)
            if (distance.isNotEmpty() && (connected || busy)) { label.typeface = Typeface.MONOSPACE; put(canvas, distance, bx, bs[1] + fs * .85f, Palette.secondary, if (connected) .85f else .55f, fs, side); label.typeface = Typeface.DEFAULT }
        }
        // The stops' names, small and quiet, each skipped where it would crowd an end's name or another stop's.
        if (stopLabels.isNotEmpty()) {
            val taken = mutableListOf<FloatArray>()
            aScreen?.let { taken.add(floatArrayOf(it[0], it[1])) }; bs?.let { taken.add(floatArrayOf(it[0], it[1])) }
            for ((spot, q) in stopLabels) {
                if (spot.label.isEmpty() || taken.any { hypot(it[0] - q[0], it[1] - q[1]) < 3.2f * fs }) continue
                taken.add(floatArrayOf(q[0], q[1]))
                val left = q[0] < cx
                put(canvas, spot.label, q[0] + (if (left) -10 else 10) * u, q[1] - fs * .6f, Palette.secondary, .9f * q[2], fs * 1.02f, if (left) 1 else -1)
            }
        }
        label.clearShadowLayer()
        // The lower half: the time hidden and the rates (connected), the countdown (reconnecting), or one short line.
        val sCenter = when (st) {
            LinkState.SWITCHING -> { val n = max(lines, 2); val current = if (still) 0 else ((clock / .6).toInt() % n); L10n.text(R.string.switching_centre, L10n.number(current + 1), L10n.number(n)) }
            else -> centre
        }
        val small = st == LinkState.CONNECTING || st == LinkState.SWITCHING
        if (sCenter.isNotEmpty() && on) {
            label.textAlign = Paint.Align.CENTER
            label.typeface = if (small) Typeface.MONOSPACE else Pixel.font(context); label.textSize = if (small) max(11 * d, .044f * s) else max(16 * d, .072f * s)
            label.color = if (small) Palette.secondary else Palette.text
            val wide = label.measureText(sCenter); if (wide > .62f * s) label.textSize *= .62f * s / wide
            canvas.drawText(sCenter, cx, cy + radius * (if (small) .47f else .42f), label)
            if (sub.isNotEmpty() && !small) {
                label.typeface = Typeface.MONOSPACE; label.textSize = max(10 * d, .036f * s); label.color = Palette.secondary
                val room = .7f * s; val w = label.measureText(sub); if (w > room) label.textSize *= room / w
                canvas.drawText(sub, cx, cy + radius * .42f + max(16 * d, .072f * s) * .95f, label)
            }
            label.textAlign = Paint.Align.LEFT; label.typeface = Typeface.DEFAULT
        }
        if (invite.isNotEmpty() && !on) {
            label.textAlign = Paint.Align.CENTER; label.textSize = .05f * s; label.color = Palette.alpha(Palette.accent, 220)
            canvas.drawText(invite, cx, cy + radius * .8f, label); label.textAlign = Paint.Align.LEFT
        }
        if (busy || st == LinkState.SWITCHING) loops = loops || !still
        if (turning) postInvalidateOnAnimation()
        else if (loops && isShown) postInvalidateDelayed(33)
    }
    private fun glow(canvas: Canvas, x: Float, y: Float, r: Float, color: Int, alpha: Float) {
        if (r <= 0) return
        paint.shader = RadialGradient(x, y, r, intArrayOf(Palette.alpha(color, (255 * min(1f, alpha)).toInt()), Palette.alpha(color, 0)), null, Shader.TileMode.CLAMP)
        canvas.drawCircle(x, y, r, paint); paint.shader = null
    }
    /** Text kept inside the view; side 0 centres it, 1 ends it at x, -1 starts it at x. */
    private fun put(canvas: Canvas, text: String, x: Float, y: Float, color: Int, alpha: Float, size: Float, side: Int) {
        label.textSize = size; label.color = Palette.alpha(color, (255 * alpha).toInt())
        val w = label.measureText(text)
        var left = when (side) { 0 -> x - w / 2; 1 -> x - w; else -> x }
        left = max(4 * d, min(width - w - 4 * d, left))
        canvas.drawText(text, left, max(size, min(height - size * .3f, y)), label)
    }
}
