package com.yj.departure

import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale

/** One measured trip (or leg): what actually happened vs. what the map API expected at the time. */
data class Obs(val startMs: Long, val actualSec: Long, val expectedSec: Long)

/** A weekday + 30-minute window of the day, e.g. "Tuesday 08:00-08:30". */
data class Slot(val dow: Int, val bucket: Int)

data class SlotInfo(
    val slot: Slot,
    /** Observations in this slot. */
    val n: Int,
    /** On how many different calendar dates the trip was clearly slower than expected. */
    val slowDates: Int,
    /** Typical extra time (seconds) on the slow days. */
    val medianDelaySec: Long,
    /** True only when the slowness repeated (see [Congestion.analyze]). */
    val flagged: Boolean,
)

/**
 * "Suspected congestion" detection.
 *
 * A slot is flagged when the trip was clearly slower than the map API expected on at least
 * [MIN_REPEATS] different dates *and* on at least half of the observations in that slot.
 * One slow day (a holiday rush, an accident) never flags a slot by itself.
 */
object Congestion {
    const val BUCKET_MIN = 30
    const val MIN_REPEATS = 2

    /** "Clearly slower" = at least this many seconds... */
    const val SLOW_ABS_SEC = 5 * 60L
    /** ...and at least this fraction of the expected time (whichever is larger). */
    const val SLOW_RATIO = 0.15

    fun slotOf(ms: Long, zone: ZoneId = ZoneId.systemDefault()): Slot {
        val z = Instant.ofEpochMilli(ms).atZone(zone)
        return Slot(z.dayOfWeek.value, (z.hour * 60 + z.minute) / BUCKET_MIN)
    }

    fun median(values: List<Long>): Long {
        val s = values.sorted()
        return if (s.size % 2 == 1) s[s.size / 2] else (s[s.size / 2 - 1] + s[s.size / 2]) / 2
    }

    fun analyze(
        obs: List<Obs>,
        absSec: Long = SLOW_ABS_SEC,
        ratio: Double = SLOW_RATIO,
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<SlotInfo> = obs.groupBy { slotOf(it.startMs, zone) }.map { (slot, list) ->
        val slow = list.filter { (it.actualSec - it.expectedSec) >= maxOf(absSec.toDouble(), ratio * it.expectedSec) }
        val slowDates = slow.map { Instant.ofEpochMilli(it.startMs).atZone(zone).toLocalDate() }.distinct().size
        val flagged = slowDates >= MIN_REPEATS && slow.size * 2 >= list.size
        val delay = if (slow.isEmpty()) 0L else median(slow.map { it.actualSec - it.expectedSec })
        SlotInfo(slot, list.size, slowDates, delay, flagged)
    }.sortedBy { it.slot.dow * 100 + it.slot.bucket }

    /** Human-readable slot, e.g. "화 08:00~08:30". */
    fun label(slot: Slot): String {
        val day = DayOfWeek.of(slot.dow).getDisplayName(TextStyle.SHORT, Locale.KOREAN)
        val start = slot.bucket * BUCKET_MIN
        val end = start + BUCKET_MIN
        fun hm(m: Int) = "%02d:%02d".format(m / 60, m % 60) // the last slot of the day ends at 24:00
        return "$day ${hm(start)}~${hm(end)}"
    }
}
