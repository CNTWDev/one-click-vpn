package com.veilbird.client

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.Typeface
import android.view.View
import android.view.animation.LinearInterpolator
import android.widget.TextView

/**
 * The file language shared by every TrackNothing client and the Portal (portal-web/src/dossier.tsx): one line of a
 * file that can be "sealed". Sealing or unsealing first runs the text through a few frames of random glyphs in amber,
 * then it settles: sealed it is a dim dot matrix of the same width, open it is the plain text. Under reduced motion it
 * switches at once.
 */
class SealedText(context: Context) : TextView(context) {
    private companion object { const val GLYPHS = "01ABCDEF#%/<>*+="; const val FRAMES = 11 }
    private val d = resources.displayMetrics.density
    private val dots = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Palette.alpha(Palette.light, 97) }
    private val random = java.util.Random()
    private var dotAlpha = 0f
    private var runner: Runnable? = null
    private var fade: ValueAnimator? = null
    var value = ""
        set(v) { field = v; if (runner == null) text = v }
    var sealed = false
        private set

    init { typeface = Typeface.MONOSPACE; textSize = 13f; setTextColor(Palette.text); maxLines = 1; includeFontPadding = false }

    /** Seals or opens the line after [delay] ms; [animate] false switches at once (first show, reduced motion). */
    fun seal(on: Boolean, delay: Long = 0, animate: Boolean = true) {
        if (on == sealed && runner == null) return
        sealed = on
        runner?.let { removeCallbacks(it) }; runner = null; fade?.cancel()
        if (!animate || !ValueAnimator.areAnimatorsEnabled()) { text = value; dotAlpha = if (on) 1f else 0f; setTextColor(if (on) Color.TRANSPARENT else Palette.text); invalidate(); return }
        var frame = 0
        val step = object : Runnable {
            override fun run() {
                if (frame == 0 && !on) fadeDots(0f)
                frame++
                if (frame >= FRAMES) {
                    runner = null; text = value
                    if (on) { setTextColor(Color.TRANSPARENT); fadeDots(1f) } else setTextColor(Palette.text)
                    return
                }
                setTextColor(Palette.accent)
                text = String(value.map { c -> if (c == ' ' || c == '·') c else GLYPHS[random.nextInt(GLYPHS.length)] }.toCharArray())
                postDelayed(this, 42)
            }
        }
        runner = step; postDelayed(step, delay)
    }
    private fun fadeDots(target: Float) {
        fade = ValueAnimator.ofFloat(dotAlpha, target).apply { duration = 500; addUpdateListener { dotAlpha = it.animatedValue as Float; invalidate() }; start() }
    }
    override fun onDetachedFromWindow() { runner?.let { removeCallbacks(it) }; runner = null; fade?.cancel(); super.onDetachedFromWindow() }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (dotAlpha <= 0.01f) return
        val w = minOf(paint.measureText(value) + paddingLeft, width.toFloat()); val pitch = 4 * d; val r = 0.85f * d
        dots.alpha = (97 * dotAlpha).toInt()
        var y = paddingTop + 3 * d + pitch / 2
        while (y < height - paddingBottom - 2 * d) {
            var x = paddingLeft + pitch / 2
            while (x < w) { canvas.drawCircle(x, y, r, dots); x += pitch }
            y += pitch
        }
    }
}

/**
 * The connect moment's light: a thin amber line with a soft trail that sweeps down the file when it is sealed and back
 * up when it is opened, over [duration] ms. Invisible at rest.
 */
