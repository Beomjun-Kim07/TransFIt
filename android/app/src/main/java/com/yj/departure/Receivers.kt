package com.yj.departure

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.android.gms.location.GeofencingEvent

/**
 * Alarm fired: tell the user it is almost time to leave (with live train information when a boarding
 * station is set), then schedule the next one.
 */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val prefs = Prefs(ctx)
        val plan = Plan(
            arriveMs = intent.getLongExtra("arriveMs", 0),
            departMs = intent.getLongExtra("departMs", 0),
            durationSec = intent.getLongExtra("durationSec", 0),
            samples = intent.getIntExtra("samples", 0),
            basis = runCatching { Basis.valueOf(intent.getStringExtra("basis") ?: "") }.getOrDefault(Basis.FALLBACK),
            delaySec = intent.getLongExtra("delaySec", 0),
        )
        val pending = goAsync()

        fun finish(live: List<String>) {
            if (plan.departMs > 0) {
                val title = if (prefs.leadMin > 0) "${prefs.leadMin}분 뒤 출발하세요" else "지금 출발하세요"
                Notifications.show(ctx, Notifications.ID_DEPART, title, Notifications.departureText(plan, prefs.confidencePct, live))
            }
            Planner.replan(ctx)
            pending.finish()
        }

        val station = prefs.boardStation
        if (plan.departMs <= 0 || station == null || BuildConfig.SEOUL_SUBWAY_KEY.isEmpty()) {
            finish(emptyList())
            return
        }
        // Short timeout: a broadcast receiver only has a few seconds.
        SubwayApi.fetch(station, BuildConfig.SEOUL_SUBWAY_KEY, timeoutMs = 4000) { r ->
            val live = r.getOrNull()?.let { Live.lines(ctx, it, plan.arriveMs) } ?: emptyList()
            finish(live)
        }
    }
}

/** Google Play services reports a geofence crossing here (also when the app is not running). */
class GeofenceReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val event = GeofencingEvent.fromIntent(intent) ?: return
        if (event.hasError()) return
        val now = System.currentTimeMillis()
        event.triggeringGeofences?.forEach { TripRecorder.onGeofence(ctx, it.requestId, event.geofenceTransition, now) }
    }
}

/** After reboot or app update, geofences and alarms are gone; put them back. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        GeofenceHelper.register(ctx)
        Planner.replan(ctx)
    }
}
