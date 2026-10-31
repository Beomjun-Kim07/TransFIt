package com.yj.departure

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices

/** Registers the circles (home, boarding station, destination) with Google Play services. */
object GeofenceHelper {

    private fun pendingIntent(ctx: Context): PendingIntent = PendingIntent.getBroadcast(
        ctx, 2, Intent(ctx, GeofenceReceiver::class.java),
        // Play services fills in the event details, so this one must be MUTABLE.
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
    )

    @SuppressLint("MissingPermission")
    fun register(ctx: Context, onResult: (ok: Boolean, message: String) -> Unit = { _, _ -> }) {
        val prefs = Prefs(ctx)
        val client = LocationServices.getGeofencingClient(ctx)
        client.removeGeofences(pendingIntent(ctx))

        if (!prefs.hasPlaces) return onResult(false, "집과 목적지를 먼저 설정해 주세요.")
        if (!Perms.fineLocation(ctx) || !Perms.backgroundLocation(ctx)) {
            return onResult(false, "위치 권한(‘항상 허용’)이 필요해요.")
        }

        fun circle(id: String, lat: Double, lng: Double, radiusM: Int) = Geofence.Builder()
            .setRequestId(id)
            .setCircularRegion(lat, lng, radiusM.toFloat())
            .setExpirationDuration(Geofence.NEVER_EXPIRE)
            .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER or Geofence.GEOFENCE_TRANSITION_EXIT)
            .build()

        val builder = GeofencingRequest.Builder()
            .setInitialTrigger(0) // don't fire just because we are already inside when registering
            .addGeofence(circle(TripRecorder.HOME, prefs.homeLat!!, prefs.homeLng!!, prefs.radiusM))
            .addGeofence(circle(TripRecorder.DEST, prefs.destLat!!, prefs.destLng!!, prefs.radiusM))
        if (prefs.hasStationPlace) {
            builder.addGeofence(circle(TripRecorder.BOARD, prefs.boardLat!!, prefs.boardLng!!, prefs.stationRadiusM))
        }

        val n = if (prefs.hasStationPlace) 3 else 2
        client.addGeofences(builder.build(), pendingIntent(ctx))
            .addOnSuccessListener { onResult(true, "지오펜스 ${n}개를 등록했어요.") }
            .addOnFailureListener { onResult(false, "등록 실패: ${it.message}") }
    }
}
