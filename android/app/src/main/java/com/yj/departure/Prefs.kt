package com.yj.departure

import android.content.Context
import java.time.DayOfWeek

/** User settings, stored in SharedPreferences. */
class Prefs(ctx: Context) {
    private val sp = ctx.applicationContext.getSharedPreferences("departure", Context.MODE_PRIVATE)

    private fun getD(key: String): Double? = sp.getString(key, null)?.toDoubleOrNull()
    private fun putD(key: String, v: Double?) = sp.edit().apply { if (v == null) remove(key) else putString(key, v.toString()) }.apply()

    var homeLat: Double? get() = getD("home_lat"); set(v) = putD("home_lat", v)
    var homeLng: Double? get() = getD("home_lng"); set(v) = putD("home_lng", v)
    var destLat: Double? get() = getD("dest_lat"); set(v) = putD("dest_lat", v)
    var destLng: Double? get() = getD("dest_lng"); set(v) = putD("dest_lng", v)

    /** Geofence radius in meters. */
    var radiusM: Int get() = sp.getInt("radius_m", 150); set(v) = sp.edit().putInt("radius_m", v).apply()

    /** Target arrival time as minutes since midnight (default 09:00). */
    var arriveMinute: Int get() = sp.getInt("arrive_min", 9 * 60); set(v) = sp.edit().putInt("arrive_min", v).apply()

    /** Bit i set = DayOfWeek with value (i+1) is active (Mon=bit0 ... Sun=bit6). Default Mon-Fri. */
    var activeDays: Int get() = sp.getInt("active_days", 0b0011111); set(v) = sp.edit().putInt("active_days", v).apply()

    /** "On time in N% of past trips" level, 50..99. */
    var confidencePct: Int get() = sp.getInt("confidence", 90); set(v) = sp.edit().putInt("confidence", v).apply()

    /** Notify this many minutes before the recommended departure time. */
    var leadMin: Int get() = sp.getInt("lead_min", 10); set(v) = sp.edit().putInt("lead_min", v).apply()

    /** Duration assumed while there are too few recorded trips. */
    var fallbackMin: Int get() = sp.getInt("fallback_min", 40); set(v) = sp.edit().putInt("fallback_min", v).apply()

    /** Minimum number of similar trips before personal data replaces the fallback. */
    var minSamples: Int get() = sp.getInt("min_samples", 5); set(v) = sp.edit().putInt("min_samples", v).apply()

    /** The subway station/line/direction the user boards (for real-time arrivals). */
    var boardStation: String? get() = sp.getString("board_station", null); set(v) = sp.edit().putString("board_station", v).apply()
    var boardSubwayId: String? get() = sp.getString("board_subway_id", null); set(v) = sp.edit().putString("board_subway_id", v).apply()
    var boardUpdn: String? get() = sp.getString("board_updn", null); set(v) = sp.edit().putString("board_updn", v).apply()

    /** Boarding station position (found by name via place search) and its geofence radius. */
    var boardLat: Double? get() = getD("board_lat"); set(v) = putD("board_lat", v)
    var boardLng: Double? get() = getD("board_lng"); set(v) = putD("board_lng", v)
    var boardName: String? get() = sp.getString("board_name", null); set(v) = sp.edit().putString("board_name", v).apply()
    var stationRadiusM: Int get() = sp.getInt("station_radius_m", 80); set(v) = sp.edit().putInt("station_radius_m", v).apply()

    /** Cached map-API baselines (seconds; 0 = none). Keys say which coordinates they were computed for. */
    var baselineSec: Long get() = sp.getLong("baseline_sec", 0); set(v) = sp.edit().putLong("baseline_sec", v).apply()
    var baselineSummary: String? get() = sp.getString("baseline_summary", null); set(v) = sp.edit().putString("baseline_summary", v).apply()
    var baselineKey: String? get() = sp.getString("baseline_key", null); set(v) = sp.edit().putString("baseline_key", v).apply()
    var baselineAtMs: Long get() = sp.getLong("baseline_at", 0); set(v) = sp.edit().putLong("baseline_at", v).apply()
    var walkBaselineSec: Long get() = sp.getLong("walk_baseline_sec", 0); set(v) = sp.edit().putLong("walk_baseline_sec", v).apply()
    var walkKey: String? get() = sp.getString("walk_key", null); set(v) = sp.edit().putString("walk_key", v).apply()
    var walkAtMs: Long get() = sp.getLong("walk_at", 0); set(v) = sp.edit().putLong("walk_at", v).apply()

    val baselineOrNull: Long? get() = baselineSec.takeIf { it > 0 }
    val walkBaselineOrNull: Long? get() = walkBaselineSec.takeIf { it > 0 }
    val hasStationPlace: Boolean get() = boardLat != null && boardLng != null

    val hasPlaces: Boolean get() = homeLat != null && homeLng != null && destLat != null && destLng != null

    fun isDayActive(d: DayOfWeek): Boolean = (activeDays shr (d.value - 1)) and 1 == 1

    fun toggleDay(d: DayOfWeek) {
        activeDays = activeDays xor (1 shl (d.value - 1))
    }
}
