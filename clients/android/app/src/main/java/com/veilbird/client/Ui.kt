package com.veilbird.client

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.view.View
import android.view.animation.LinearInterpolator
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.min

/** The one palette of the app (dark, after the ∅ mark: lime on near-black green). */
object Palette {
    val ground = Color.rgb(10, 13, 18)
    val surface = Color.rgb(18, 22, 29)
    val raised = Color.rgb(27, 32, 41)
    val selected = Color.rgb(38, 44, 54)
    val text = Color.rgb(234, 238, 244)
    val secondary = Color.rgb(164, 173, 187)
    val faint = Color.rgb(133, 142, 156)
    val accent = Color.rgb(198, 242, 110)
    val onAccent = Color.rgb(19, 33, 10)
    val danger = Color.rgb(240, 134, 114)
    val fair = Color.rgb(227, 178, 85)
    val hairline = Color.argb(16, 234, 238, 244)
    fun alpha(color: Int, alpha: Int) = Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color))
}

/**
 * The pixel language shared by every TrackNothing client: the ∅ mark on a 16×16 grid, rings of square dots
 * and the Doto dot-matrix face for figures. Same cells as scripts/brand-icons.py and the other clients.
 */
object Pixel {
    val mark: List<Pair<Int, Int>> = ("14,1 5,2 6,2 7,2 8,2 9,2 10,2 13,2 3,3 4,3 11,3 12,3 2,4 11,4 13,4 2,5 10,5 13,5 1,6 9,6 14,6 1,7 8,7 14,7 " +
        "1,8 7,8 14,8 1,9 6,9 14,9 2,10 5,10 13,10 2,11 4,11 13,11 3,12 4,12 11,12 12,12 2,13 5,13 6,13 7,13 8,13 9,13 10,13 1,14")
        .split(' ').map { cell -> cell.split(',').let { it[0].toInt() to it[1].toInt() } }
    private var face: Typeface? = null
    /** Doto Black (SIL OFL), Latin only: wordmark, timers, totals and country codes. */
    fun font(context: Context): Typeface = face ?: context.resources.getFont(R.font.doto_black).also { face = it }
    /** Cells one cell wide on a circle of [radius] in an [n]×[n] grid, each with its clockwise position from the top (0…1). */
    fun ring(n: Int, radius: Float): List<Triple<Int, Int, Float>> {
        val c = (n - 1) / 2f; val cells = ArrayList<Triple<Int, Int, Float>>()
        for (y in 0 until n) for (x in 0 until n) {
            if (abs(hypot(x - c, y - c) - radius) <= 0.55f) {
                val turn = ((Math.toDegrees(atan2((y - c).toDouble(), (x - c).toDouble())) + 450) % 360 / 360).toFloat()
                cells.add(Triple(x, y, turn))
            }
        }
        return cells
    }
    fun drawMark(canvas: Canvas, paint: Paint, left: Float, top: Float, size: Float, color: Int) {
        val cell = size / 16; val square = cell * 0.86f
        paint.style = Paint.Style.FILL; paint.color = color
        for ((x, y) in mark) canvas.drawRect(left + x * cell, top + y * cell, left + x * cell + square, top + y * cell + square, paint)
    }
}

/** The ∅ mark alone, in one color: headers and sign-in. */
class PixelMark(context: Context) : View(context) {
    var color = Palette.accent
        set(value) { field = value; invalidate() }
    private val paint = Paint()
    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
    override fun onDraw(canvas: Canvas) {
        val size = min(width, height).toFloat()
        Pixel.drawMark(canvas, paint, (width - size) / 2, (height - size) / 2, size, color)
    }
}

/**
 * The connect button: a ring of square dots around the ∅ mark, over a faint halftone glow.
 * Dim when idle, a comet of lit dots turning while connecting (still under reduced motion),
 * every dot lit once connected, and a dark ring with the mark in red after a failure.
 */
class ConnectRing(context: Context) : View(context) {
    enum class State { IDLE, CONNECTING, CONNECTED, FAILED }
    var state = State.IDLE
        set(value) { if (field != value) { field = value; animateSweep(); invalidate() } }
    private val density = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val cells = Pixel.ring(41, 18f)
    private var head = 0f
    private var sweep: ValueAnimator? = null

