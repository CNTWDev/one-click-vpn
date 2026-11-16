package com.veilbird.client

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.os.Build
import android.os.SystemClock
import android.view.View
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The deep-space backdrop behind every page, same recipe as the Portal (portal-web/src/space.tsx) and the other
 * clients: a near-black sky, a pixel Milky Way on a slant over a faint teal and lime nebula, far stars that drift
 * very slowly, a few cross glints, a dithered moon and a dark planet whose lit rim sits at the bottom. Stars are
 * seeded, so the sky is the same on every launch. Redrawn twice a second at most; still when animations are off.
 */
class SpaceView(context: Context) : View(context) {
    private class Star(val x: Float, val y: Float, val size: Float, val color: Int, val alpha: Float, val twinkle: Boolean, val delay: Long)

    private val d = resources.displayMetrics.density
    private val paint = Paint()
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private var band = emptyList<Star>()
    private var far = emptyList<Star>()
    private var dots = FloatArray(0) // x, y, alpha triples: the planet's dithered rim and lit surface
    private var moon = FloatArray(0) // x, y pairs
    private var moonColors = IntArray(0)
    private var sky: Shader? = null
    private var dither: Shader? = null
    private var vignette: Shader? = null
    private var planetBody: Shader? = null
    private var planetGlow: Shader? = null
    private var planetR = 0f
    private var planetX = 0f
    private var planetY = 0f
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
        sky = LinearGradient(0f, 0f, 0f, H, intArrayOf(Color.rgb(1, 2, 2), Color.rgb(3, 6, 5), Color.rgb(5, 10, 8)), floatArrayOf(0f, .5f, 1f), Shader.TileMode.CLAMP)
        val tile = Bitmap.createBitmap(max(3, (3 * d).toInt()), max(3, (3 * d).toInt()), Bitmap.Config.ARGB_8888)
        Canvas(tile).drawCircle(tile.width / 2f, tile.height / 2f, .8f * d, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(153, 1, 3, 2) })
        dither = BitmapShader(tile, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT)
        vignette = RadialGradient(W / 2, H * .42f, hypot(W, H) * .6f, intArrayOf(Color.TRANSPARENT, Color.TRANSPARENT, Color.argb(153, 0, 0, 0)), floatArrayOf(0f, .55f, 1f), Shader.TileMode.CLAMP)

        // Milky Way: stars on a -38° slant through (50%, 34%), normal spread across it.
        val r = random(11); val angle = -38 * PI / 180; val cx = W * .5f; val cy = H * .34f; val list = ArrayList<Star>()
        repeat(260) {
            val along = (r() - .5f) * 1.6f * W
            val across = (sqrt(-2.0 * ln(r() + 1e-9f)) * cos(2 * PI * r())).toFloat() * .07f * W * (1 - abs(along) / W * .35f)
            val x = cx + along * cos(angle).toFloat() - across * sin(angle).toFloat()
            val y = cy + along * sin(angle).toFloat() + across * cos(angle).toFloat()
            val k = r(); val alpha = .12f + r() * .5f
            if (x in 0f..W && y in 0f..H) list.add(Star(x, y, if (k < .8f) d else 2 * d, if (k < .5f) Color.rgb(191, 216, 204) else if (k < .85f) Color.rgb(232, 238, 228) else Palette.accent, alpha, false, 0))
        }
        band = list
        val f = random(7)
        far = List(110) {
            val k = f(); val size = if (k < .72f) 1 else if (k < .97f) 2 else 3
            val x = f() * W; val y = f().pow(1.25f) * H
            val alpha = if (size == 3) .85f else .14f + f() * .5f
            val color = if (size == 3) Palette.accent else if (f() < .12f) Color.rgb(207, 230, 160) else Color.rgb(232, 238, 228)
            Star(x, y, size * d, color, alpha, f() < .14f, (f() * 7000).toLong())
        }

        // Planet: a 1400 dp disc whose top shows the bottom quarter of the window.
        planetR = 700 * d; planetX = W / 2; planetY = H - max(200 * d, H * .26f) + planetR
        val top = planetY - planetR
        planetBody = RadialGradient(planetX, top, 2.24f * planetR, intArrayOf(Color.rgb(16, 29, 22), Color.rgb(7, 16, 12), Color.rgb(3, 6, 5)), floatArrayOf(0f, .18f, .45f), Shader.TileMode.CLAMP)
        val glow = planetR + 70 * d
        planetGlow = RadialGradient(planetX, planetY, glow, intArrayOf(Color.TRANSPARENT, Color.argb(36, 90, 170, 150), Color.TRANSPARENT), floatArrayOf(planetR / glow - .01f, planetR / glow, 1f), Shader.TileMode.CLAMP)
        val step = 6 * d; val out = ArrayList<Float>()
        var y = top - .12f * planetR
        while (y < H) {
            var x = 0f
            while (x < W) {
                val dist = hypot(x - planetX, y - planetY) / planetR
                // Atmosphere: dots from 0.974 R to 1.12 R, brightest at 1.04 R.
                val rim = if (dist in .974f..1.12f) (if (dist < 1.04f) (dist - .974f) / .066f else (1.12f - dist) / .08f) * .5f * .55f else 0f
                // Lit surface: a soft ellipse of dots across the top of the disc.
                val e = ((x - planetX) / planetR).pow(2) + ((y - top) / (.28f * planetR)).pow(2)
                val lit = if (dist < 1f && e < 1f) (1 - e) * .5f * .2f else 0f
                val a = rim + lit
                if (a > .01f) { out.add(x); out.add(y); out.add(a) }
                x += step
            }
            y += step
            if (y > top + .3f * planetR && y > top + 40 * d) break
        }
        dots = out.toFloatArray()

        // Moon: a 22 dp disc of 3 dp dots, lit from the top left.
        val size = 22 * d; val mx = W * .76f; val my = H * .09f; val cell = 3 * d; val m = ArrayList<Float>(); val mc = ArrayList<Int>()
        var yy = 0f
        while (yy < size) {
            var xx = 0f
            while (xx < size) {
                if (hypot(xx + cell / 2 - size / 2, yy + cell / 2 - size / 2) <= size / 2) {
                    val t = (hypot(xx - size * .32f, yy - size * .30f) / (size * .75f)).coerceIn(0f, 1f)
                    val c = if (t < .6f) mix(Color.rgb(201, 216, 180), Color.rgb(110, 127, 99), t / .6f) else mix(Color.rgb(110, 127, 99), Color.rgb(26, 34, 25), (t - .6f) / .4f)
                    m.add(mx + xx); m.add(my + yy); mc.add(c)
                }
                xx += cell
            }
            yy += cell
        }
        moon = m.toFloatArray(); moonColors = mc.toIntArray()
    }

    private fun mix(a: Int, b: Int, t: Float) = Color.rgb(
        (Color.red(a) + (Color.red(b) - Color.red(a)) * t).toInt(),
        (Color.green(a) + (Color.green(b) - Color.green(a)) * t).toInt(),
        (Color.blue(a) + (Color.blue(b) - Color.blue(a)) * t).toInt())

    private fun moving() = Build.VERSION.SDK_INT < 26 || ValueAnimator.areAnimatorsEnabled()

    private fun ellipse(canvas: Canvas, x: Float, y: Float, rx: Float, ry: Float, color: Int) {
        canvas.save(); canvas.translate(x, y); canvas.scale(rx / ry, 1f)
        fill.shader = RadialGradient(0f, 0f, ry, intArrayOf(color, Color.TRANSPARENT), floatArrayOf(0f, .7f), Shader.TileMode.CLAMP)
        canvas.drawCircle(0f, 0f, ry, fill); canvas.restore(); fill.shader = null
    }

    override fun onDraw(canvas: Canvas) {
        val W = width.toFloat(); val H = height.toFloat()
        if (W == 0f) return
        val now = SystemClock.uptimeMillis() - started
        val motion = moving()
        paint.shader = sky; canvas.drawRect(0f, 0f, W, H, paint); paint.shader = null

        // Nebula along the band.
        canvas.save(); canvas.rotate(-38f, W * .5f, H * .34f)
        val bw = 1.5f * W; val bh = .6f * H
        ellipse(canvas, W * .5f - .12f * bw, H * .34f, .30f * bw, .38f * bh, Color.argb(77, 46, 120, 112))
        ellipse(canvas, W * .5f + .12f * bw, H * .34f - .04f * bh, .22f * bw, .30f * bh, Color.argb(41, 140, 190, 80))
        ellipse(canvas, W * .5f, H * .34f, .50f * bw, .20f * bh, Color.argb(18, 150, 200, 180))
        canvas.restore()
        paint.shader = dither; canvas.drawRect(0f, 0f, W, H, paint); paint.shader = null

        for (s in band) { paint.color = Palette.alpha(s.color, (s.alpha * 255).toInt()); canvas.drawRect(s.x, s.y, s.x + s.size, s.y + s.size, paint) }
        // Far stars drift 30 dp down and back over four minutes.
        val drift = if (motion) ((1 - cos(now / 120_000.0 * PI)) / 2).toFloat() * 30 * d - 30 * d else -30 * d
        for (s in far) {
            val dim = motion && s.twinkle && ((now + s.delay) % 7000) > 6580
            paint.color = Palette.alpha(s.color, ((if (dim) .2f else 1f) * s.alpha * 255).toInt())
            canvas.drawRect(s.x, s.y + drift, s.x + s.size, s.y + drift + s.size, paint)
        }
        for ((i, g) in listOf(Triple(.18f, .12f, .9f), Triple(.84f, .38f, .7f), Triple(.09f, .58f, .6f)).withIndex()) {
            val dim = motion && ((now + i * 2300) % 9000) > 8460
            paint.color = Color.argb(((if (dim) .2f else 1f) * g.third * 255).toInt(), 228, 242, 204)
            val x = W * g.first; val y = H * g.second
            canvas.drawRect(x - .5f * d, y - 3.5f * d, x + .5f * d, y + 3.5f * d, paint)
            canvas.drawRect(x - 3.5f * d, y - .5f * d, x + 3.5f * d, y + .5f * d, paint)
            canvas.drawRect(x - 1.5f * d, y - 1.5f * d, x + 1.5f * d, y + 1.5f * d, paint)
        }
        val dot = 2.2f * d
        for (i in moonColors.indices) { paint.color = Palette.alpha(moonColors[i], 178); canvas.drawRect(moon[2 * i], moon[2 * i + 1], moon[2 * i] + dot, moon[2 * i + 1] + dot, paint) }
        paint.shader = vignette; canvas.drawRect(0f, 0f, W, H, paint); paint.shader = null

        // Planet: glow, body, rim line, then the dithered atmosphere and lit surface.
        fill.shader = planetGlow; canvas.drawCircle(planetX, planetY, planetR + 70 * d, fill)
        fill.shader = planetBody; canvas.drawCircle(planetX, planetY, planetR, fill); fill.shader = null
        fill.style = Paint.Style.STROKE; fill.strokeWidth = d; fill.color = Color.argb(140, 200, 232, 140)
        canvas.drawCircle(planetX, planetY, planetR, fill); fill.style = Paint.Style.FILL
        for (i in dots.indices step 3) { paint.color = Palette.alpha(Palette.accent, (dots[i + 2] * 255).toInt()); canvas.drawRect(dots[i], dots[i + 1], dots[i] + 1.4f * d, dots[i + 1] + 1.4f * d, paint) }

        if (motion && isShown) postInvalidateDelayed(500)
    }
}
