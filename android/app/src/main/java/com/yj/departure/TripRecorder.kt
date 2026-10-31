package com.yj.departure

import android.content.Context
import com.google.android.gms.location.Geofence

/** The one place that turns "left home / reached the station / reached school" events into trip records. */
object TripRecorder {
    const val HOME = "home"
    const val BOARD = "board"
    const val DEST = "dest"

    fun start(ctx: Context, direction: String, source: String, nowMs: Long = System.currentTimeMillis()) {
        val db = Db.get(ctx)
        val open = db.openTrip(direction)
        // Keep an existing recent open trip (geofence can report EXIT twice); drop stale ones.
        if (open != null && (nowMs - open.startMs) / 1000 <= Estimator.MAX_VALID_SEC) return
        db.discardOpen(direction)
        val walkExpected = if (direction == Direction.OUT) Prefs(ctx).walkBaselineOrNull else null
        db.startTrip(nowMs, direction, source, walkExpected)
    }

    /** Returns the finished trip's duration in seconds, or null if nothing valid was recorded. */
    fun finish(ctx: Context, direction: String, nowMs: Long = System.currentTimeMillis()): Long? {
        val db = Db.get(ctx)
        val open = db.openTrip(direction) ?: return null
        val sec = (nowMs - open.startMs) / 1000
        if (sec < Estimator.MIN_VALID_SEC || sec > Estimator.MAX_VALID_SEC) {
            db.deleteTrip(open.id)   // jitter or stale: not a real trip
            return null
        }
        // Remember what the map API expected right now, to detect repeated slowdowns later.
        val expected = if (direction == Direction.OUT) Prefs(ctx).baselineOrNull else null
        db.finishTrip(open.id, nowMs, expected)
        Planner.replan(ctx)           // new data -> new estimate
        return sec
    }

    /** Reaction to a geofence crossing. [transition] is Geofence.GEOFENCE_TRANSITION_*. */
    fun onGeofence(ctx: Context, placeId: String, transition: Int, nowMs: Long = System.currentTimeMillis()) {
        val db = Db.get(ctx)
        when {
            placeId == HOME && transition == Geofence.GEOFENCE_TRANSITION_EXIT ->
                start(ctx, Direction.OUT, Source.AUTO, nowMs)

            // Reached the boarding station while on the way out: this gives the personal walking time.
            placeId == BOARD && transition == Geofence.GEOFENCE_TRANSITION_ENTER -> {
                val open = db.openTrip(Direction.OUT)
                if (open != null && open.boardMs == null && (nowMs - open.startMs) / 1000 <= Estimator.MAX_VALID_SEC) {
                    db.markBoard(open.id, nowMs)
                }
            }

            placeId == DEST && transition == Geofence.GEOFENCE_TRANSITION_ENTER -> {
                val sec = finish(ctx, Direction.OUT, nowMs)
                if (sec != null) {
                    Notifications.show(ctx, Notifications.ID_RECORDED, "도착 기록됨", "이동 ${sec / 60}분이 기록됐어요.")
                }
            }

            placeId == DEST && transition == Geofence.GEOFENCE_TRANSITION_EXIT ->
                start(ctx, Direction.BACK, Source.AUTO, nowMs)

            placeId == HOME && transition == Geofence.GEOFENCE_TRANSITION_ENTER -> {
                finish(ctx, Direction.BACK, nowMs)
                db.discardOpen(Direction.OUT)   // came back home without reaching the destination
            }
        }
    }
}
