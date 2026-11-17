package com.veilbird.client

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Build
import android.os.SystemClock
import android.view.View
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The faint star field behind every page, same recipe as the Portal (portal-web/src/space.tsx) and the other
 * clients: the flat ground, a pixel Milky Way on a slant, far stars that drift very slowly and a few cross glints,
 * all at about half strength. No nebula, planet or texture, so the app stays flat like the Console. Stars are
 * seeded, so the sky is the same on every launch. Redrawn twice a second at most; still when animations are off.
 */
class SpaceView(context: Context) : View(context) {
    private companion object { const val STRENGTH = .55f }
    private class Star(val x: Float, val y: Float, val size: Float, val color: Int, val alpha: Float, val twinkle: Boolean, val delay: Long)

    private val d = resources.displayMetrics.density
    private val paint = Paint()
    private var band = emptyList<Star>()
    private var far = emptyList<Star>()
    private val started = SystemClock.uptimeMillis()

    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

    private fun random(seed: Int): () -> Float {
        var a = seed
        return {
            a += 0x6D2B79F5
            var t = (a xor (a ushr 15)) * (1 or a)
            t = (t + ((t xor (t ushr 7)) * (61 or t))) xor t
            ((t xor (t ushr 14)).toLong() and 0xffffffffL).toFloat() / 4294967296f
        }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        if (w == 0 || h == 0) return
        val W = w.toFloat(); val H = h.toFloat()
        // Milky Way: stars on a -38° slant through (50%, 34%), normal spread across it.
        val r = random(11); val angle = -38 * PI / 180; val cx = W * .5f; val cy = H * .34f; val list = ArrayList<Star>()
        repeat(260) {
            val along = (r() - .5f) * 1.6f * W
            val across = (sqrt(-2.0 * ln(r() + 1e-9f)) * cos(2 * PI * r())).toFloat() * .07f * W * (1 - abs(along) / W * .35f)
            val x = cx + along * cos(angle).toFloat() - across * sin(angle).toFloat()
            val y = cy + along * sin(angle).toFloat() + across * cos(angle).toFloat()
            val k = r(); val alpha = .12f + r() * .5f
            if (x in 0f..W && y in 0f..H) list.add(Star(x, y, if (k < .8f) d else 2 * d, if (k < .5f) Color.rgb(191, 203, 230) else if (k < .85f) Color.rgb(232, 236, 244) else Palette.accent, alpha, false, 0))
        }
        band = list
        val f = random(7)
        far = List(110) {
            val k = f(); val size = if (k < .72f) 1 else if (k < .97f) 2 else 3
            val x = f() * W; val y = f().pow(1.25f) * H
            val alpha = if (size == 3) .85f else .14f + f() * .5f
            val color = if (size == 3) Palette.accent else if (f() < .12f) Color.rgb(214, 240, 170) else Color.rgb(232, 236, 244)
            Star(x, y, size * d, color, alpha, f() < .14f, (f() * 7000).toLong())
        }
    }

    private fun moving() = Build.VERSION.SDK_INT < 26 || ValueAnimator.areAnimatorsEnabled()

    override fun onDraw(canvas: Canvas) {
        val W = width.toFloat(); val H = height.toFloat()
        if (W == 0f) return
        val now = SystemClock.uptimeMillis() - started
        val motion = moving()
        canvas.drawColor(Palette.ground)

        for (s in band) { paint.color = Palette.alpha(s.color, (s.alpha * STRENGTH * 255).toInt()); canvas.drawRect(s.x, s.y, s.x + s.size, s.y + s.size, paint) }
        // Far stars drift 30 dp down and back over four minutes.
        val drift = if (motion) ((1 - cos(now / 120_000.0 * PI)) / 2).toFloat() * 30 * d - 30 * d else -30 * d
        for (s in far) {
            val dim = motion && s.twinkle && ((now + s.delay) % 7000) > 6580
            paint.color = Palette.alpha(s.color, ((if (dim) .2f else 1f) * s.alpha * STRENGTH * 255).toInt())
            canvas.drawRect(s.x, s.y + drift, s.x + s.size, s.y + drift + s.size, paint)
        }
        for ((i, g) in listOf(Triple(.18f, .12f, .9f), Triple(.84f, .38f, .7f), Triple(.09f, .58f, .6f)).withIndex()) {
            val dim = motion && ((now + i * 2300) % 9000) > 8460
            paint.color = Color.argb(((if (dim) .2f else 1f) * g.third * STRENGTH * 255).toInt(), 230, 236, 248)
            val x = W * g.first; val y = H * g.second
            canvas.drawRect(x - .5f * d, y - 3.5f * d, x + .5f * d, y + 3.5f * d, paint)
            canvas.drawRect(x - 3.5f * d, y - .5f * d, x + 3.5f * d, y + .5f * d, paint)
            canvas.drawRect(x - 1.5f * d, y - 1.5f * d, x + 1.5f * d, y + 1.5f * d, paint)
        }

        if (motion && isShown) postInvalidateDelayed(500)
    }
}