class ScanLine(context: Context) : View(context) {
    private val d = resources.displayMetrics.density
    private val line = Paint().apply { color = Palette.accent }
    private val glow = Paint(Paint.ANTI_ALIAS_FLAG)
    private val trail = Paint()
    private var y = -1f
    private var down = true
    private var anim: ValueAnimator? = null
    private val trailHeight get() = 70 * d
    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
    // An overlay: it takes the height of what it covers and never asks for more. (View's default takes all of an
    // AT_MOST height, so on a tall screen the file grew to fill the page and pushed the action and the location off it.)
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val h = if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.EXACTLY) MeasureSpec.getSize(heightMeasureSpec) else 0
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), h)
    }
    fun sweep(down: Boolean, duration: Long = 1300) {
        anim?.cancel(); this.down = down
        if (!ValueAnimator.areAnimatorsEnabled() || height == 0) { y = -1f; invalidate(); return }
        anim = ValueAnimator.ofFloat(0f, 1f).apply {
            this.duration = duration; interpolator = LinearInterpolator()
            addUpdateListener { val t = it.animatedValue as Float; y = if (down) t * height else (1 - t) * height; alpha = when { t < 0.12f -> t / 0.12f; t > 0.85f -> (1 - t) / 0.15f; else -> 1f }; invalidate() }
            addListener(object : android.animation.AnimatorListenerAdapter() { override fun onAnimationEnd(animation: android.animation.Animator) { y = -1f; invalidate() } })
            start()
        }
    }
    override fun onDetachedFromWindow() { anim?.cancel(); super.onDetachedFromWindow() }
    override fun onDraw(canvas: Canvas) {
        if (y < 0) return
        val w = width.toFloat(); val a = Palette.accent
        val top = if (down) y - trailHeight else y; val bottom = if (down) y else y + trailHeight
        trail.shader = LinearGradient(0f, top, 0f, bottom,
            if (down) Palette.alpha(a, 0) else Palette.alpha(a, 28), if (down) Palette.alpha(a, 28) else Palette.alpha(a, 0), Shader.TileMode.CLAMP)
        canvas.drawRect(0f, top, w, bottom, trail)
        glow.color = Palette.alpha(a, 60); canvas.drawRect(0f, y - 3 * d, w, y + 3 * d, glow)
        canvas.drawRect(0f, y, w, y + maxOf(1f, d), line)
    }
}

/**
 * The connect page's portrait: what any site can see of this phone, drawn as a sphere of warm light dots (the
 * address, device, time zone and language are written under it). The sphere is the switch: open it carries one
 * line, "tap to hide", and breathes slowly. When the connection starts the dots go dark and a thin amber ring
 * lights in their place, holding the time hidden and the rates; it opens again on disconnect. The same drawing on
 * every client (Apple PortraitView, Windows Portrait).
 */
