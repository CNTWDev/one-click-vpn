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

/** The connect page's four states. */
enum class LinkState { IDLE, CONNECTING, CONNECTED, FAILED }

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
