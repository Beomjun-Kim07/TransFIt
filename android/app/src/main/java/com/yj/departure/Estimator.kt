package com.yj.departure

import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.min

/** What the recommended duration is based on, best evidence first. */
enum class Basis {
    /** Quantile of enough similar past trips (same kind of day, similar time of day). */
    PERSONAL,
    /** Map-API baseline plus a repeated, time-of-day-specific slowdown learned from the user's trips. */
    CONGESTION,
    /** Map-API baseline only (too few personal trips). */
    BASELINE,
    /** The user's fixed fallback duration (no personal data and no map baseline). */
    FALLBACK,
}

/** A recommendation: leave at [departMs] to arrive by [arriveMs]. */
data class Plan(
    val arriveMs: Long,
    val departMs: Long,
    /** The duration used (seconds). */
    val durationSec: Long,
    /** Number of past trips the estimate looked at. */
    val samples: Int,
    val basis: Basis,
    /** Extra time added for suspected congestion (seconds); 0 unless [basis] is CONGESTION. */
    val delaySec: Long = 0,
)

/**
 * Turns past trip durations into a departure time.
 *
 *   departure = target arrival - duration
 *
 * duration is, in order of preference:
 *  1. PERSONAL  - the p-quantile of similar past trips, if there are at least `minSamples` of them;
 *  2. CONGESTION/BASELINE - the map-API baseline, plus the typical delay of this weekday + 30-minute slot
 *     if that slot was repeatedly slower than the baseline (see [Congestion]);
 *  3. FALLBACK - the user's fixed default.
 */
object Estimator {
    const val MIN_VALID_SEC = 3 * 60L          // shorter = geofence jitter, not a trip
    const val MAX_VALID_SEC = 3 * 3600L        // longer = forgotten/stale record
    const val WINDOW_MIN = 90                  // "similar time of day" = within +-90 min

    private data class Sample(val minuteOfDay: Int, val weekend: Boolean, val sec: Long)

    /** Linear-interpolated quantile of [values]; p in [0, 1]. */
    fun quantile(values: List<Long>, p: Double): Double {
        require(values.isNotEmpty()) { "no values" }
        val s = values.sorted()
        if (s.size == 1) return s[0].toDouble()
        val pos = p.coerceIn(0.0, 1.0) * (s.size - 1)
        val lo = floor(pos).toInt()
        val hi = min(lo + 1, s.size - 1)
        return s[lo] + (s[hi] - s[lo]) * (pos - lo)
    }

    private fun samples(trips: List<Trip>, zone: ZoneId): List<Sample> = trips.mapNotNull { t ->
        if (t.direction != Direction.OUT) return@mapNotNull null
        val d = t.durationSec ?: return@mapNotNull null
        if (d !in MIN_VALID_SEC..MAX_VALID_SEC) return@mapNotNull null
        val z = Instant.ofEpochMilli(t.startMs).atZone(zone)
        Sample(z.hour * 60 + z.minute, isWeekend(z.dayOfWeek), d)
    }

    private fun isWeekend(d: DayOfWeek) = d == DayOfWeek.SATURDAY || d == DayOfWeek.SUNDAY

    private fun circular(a: Int, b: Int): Int {
        val d = abs(a - b)
        return min(d, 1440 - d)
    }

    /** Same day type, and near the given departure time of day if that leaves enough samples. */
    private fun select(all: List<Sample>, weekend: Boolean, departMinute: Int, minSamples: Int): List<Sample> {
        val dayType = all.filter { it.weekend == weekend }
        val near = dayType.filter { circular(it.minuteOfDay, departMinute) <= WINDOW_MIN }
        return if (near.size >= minSamples) near else dayType
    }

    fun plan(
        trips: List<Trip>,
        arriveMs: Long,
        confidence: Double,
        fallbackSec: Long,
        minSamples: Int,
        baselineSec: Long? = null,
        zone: ZoneId = ZoneId.systemDefault(),
    ): Plan {
        val all = samples(trips, zone)
        val weekend = isWeekend(Instant.ofEpochMilli(arriveMs).atZone(zone).dayOfWeek)

        // 1. Personal: the departure time decides which samples are "similar", and the samples decide the
        // departure time. Break the loop by starting from the median and iterating a few times.
        val dayTypeSecs = all.filter { it.weekend == weekend }.map { it.sec }
        var guess = if (dayTypeSecs.isEmpty()) fallbackSec else quantile(dayTypeSecs, 0.5).toLong()
        var chosen: List<Sample> = emptyList()
        repeat(3) {
            val dep = Instant.ofEpochMilli(arriveMs - guess * 1000).atZone(zone)
            chosen = select(all, weekend, dep.hour * 60 + dep.minute, minSamples)
            if (chosen.size >= minSamples) guess = quantile(chosen.map { it.sec }, confidence).toLong()
        }
        if (chosen.size >= minSamples) {
            return Plan(arriveMs, arriveMs - guess * 1000, guess, chosen.size, Basis.PERSONAL)
        }

        // 2. Baseline (+ repeated slowdown of this weekday/time slot).
        if (baselineSec != null) {
            val base: Long = baselineSec
            val obs = trips.mapNotNull { t ->
                if (t.direction != Direction.OUT) return@mapNotNull null
                val d = t.durationSec ?: return@mapNotNull null
                val e = t.expectedSec ?: return@mapNotNull null
                if (d !in MIN_VALID_SEC..MAX_VALID_SEC) return@mapNotNull null
                Obs(t.startMs, d, e)
            }
            val infos = Congestion.analyze(obs, zone = zone).associateBy { it.slot }
            var dur: Long = base
            var info: SlotInfo? = null
            repeat(3) {
                info = infos[Congestion.slotOf(arriveMs - dur * 1000, zone)]
                dur = base + (info?.takeIf { it.flagged }?.medianDelaySec ?: 0L)
            }
            val flagged = info?.takeIf { it.flagged }
            return Plan(
                arriveMs, arriveMs - dur * 1000, dur, info?.n ?: 0,
                if (flagged != null) Basis.CONGESTION else Basis.BASELINE,
                flagged?.medianDelaySec ?: 0L,
            )
        }

        // 3. Fallback.
        return Plan(arriveMs, arriveMs - fallbackSec * 1000, fallbackSec, chosen.size, Basis.FALLBACK)
    }

    /**
     * Chance of arriving by [arriveMs] if leaving at [departMs], from similar past trips.
     * Returns null when there are too few trips to say.
     */
    fun onTimeProbability(
        trips: List<Trip>,
        departMs: Long,
        arriveMs: Long,
        minSamples: Int,
        zone: ZoneId = ZoneId.systemDefault(),
    ): Double? {
        val all = samples(trips, zone)
        val arriveZ = Instant.ofEpochMilli(arriveMs).atZone(zone)
        val dep = Instant.ofEpochMilli(departMs).atZone(zone)
        val chosen = select(all, isWeekend(arriveZ.dayOfWeek), dep.hour * 60 + dep.minute, minSamples)
        if (chosen.size < minSamples) return null
        val available = (arriveMs - departMs) / 1000
        return chosen.count { it.sec <= available }.toDouble() / chosen.size
    }
}