class Portrait(context: Context) : View(context) {
    private val d = resources.displayMetrics.density
    /** An optional line in the open sphere (none on the home page: the action below says what a tap does). */
    var invite: String = ""
        set(value) { if (field != value) { field = value; invalidate() } }
    /** In the ring once hidden: the time hidden, and the rates under it. */
    var centre: String = ""
        set(value) { if (field != value) { field = value; invalidate() } }
    var sub: String = ""
        set(value) { if (field != value) { field = value; invalidate() } }
    /** Which drawing: the sphere (idle, dimmed after a failure) or, hidden, the ring of the state. */
    var state = LinkState.IDLE
        set(value) { if (field != value) { field = value; invalidate() } }
    /** Lines (transports) of the location, one segment each while switching. */
    var lines = 4
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG)
    private var t = 0f
    private var anim: ValueAnimator? = null
    private var pulse: ValueAnimator? = null
    private var phase = 0f
    private var dots: android.graphics.Bitmap? = null
    private val bitmapPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }
    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES }
    /** Hides (connected or connecting) or shows the portrait; [moving] runs the 1.2 s change. */
    fun set(hidden: Boolean, moving: Boolean) {
        val target = if (hidden) 1f else 0f
        anim?.cancel()
        if (!moving || !ValueAnimator.areAnimatorsEnabled()) { t = target; invalidate(); return }
        anim = ValueAnimator.ofFloat(t, target).apply {
            duration = 1200; interpolator = android.view.animation.PathInterpolator(0.65f, 0f, 0.35f, 1f)
            addUpdateListener { t = it.animatedValue as Float; invalidate() }
            start()
        }
    }
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!ValueAnimator.areAnimatorsEnabled()) return
        pulse = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 3000; repeatCount = ValueAnimator.INFINITE; repeatMode = ValueAnimator.REVERSE
            interpolator = android.view.animation.AccelerateDecelerateInterpolator()
            addUpdateListener { phase = it.animatedValue as Float; invalidate() }
            start()
        }
    }
    override fun onDetachedFromWindow() { anim?.cancel(); pulse?.cancel(); pulse = null; super.onDetachedFromWindow() }
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        // The page gives the sphere the height left over (see MainActivity.home); asked for its own height (the page
        // measuring what it needs), it answers with its smallest, so a very short screen scrolls a little at worst.
        val h = if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.EXACTLY) MeasureSpec.getSize(heightMeasureSpec) else minOf(w, (MIN * d).toInt())
        setMeasuredDimension(w, h)
    }
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { dots?.recycle(); dots = null }
    private companion object { const val MAX = 280; const val MIN = 140 }
    /** The dot sphere, drawn once per size: a halftone of light falling from the upper left. */
    private fun sphere(s: Int): android.graphics.Bitmap {
        dots?.let { return it }
        val bitmap = android.graphics.Bitmap.createBitmap(s, s, android.graphics.Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap); val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        val pitch = s * 6f / 320f; val r = s * 1.15f / 320f; val radius = s / 2f
        val lx = s * 0.42f; val ly = s * 0.34f
        var y = pitch / 2
        while (y < s) {
            var x = pitch / 2
            while (x < s) {
                val inside = Math.hypot((x - radius).toDouble(), (y - radius).toDouble()) <= radius
                if (inside) {
                    val f = (Math.hypot((x - lx).toDouble(), (y - ly).toDouble()) / (s * 0.82)).toFloat()
                    val a = when { f < 0.22f -> 1f - f / 0.22f * 0.15f; f < 0.48f -> 0.85f - (f - 0.22f) / 0.26f * 0.5f; f < 0.66f -> 0.35f - (f - 0.48f) / 0.18f * 0.27f; f < 0.72f -> 0.08f - (f - 0.66f) / 0.06f * 0.08f; else -> 0f }
                    if (a > 0) { paint.color = Palette.alpha(Palette.light, (255 * a).toInt()); canvas.drawCircle(x, y, r, paint) }
                }
                x += pitch
            }
            y += pitch
        }
        dots = bitmap
        return bitmap
    }
    override fun onDraw(canvas: Canvas) {
        // The sphere: as large as the space allows, up to 280dp, centred in it.
        val s = minOf(width, height, (MAX * d).toInt()); if (s <= 0) return
        val cx = width / 2f; val cy = height / 2f
        val left = cx - s / 2f; val top = cy - s / 2f
        val failed = state == LinkState.FAILED
        // The sphere: bright and breathing while visible, dim and still after a failure, nearly dark once hidden.
        bitmapPaint.alpha = (255 * ((if (failed) 0.42f else 0.82f + 0.18f * phase) * (1 - t) + 0.1f * t)).toInt()
        canvas.drawBitmap(sphere(s), left, top, bitmapPaint)
        val accent = Palette.accent
        if (invite.isNotEmpty() && t < 1f) {
            label.typeface = Typeface.DEFAULT; label.textSize = 0.05f * s
            label.color = if (failed) Palette.alpha(Palette.text, (180 * (1 - t)).toInt()) else Palette.alpha(accent, (255 * (1 - t) * (0.75f + 0.25f * phase)).toInt())
            val wide = label.measureText(invite); if (wide > 0.8f * s) label.textSize *= 0.8f * s / wide
            canvas.drawText(invite, cx, cy + label.textSize * 0.35f, label)
        }
        if (t <= 0f) return
        val rr = 0.375f * s
        // One clock for the loops; under reduced motion every loop rests on its first frame.
        val clock = if (ValueAnimator.areAnimatorsEnabled()) android.os.SystemClock.uptimeMillis() / 1000f else 0f
        var small = false; var middle = centre
        when (state) {
            LinkState.CONNECTING -> {
                // A faint track and an arc of light that circles it (1.4 s a turn), its tail fading.
                ring.strokeWidth = 1 * d; ring.color = Palette.alpha(accent, (40 * t).toInt()); canvas.drawCircle(cx, cy, rr, ring)
                val head = if (clock == 0f) 90f else (clock / 1.4f % 1f) * 360f
                for (i in 0 until 24) {
                    ring.strokeWidth = (if (i < 2) 2f else 1.5f) * d; ring.color = Palette.alpha(accent, (255 * t * (1 - i / 24f)).toInt())
                    canvas.drawArc(cx - rr, cy - rr, cx + rr, cy + rr, head - 90f - (i + 1) * 3f, 3.2f, false, ring)
                }
                small = true
            }
            LinkState.SWITCHING -> {
                // One segment per line; the one being tried blinks and moves on every 0.6 s, the ones before it are dimmed.
                val n = maxOf(lines, 2); val current = if (clock == 0f) 0 else (clock / 0.6f).toInt() % n
                val blink = if (clock == 0f) 1f else 0.45f + 0.55f * Math.abs(Math.sin(clock * Math.PI)).toFloat()
                for (i in 0 until n) {
                    val start = 360f * i / n - 90f + 4.5f; val sweep = 360f / n - 9f
                    when {
                        i < current -> { ring.strokeWidth = 1.5f * d; ring.color = Palette.alpha(Palette.fair, (150 * t).toInt()) }
                        i == current -> {
                            ring.strokeWidth = 7 * d; ring.color = Palette.alpha(accent, (46 * blink * t).toInt())
                            canvas.drawArc(cx - rr, cy - rr, cx + rr, cy + rr, start, sweep, false, ring)
                            ring.strokeWidth = 2 * d; ring.color = Palette.alpha(accent, (255 * blink * t).toInt())
                        }
                        else -> { ring.strokeWidth = 1 * d; ring.color = Palette.alpha(accent, (40 * t).toInt()) }
                    }
                    canvas.drawArc(cx - rr, cy - rr, cx + rr, cy + rr, start, sweep, false, ring)
                }
                middle = L10n.text(R.string.switching_centre, L10n.number(current + 1), L10n.number(n))
                small = true
            }
            LinkState.RECONNECTING, LinkState.WAITING -> {
                // A ring of dim square dots: reconnecting, a bright dot with a tail goes round (4 s a turn); offline, it rests.
                val n = 64; val head = if (state == LinkState.RECONNECTING && clock > 0f) ((clock / 4f % 1f) * n).toInt() else -99
                val half = 1.3f * d; dot.style = Paint.Style.FILL
                for (i in 0 until n) {
                    val gap = (head - i + n) % n
                    var a = if (state == LinkState.WAITING) 0.2f else 0.28f
                    if (head >= 0 && gap < 8) a = maxOf(a, 1 - gap / 8f)
                    dot.color = Palette.alpha(accent, (255 * a * t).toInt())
                    val angle = Math.toRadians(360.0 * i / n - 90.0)
                    val x = cx + rr * Math.cos(angle).toFloat(); val y = cy + rr * Math.sin(angle).toFloat()
                    canvas.drawRect(x - half, y - half, x + half, y + half, dot)
                }
            }
            else -> {
                // The ring that takes the sphere's place, with a soft glow.
                val glow = (0.82f + 0.18f * phase) * t
                ring.strokeWidth = 8 * d; ring.color = Palette.alpha(accent, (28 * glow).toInt()); canvas.drawCircle(cx, cy, rr, ring)
                ring.strokeWidth = 3 * d; ring.color = Palette.alpha(accent, (55 * glow).toInt()); canvas.drawCircle(cx, cy, rr, ring)
                ring.strokeWidth = 1 * d; ring.color = Palette.alpha(accent, (255 * glow).toInt()); canvas.drawCircle(cx, cy, rr, ring)
            }
        }
        // Inside: the time hidden (or the countdown) and the rates under it; while connecting, one short line.
        if (middle.isNotEmpty()) {
            label.typeface = Typeface.MONOSPACE; label.textSize = (if (small) 0.044f else 0.072f) * s
            label.color = Palette.alpha(if (small) Palette.secondary else Palette.text, (255 * t).toInt())
            val wide = label.measureText(middle); if (wide > 0.62f * s) label.textSize *= 0.62f * s / wide
            canvas.drawText(middle, cx, cy + if (small) label.textSize * 0.35f else 0f, label)
        }
        if (sub.isNotEmpty() && !small) {
            label.typeface = Typeface.MONOSPACE; label.textSize = 0.036f * s; label.color = Palette.alpha(Palette.secondary, (255 * t).toInt())
            // Long notices (ru) shrink to stay inside the ring.
            val room = 0.62f * s; val wide = label.measureText(sub)
            if (wide > room) label.textSize *= room / wide
            canvas.drawText(sub, cx, cy + 0.08f * s, label)
        }
    }
}
