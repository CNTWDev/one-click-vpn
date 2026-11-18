package com.veilbird.client

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.view.View
import android.view.animation.DecelerateInterpolator

/**
 * Behind every page, same as the Portal (portal-web/src/space.tsx) and the other clients: the warm ground, one soft
 * lamp from above and four crop marks at the corners, as if each page were a sheet in a file. The lamp is "being
 * seen": it fades out while connected ([lit] false) and comes back when the connection ends.
 */
class SpaceView(context: Context) : View(context) {
    private val d = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val marks = Paint().apply { color = Color.argb(66, 255, 214, 160); strokeWidth = maxOf(1f, d) }
    private var lamp = 1f
    private var fade: ValueAnimator? = null
    var lit = true
        set(value) {
            if (field == value) return
            field = value; fade?.cancel()
            val target = if (value) 1f else 0f
            if (!isAttachedToWindow || !ValueAnimator.areAnimatorsEnabled()) { lamp = target; invalidate(); return }
            fade = ValueAnimator.ofFloat(lamp, target).apply {
                duration = 1600; interpolator = DecelerateInterpolator()
                addUpdateListener { lamp = it.animatedValue as Float; invalidate() }; start()
            }
        }
    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
    override fun onDetachedFromWindow() { fade?.cancel(); fade = null; super.onDetachedFromWindow() }

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(Palette.ground)
        val w = width.toFloat(); val h = height.toFloat()
        if (lamp > 0.01f) {
            val radius = maxOf(w, h * 0.6f)
            paint.shader = RadialGradient(w / 2, -h * 0.06f, radius,
                intArrayOf(Color.argb((41 * lamp).toInt(), 255, 214, 160), Color.argb((10 * lamp).toInt(), 255, 214, 160), Color.argb(0, 255, 214, 160)),
                floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP)
            canvas.drawRect(0f, 0f, w, h * 0.7f, paint); paint.shader = null
        }
        // Crop marks clear of the status and navigation bars.
        val insets = rootWindowInsets
        @Suppress("DEPRECATION") val top = (insets?.systemWindowInsetTop ?: 0) + 10 * d
        @Suppress("DEPRECATION") val bottom = h - (insets?.systemWindowInsetBottom ?: 0) - 10 * d
        val left = 10 * d; val right = w - 10 * d; val l = 12 * d
        canvas.drawLine(left, top, left + l, top, marks); canvas.drawLine(left, top, left, top + l, marks)
        canvas.drawLine(right, top, right - l, top, marks); canvas.drawLine(right, top, right, top + l, marks)
        canvas.drawLine(left, bottom, left + l, bottom, marks); canvas.drawLine(left, bottom, left, bottom - l, marks)
        canvas.drawLine(right, bottom, right - l, bottom, marks); canvas.drawLine(right, bottom, right, bottom - l, marks)
    }
}
