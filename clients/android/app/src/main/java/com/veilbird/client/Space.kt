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
 * Behind every page: the warm ground and one soft lamp from above (no frames or corner marks: nothing outlined).
 * The lamp is "being seen": it fades out while connected ([lit] false) and comes back when the connection ends.
 */
class SpaceView(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
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
                intArrayOf(Palette.alpha(Palette.light, (41 * lamp).toInt()), Palette.alpha(Palette.light, (10 * lamp).toInt()), Palette.alpha(Palette.light, 0)),
                floatArrayOf(0f, 0.5f, 1f), Shader.TileMode.CLAMP)
            canvas.drawRect(0f, 0f, w, h * 0.7f, paint); paint.shader = null
        }
    }
}