    override fun onAttachedToWindow() { super.onAttachedToWindow(); animateSweep() }
    override fun onDetachedFromWindow() { sweep?.cancel(); sweep = null; super.onDetachedFromWindow() }
    private fun animateSweep() {
        sweep?.cancel(); sweep = null
        if (state != State.CONNECTING || !isAttachedToWindow || !ValueAnimator.areAnimatorsEnabled()) return
        sweep = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 1600; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
            addUpdateListener { head = it.animatedValue as Float; invalidate() }; start()
        }
    }

    override fun onDraw(canvas: Canvas) {
        val size = min(width, height).toFloat(); val left = (width - size) / 2; val top = (height - size) / 2
        val cell = size / 41; val square = cell * 0.83f
        // Halftone glow: a grid of small dots fading out from the middle.
        val glow = when (state) { State.IDLE -> 40; State.CONNECTING -> 90; State.CONNECTED -> 150; State.FAILED -> 0 }
        if (glow > 0) {
            val step = 6 * density; val cx = width / 2f; val cy = height / 2f; val reach = size * 0.62f
            paint.style = Paint.Style.FILL
            var y = cy % step
            while (y < height) {
                var x = cx % step
                while (x < width) {
                    val fade = 1 - hypot(x - cx, y - cy) / reach
                    if (fade > 0) { paint.color = Palette.alpha(Palette.accent, (glow * min(1f, fade * 1.6f) * 0.35f).toInt()); canvas.drawCircle(x, y, 0.9f * density, paint) }
                    x += step
                }
                y += step
            }
        }
        val animated = sweep != null
        for ((x, y, turn) in cells) {
            paint.color = when (state) {
                State.IDLE -> Color.rgb(34, 40, 50)
                State.FAILED -> Color.rgb(42, 34, 32)
                State.CONNECTED -> Palette.accent
                // A comet: full at its head, fading over the next 38% of the turn.
                State.CONNECTING -> if (!animated) Palette.alpha(Palette.accent, 128) else {
                    val behind = (head - turn + 1) % 1
                    Palette.alpha(Palette.accent, if (behind < 0.38f) (255 - (255 - 31) * behind / 0.38f).toInt() else 31)
                }
            }
            canvas.drawRect(left + x * cell, top + y * cell, left + x * cell + square, top + y * cell + square, paint)
        }
        val mark = when (state) { State.IDLE -> Palette.faint; State.FAILED -> Palette.danger; else -> Palette.accent }
        val markSize = size * 80 / 246
        Pixel.drawMark(canvas, paint, (width - markSize) / 2, (height - markSize) / 2, markSize, mark)
    }
}

/**
 * A line of hex digits that changes a few characters a second while a connection is coming up or carrying
 * traffic: the "data stream" under the ring. Dashes when there is nothing to show or animations are off.
 */
class DataStream(context: Context) : TextView(context) {
    var running = false
        set(value) { if (field != value) { field = value; restart() } }
    private val digits = "0123456789ABCDEF"
    private val random = java.util.Random()
    private val chars = CharArray(19) { if (it % 5 == 4) ' ' else digits[random.nextInt(16)] }
    private val tick = object : Runnable {
        override fun run() {
            repeat(3) { val i = random.nextInt(chars.size); if (chars[i] != ' ') chars[i] = digits[random.nextInt(16)] }
            text = String(chars); postDelayed(this, 1000)
        }
    }
    init {
        typeface = Pixel.font(context); textSize = 15f; letterSpacing = 0.18f; includeFontPadding = false
        gravity = android.view.Gravity.CENTER; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        restart()
    }
    override fun onAttachedToWindow() { super.onAttachedToWindow(); restart() }
    override fun onDetachedFromWindow() { removeCallbacks(tick); super.onDetachedFromWindow() }
    private fun restart() {
        removeCallbacks(tick)
        val live = running && ValueAnimator.areAnimatorsEnabled()
        setTextColor(if (running) Color.rgb(124, 152, 72) else Color.rgb(44, 50, 61))
        text = if (live) String(chars) else "---- ---- ---- ----"
        if (live && isAttachedToWindow) postDelayed(tick, 1000)
    }
}

/** Daily usage as columns of square blocks; the last week is in full accent, today brightest. */
class UsageBars(context: Context) : View(context) {
    var values: List<Long> = emptyList()
        set(value) { field = value; invalidate() }
    /** How many trailing columns are lit (the chosen range); the rest are dimmed. */
    var recent = 7
        set(value) { field = value; invalidate() }
    private val density = resources.displayMetrics.density
    private val paint = Paint()
    override fun onDraw(canvas: Canvas) {
        if (values.isEmpty()) return
        val gap = 3 * density; val count = values.size
        val w = (width - gap * (count - 1)) / count
        val block = 4 * density; val pitch = 6 * density; val rows = maxOf(1, ((height + pitch - block) / pitch).toInt())
        val max = values.max().coerceAtLeast(1)
        values.forEachIndexed { i, v ->
            val lit = if (v <= 0) 1 else maxOf(1, Math.round(rows * v.toFloat() / max))
            paint.color = if (i >= count - recent) Palette.accent else Color.rgb(96, 119, 74)
            val left = i * (w + gap)
            for (r in 0 until lit) canvas.drawRect(left, height - r * pitch - block, left + w, height - r * pitch, paint)
        }
    }
}

/** Three signal bars: how many are lit and in which color says how good a location is. */
class SignalBars(context: Context) : View(context) {
    var level = 0
        set(value) { field = value; invalidate() }
    var color = Palette.accent
        set(value) { field = value; invalidate() }
    private val density = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val bar = RectF()
    override fun onDraw(canvas: Canvas) {
        val w = 3 * density; val gap = (width - 3 * w) / 2
        for (i in 0 until 3) {
            val h = height * (5 + 3.5f * i) / 12
            val left = i * (w + gap)
            bar.set(left, height - h, left + w, height.toFloat())
            paint.color = if (i < level) color else Color.rgb(44, 50, 60)
            canvas.drawRect(bar, paint)
        }
    }
}

