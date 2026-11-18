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

/**
 * The one palette of the app, shared with the Portal: warm near-black under one lamp, hairlines, and one light colour
 * only for the signal (brand, main action, scan light, "now"). Two looks, chosen in Account → Appearance and the same
 * on every client: "amber" (the default) and "moon", a softer one where the light is pearl to rose.
 */
object Palette {
    /** "amber" or "moon"; set before the first render and on change (MainActivity re-renders). */
    var theme = "amber"
    private val moon get() = theme == "moon"
    val ground get() = if (moon) Color.rgb(10, 8, 9) else Color.rgb(8, 7, 6)
    val surface get() = if (moon) Color.rgb(24, 20, 22) else Color.rgb(23, 21, 19)
    val raised get() = if (moon) Color.rgb(34, 29, 31) else Color.rgb(33, 31, 28)
    val selected get() = if (moon) Color.rgb(48, 41, 44) else Color.rgb(46, 43, 38)
    val text get() = if (moon) Color.rgb(244, 238, 232) else Color.rgb(237, 231, 223)
    val secondary get() = if (moon) Color.rgb(172, 160, 162) else Color.rgb(163, 155, 145)
    val faint get() = if (moon) Color.rgb(152, 138, 142) else Color.rgb(149, 139, 124)
    val accent get() = if (moon) Color.rgb(235, 184, 195) else Color.rgb(224, 164, 88)
    // Buttons are outlined, not filled: text on an "accent" control is the accent itself (see MainActivity.rounded).
    val onAccent get() = accent
    val danger = Color.rgb(240, 103, 90)
    val fair get() = if (moon) Color.rgb(226, 150, 120) else Color.rgb(232, 134, 106)
    /** The lamp, crop marks and sealed dots. */
    val light get() = if (moon) Color.rgb(248, 226, 230) else Color.rgb(255, 214, 160)
    /** Past figures in charts (the accent, dimmed). */
    val past get() = if (moon) Color.rgb(112, 86, 94) else Color.rgb(111, 90, 63)
    val hairline get() = alpha(text, 16)
    /** Card outline: cards are drawn as a hairline on the ground, not as a filled block. */
    val edge get() = alpha(light, 23)
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
            paint.color = if (i >= count - recent) Palette.accent else Palette.past
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
            paint.color = if (i < level) color else Color.rgb(52, 49, 43)
            canvas.drawRect(bar, paint)
        }
    }
}

/**
 * A node's lines (Line 1…4) as small square cells: filled when the line answered (amber when slow), an outline
 * in the danger color when it did not, a dim outline when the node does not offer it, plain while measuring.
 */
class LineCells(context: Context) : View(context) {
    companion object { const val OK = 0; const val SLOW = 1; const val DOWN = 2; const val OFF = 3; const val WAIT = 4 }
    var states: List<Int> = emptyList()
        set(value) { if (field != value) { field = value; invalidate() } }
    var cell = 6f
    var gap = 3f
    private val density = resources.displayMetrics.density
    private val paint = Paint()
    override fun onDraw(canvas: Canvas) {
        if (states.isEmpty()) return
        val size = cell * density; val step = size + gap * density; val stroke = maxOf(1f, density)
        var left = (width - (states.size * step - gap * density)) / 2f
        val top = (height - size) / 2f
        for (state in states) {
            paint.style = if (state == OK || state == SLOW || state == WAIT) Paint.Style.FILL else Paint.Style.STROKE
            paint.strokeWidth = stroke
            paint.color = when (state) { OK -> Palette.accent; SLOW -> Palette.fair; DOWN -> Palette.danger; WAIT -> Color.rgb(45, 42, 37); else -> Color.rgb(68, 63, 57) }
            val inset = if (paint.style == Paint.Style.STROKE) stroke / 2 else 0f
            canvas.drawRect(left + inset, top + inset, left + size - inset, top + size - inset, paint)
            left += step
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
        paint.color = Color.rgb(44, 41, 36)
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
            paint.color = Palette.past
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
            paint.color = if (i < lit) color else Color.rgb(33, 31, 28)
            canvas.drawRect(i * pitch, 0f, i * pitch + block, minOf(block, height.toFloat()), paint)
        }
    }
}

/** Traffic per hour of the day, proxied (amber) under direct (dim green), in pixel blocks; the current hour is marked. */
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
            if (total == 0) { paint.color = Color.rgb(33, 31, 28); canvas.drawRect(left, bottom - block, left + w, bottom, paint) }
            for (r in 0 until total) {
                paint.color = if (r < proxied) Palette.accent else Color.rgb(97, 90, 80)
                canvas.drawRect(left, bottom - r * pitch - block, left + w, bottom - r * pitch, paint)
            }
            if (i == now) { paint.color = Palette.secondary; canvas.drawRect(left, height - 2 * density, left + w, height.toFloat(), paint) }
        }
    }
}
