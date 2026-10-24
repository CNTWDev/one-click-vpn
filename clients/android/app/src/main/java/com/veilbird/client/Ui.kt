package com.veilbird.client

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.min

/** The one palette of the app (dark, after the ∅ mark: lime on near-black green). */
object Palette {
    val ground = Color.rgb(13, 19, 16)
    val surface = Color.rgb(21, 28, 23)
    val raised = Color.rgb(31, 41, 34)
    val selected = Color.rgb(38, 49, 39)
    val text = Color.rgb(236, 241, 232)
    val secondary = Color.rgb(147, 160, 144)
    val faint = Color.rgb(127, 139, 124)
    val accent = Color.rgb(183, 220, 104)
    val onAccent = Color.rgb(17, 25, 18)
    val danger = Color.rgb(240, 144, 122)
    val fair = Color.rgb(226, 184, 92)
    val hairline = Color.argb(16, 236, 241, 232)
    fun alpha(color: Int, alpha: Int) = Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color))
}

/**
 * The connect button: a ring around a disk with the ∅ mark. While connecting an arc turns around the
 * ring (still under reduced motion); a failure swaps the mark for a retry arrow.
 */
class ConnectRing(context: Context) : View(context) {
    enum class State { IDLE, CONNECTING, CONNECTED, FAILED }
    var state = State.IDLE
        set(value) { if (field != value) { field = value; animateArc(); invalidate() } }
    private val density = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeCap = Paint.Cap.ROUND }
    private val oval = RectF()
    private val arrow = Path()
    private var angle = 0f
    private var spinner: ValueAnimator? = null

    override fun onAttachedToWindow() { super.onAttachedToWindow(); animateArc() }
    override fun onDetachedFromWindow() { spinner?.cancel(); spinner = null; super.onDetachedFromWindow() }
    private fun animateArc() {
        spinner?.cancel(); spinner = null
        if (state != State.CONNECTING || !isAttachedToWindow || !ValueAnimator.areAnimatorsEnabled()) return
        spinner = ValueAnimator.ofFloat(0f, 360f).apply {
            duration = 1600; repeatCount = ValueAnimator.INFINITE; interpolator = LinearInterpolator()
            addUpdateListener { angle = it.animatedValue as Float; invalidate() }; start()
        }
    }
    private fun stroke(color: Int, width: Float) = paint.apply { style = Paint.Style.STROKE; this.color = color; strokeWidth = width * density }

    override fun onDraw(canvas: Canvas) {
        val size = min(width, height).toFloat(); val cx = width / 2f; val cy = height / 2f
        val outer = size / 2 - density; val inner = outer * 176 / 216
        val accent = Palette.accent; val danger = Palette.danger
        // Outer ring
        when (state) {
            State.IDLE -> canvas.drawCircle(cx, cy, outer, stroke(Palette.alpha(Palette.text, 20), 1f))
            State.CONNECTING -> {
                canvas.drawCircle(cx, cy, outer, stroke(Palette.alpha(accent, 36), 1.5f))
                oval.set(cx - outer, cy - outer, cx + outer, cy + outer)
                canvas.drawArc(oval, angle - 90, 64f, false, stroke(accent, 2f))
            }
            State.CONNECTED -> canvas.drawCircle(cx, cy, outer, stroke(Palette.alpha(accent, 56), 1f))
            State.FAILED -> canvas.drawCircle(cx, cy, outer, stroke(Palette.alpha(danger, 51), 1f))
        }
        // Disk and its border
        paint.style = Paint.Style.FILL
        paint.color = when (state) { State.CONNECTED -> Color.rgb(23, 34, 26); State.FAILED -> Color.rgb(27, 23, 21); else -> Palette.surface }
        canvas.drawCircle(cx, cy, inner, paint)
        when (state) {
            State.IDLE -> canvas.drawCircle(cx, cy, inner, stroke(Palette.alpha(Palette.text, 26), 1f))
            State.CONNECTING -> canvas.drawCircle(cx, cy, inner, stroke(Palette.alpha(accent, 46), 1f))
            State.CONNECTED -> canvas.drawCircle(cx, cy, inner - density, stroke(accent, 2f))
            State.FAILED -> canvas.drawCircle(cx, cy, inner - density, stroke(Palette.alpha(danger, 140), 1.5f))
        }
        // The mark: ∅, or a retry arrow after a failure
        val r = inner * 0.18f
        if (state == State.FAILED) {
            stroke(danger, 2.6f)
            oval.set(cx - r, cy - r, cx + r, cy + r)
            canvas.drawArc(oval, 0f, 315f, false, paint)
            arrow.reset()
            arrow.moveTo(cx + 1.07f * r, cy - 1.07f * r); arrow.lineTo(cx + 1.07f * r, cy - 0.57f * r); arrow.lineTo(cx + 0.57f * r, cy - 0.57f * r)
            paint.strokeJoin = Paint.Join.ROUND; canvas.drawPath(arrow, paint)
        } else {
            val color = when (state) { State.IDLE -> Palette.secondary; State.CONNECTING -> Palette.alpha(accent, 180); else -> accent }
            stroke(color, 3.2f)
            canvas.drawCircle(cx, cy, r, paint)
            val d = r * 0.92f
            canvas.drawLine(cx - d, cy + d, cx + d, cy - d, paint)
        }
    }
}

/** Daily usage as thin bars; the last bar (today) is in full accent. */
class UsageBars(context: Context) : View(context) {
    var values: List<Long> = emptyList()
        set(value) { field = value; invalidate() }
    private val density = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val bar = RectF()
    override fun onDraw(canvas: Canvas) {
        if (values.isEmpty()) return
        val gap = 3 * density; val count = values.size
        val w = (width - gap * (count - 1)) / count
        val max = values.max().coerceAtLeast(1)
        values.forEachIndexed { i, v ->
            val h = maxOf(3 * density, height * v.toFloat() / max)
            val left = i * (w + gap)
            bar.set(left, height - h, left + w, height.toFloat())
            paint.color = if (i == count - 1) Palette.accent else Palette.alpha(Palette.accent, 82)
            canvas.drawRoundRect(bar, 2 * density, 2 * density, paint)
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
            paint.color = if (i < level) color else Color.rgb(46, 58, 48)
            canvas.drawRoundRect(bar, density, density, paint)
        }
    }
}
