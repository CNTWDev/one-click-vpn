package com.veilbird.client

import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View

/**
 * Touch feedback, kept to results and to what the person does by hand: the landing when a connection they started
 * comes up (two soft taps, with the two shock rings on the globe), a heavier one when it fails, a light click on
 * connect/disconnect, a tick when a location or routing mode is picked. Nothing for what happens in the background
 * (reconnects, automatic switches) or for a finished disconnect. View.performHapticFeedback follows the system
 * touch-feedback setting, so there is no setting of our own.
 */
object Haptics {
    fun press(view: View?) { view?.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY) }
    fun tick(view: View?) { view?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) }
    /** [delay] lines the taps up with the globe's shock rings (0 under reduced motion). */
    fun landed(view: View?, delay: Long) {
        view ?: return
        view.postDelayed({ view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP) }, delay)
        view.postDelayed({ view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) }, delay + 250)
    }
    fun failed(view: View?) {
        view ?: return
        view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS)
    }
}
