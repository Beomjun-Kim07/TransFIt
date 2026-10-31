package com.yj.departure

/** Direction of a trip. OUT = home -> destination (the commute we predict), BACK = the way home. */
object Direction {
    const val OUT = "OUT"
    const val BACK = "BACK"
}

/** Where a trip record came from. */
object Source {
    const val AUTO = "auto"     // geofence
    const val MANUAL = "manual" // button
    const val DEMO = "demo"     // sample data for trying the app out
}

/** One recorded trip. endMs == null means the trip is still open (started, not yet arrived). */
data class Trip(
    val id: Long,
    val startMs: Long,
    val endMs: Long?,
    val direction: String,
    val source: String,
    /** When the phone entered the boarding-station circle (null if not recorded). */
    val boardMs: Long? = null,
    /** Map-API (baseline) estimate of the whole trip at the time it was recorded. */
    val expectedSec: Long? = null,
    /** Map-API estimate of the home -> station walk at the time it was recorded. */
    val walkExpectedSec: Long? = null,
) {
    val durationSec: Long? get() = endMs?.let { (it - startMs) / 1000 }

    /** Home -> boarding station (walking). */
    val walkSec: Long? get() = boardMs?.let { (it - startMs) / 1000 }

    /** Boarding station -> destination (waiting + riding + final walk). */
    val restSec: Long?
        get() {
            val e = endMs
            val b = boardMs
            return if (e != null && b != null) (e - b) / 1000 else null
        }
}