/**
 * The last 40 seconds of the connection: download as columns of square dots rising from a hairline, upload as
 * dimmer columns hanging below it. Both scale to the busiest second shown, so the shape stays readable at any speed.
 */
class RateBars(context: Context) : View(context) {
    companion object { const val COUNT = 40 }
    private var down: List<Long> = emptyList()
    private var up: List<Long> = emptyList()
    private val density = resources.displayMetrics.density
    private val paint = Paint()
    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
    fun set(down: List<Long>, up: List<Long>) { this.down = down; this.up = up; invalidate() }
    override fun onDraw(canvas: Canvas) {
        val block = 4 * density; val pitch = 6 * density
        val pitchX = width.toFloat() / COUNT; val w = minOf(block, pitchX - 1 * density)
        val axis = height * 0.64f
        val topRows = maxOf(1, ((axis - 2 * density + pitch - block) / pitch).toInt())
        val bottomRows = maxOf(1, ((height - axis - 2 * density + pitch - block) / pitch).toInt())
        paint.color = Color.rgb(36, 42, 53)
        canvas.drawRect(0f, axis, width.toFloat(), axis + density, paint)
        val max = maxOf(1L, (down + up).maxOrNull() ?: 1L)
        // Newest on the right; an empty start before the first samples.
        val offset = COUNT - down.size
        for (i in down.indices) {
            val left = (offset + i) * pitchX + (pitchX - w) / 2
            val lit = if (down[i] <= 0) 1 else maxOf(1, Math.round(topRows * down[i].toFloat() / max))
            paint.color = Palette.accent
            for (r in 0 until lit) canvas.drawRect(left, axis - 2 * density - r * pitch - block, left + w, axis - 2 * density - r * pitch, paint)
            val litUp = if (up.getOrElse(i) { 0 } <= 0) 0 else maxOf(1, Math.round(bottomRows * up[i].toFloat() / max))
            paint.color = Color.rgb(96, 119, 74)
            for (r in 0 until litUp) canvas.drawRect(left, axis + 3 * density + r * pitch, left + w, axis + 3 * density + r * pitch + block, paint)
        }
    }
}

/** A share of the largest row as square dots: lit for the share, dim for the rest (activity ranking). */
class DotBar(context: Context, private val share: Double, private val color: Int) : View(context) {
    private val density = resources.displayMetrics.density
    private val paint = Paint()
    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
    override fun onDraw(canvas: Canvas) {
        val block = 4 * density; val pitch = 6 * density
        val count = maxOf(1, ((width + pitch - block) / pitch).toInt())
        val lit = if (share <= 0) 0 else maxOf(1, Math.round(count * share.coerceAtMost(1.0)).toInt())
        for (i in 0 until count) {
            paint.color = if (i < lit) color else Color.rgb(27, 32, 41)
            canvas.drawRect(i * pitch, 0f, i * pitch + block, minOf(block, height.toFloat()), paint)
        }
    }
}

/** Traffic per hour of the day, proxied (lime) under direct (dim green), in pixel blocks; the current hour is marked. */
class HourBars(context: Context) : View(context) {
    private var hours: List<Pair<Long, Long>> = emptyList()
    private var now = 0
    private val density = resources.displayMetrics.density
    private val paint = Paint()
    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
    fun set(hours: List<Pair<Long, Long>>, now: Int) { this.hours = hours; this.now = now; invalidate() }
    override fun onDraw(canvas: Canvas) {
        val block = 3 * density; val pitch = 4 * density
        val pitchX = width.toFloat() / 24; val w = minOf(pitchX - 2 * density, 8 * density)
        val rows = maxOf(1, ((height - 4 * density + pitch - block) / pitch).toInt())
        val max = maxOf(1L, hours.maxOfOrNull { it.first + it.second } ?: 1L)
        for (i in 0 until 24) {
            val (p, d) = hours.getOrElse(i) { 0L to 0L }
            val left = i * pitchX + (pitchX - w) / 2
            val total = if (p + d <= 0) 0 else maxOf(1, Math.round(rows * (p + d).toFloat() / max))
            val proxied = if (p <= 0) 0 else maxOf(1, minOf(total, Math.round(total * p.toFloat() / (p + d))))
            val bottom = height - 4 * density
            if (total == 0) { paint.color = Color.rgb(27, 32, 41); canvas.drawRect(left, bottom - block, left + w, bottom, paint) }
            for (r in 0 until total) {
                paint.color = if (r < proxied) Palette.accent else Color.rgb(84, 92, 108)
                canvas.drawRect(left, bottom - r * pitch - block, left + w, bottom - r * pitch, paint)
            }
            if (i == now) { paint.color = Palette.secondary; canvas.drawRect(left, height - 2 * density, left + w, height.toFloat(), paint) }
        }
    }
}
