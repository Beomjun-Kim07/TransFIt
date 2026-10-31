package com.yj.departure

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

class EstimatorTest {
    private val zone = ZoneId.of("Asia/Seoul")

    private fun ms(y: Int, mo: Int, d: Int, h: Int, mi: Int) =
        LocalDateTime.of(y, mo, d, h, mi).atZone(zone).toInstant().toEpochMilli()

    /** A morning trip (default 08:10) on the given October 2026 day that lasted [min] minutes. */
    private fun trip(id: Long, day: Int, min: Int, startHour: Int = 8, startMin: Int = 10, expectedMin: Int? = null): Trip {
        val start = ms(2026, 10, day, startHour, startMin)
        return Trip(id, start, start + min * 60_000L, Direction.OUT, Source.AUTO, expectedSec = expectedMin?.let { it * 60L })
    }

    // 2026-10-05 is a Monday; 6 = Tue, 7 = Wed, 10 = Sat, 13 = Tue, 19 = Mon, 20 = Tue.

    @Test fun quantileInterpolates() {
        val v = listOf(10L, 20L, 30L, 40L, 50L)
        assertEquals(30.0, Estimator.quantile(v, 0.5), 1e-9)
        assertEquals(46.0, Estimator.quantile(v, 0.9), 1e-9)
        assertEquals(10.0, Estimator.quantile(v, 0.0), 1e-9)
        assertEquals(50.0, Estimator.quantile(v, 1.0), 1e-9)
    }

    @Test fun usesPersonalQuantileWhenEnoughTrips() {
        val days = listOf(5, 6, 7, 8, 9, 12, 13, 14, 15, 16)
        val mins = listOf(40, 42, 44, 46, 48, 50, 52, 54, 56, 58)
        val trips = days.zip(mins).mapIndexed { i, (d, m) -> trip(i.toLong(), d, m) }
        val arrive = ms(2026, 10, 19, 9, 0) // Monday 09:00
        val plan = Estimator.plan(trips, arrive, confidence = 0.9, fallbackSec = 40 * 60, minSamples = 5, zone = zone)
        assertEquals(Basis.PERSONAL, plan.basis)
        assertEquals(10, plan.samples)
        // 90th percentile of 40..58 step 2 (10 values) -> 56.2 min
        assertEquals(56.2 * 60, plan.durationSec.toDouble(), 1.0)
        assertEquals(arrive - plan.durationSec * 1000, plan.departMs)
    }

    @Test fun fallsBackWhenNoBaselineAndTooFewTrips() {
        val trips = listOf(trip(1, 5, 50), trip(2, 6, 52))
        val arrive = ms(2026, 10, 19, 9, 0)
        val plan = Estimator.plan(trips, arrive, 0.9, fallbackSec = 40 * 60, minSamples = 5, zone = zone)
        assertEquals(Basis.FALLBACK, plan.basis)
        assertEquals(40 * 60L, plan.durationSec)
        assertEquals(2, plan.samples)
    }

    @Test fun ignoresJitterAndStaleTrips() {
        val tooShort = trip(1, 5, 1)    // 1 min
        val tooLong = trip(2, 6, 400)   // > 3 h
        val plan = Estimator.plan(listOf(tooShort, tooLong), ms(2026, 10, 19, 9, 0), 0.9, 40 * 60, 1, zone = zone)
        assertEquals(Basis.FALLBACK, plan.basis)
        assertEquals(0, plan.samples)
    }

    @Test fun weekendTripsDoNotInfluenceWeekdayPlan() {
        val sat = trip(1, 10, 20)  // Saturday, 20 min
        val plan = Estimator.plan(listOf(sat), ms(2026, 10, 19, 9, 0), 0.9, 40 * 60, 1, zone = zone)
        assertEquals(Basis.FALLBACK, plan.basis)
    }

    @Test fun onTimeProbabilityCountsTripsThatFit() {
        val days = listOf(5, 6, 7, 8, 9, 12, 13, 14, 15, 16)
        val mins = listOf(40, 42, 44, 46, 48, 50, 52, 54, 56, 58)
        val trips = days.zip(mins).mapIndexed { i, (d, m) -> trip(i.toLong(), d, m) }
        val arrive = ms(2026, 10, 19, 9, 0)
        val depart = arrive - 50 * 60_000L // 08:10 -> 50 min available
        val p = Estimator.onTimeProbability(trips, depart, arrive, minSamples = 5, zone = zone)
        assertNotNull(p)
        assertEquals(0.6, p!!, 1e-9) // 40,42,44,46,48,50 fit -> 6/10
        assertNull(Estimator.onTimeProbability(trips.take(2), depart, arrive, 5, zone))
    }

    // ---- baseline + congestion -------------------------------------------------------------

    @Test fun usesMapBaselineWhenTripsAreFewAndNotSlow() {
        val trips = listOf(trip(1, 5, 46, expectedMin = 45), trip(2, 6, 47, expectedMin = 45))
        val arrive = ms(2026, 10, 19, 9, 0)
        val plan = Estimator.plan(trips, arrive, 0.9, 40 * 60, 5, baselineSec = 45 * 60L, zone = zone)
        assertEquals(Basis.BASELINE, plan.basis)
        assertEquals(45 * 60L, plan.durationSec)
        assertEquals(0L, plan.delaySec)
    }

    @Test fun repeatedSlowSlotAddsItsDelay() {
        // Two different Tuesdays (Oct 6, 13) at 08:10 took 60 min while the map expected 45 min.
        val trips = listOf(trip(1, 6, 60, expectedMin = 45), trip(2, 13, 60, expectedMin = 45))
        val arrive = ms(2026, 10, 20, 9, 0) // Tuesday 09:00
        val plan = Estimator.plan(trips, arrive, 0.9, 40 * 60, 5, baselineSec = 45 * 60L, zone = zone)
        assertEquals(Basis.CONGESTION, plan.basis)
        assertEquals(15 * 60L, plan.delaySec)
        assertEquals(60 * 60L, plan.durationSec)
        assertEquals(arrive - 60 * 60_000L, plan.departMs)
    }

    @Test fun aSingleSlowDayIsNotCongestion() {
        val trips = listOf(trip(1, 6, 70, expectedMin = 45)) // e.g. a holiday rush, once
        val arrive = ms(2026, 10, 20, 9, 0)
        val plan = Estimator.plan(trips, arrive, 0.9, 40 * 60, 5, baselineSec = 45 * 60L, zone = zone)
        assertEquals(Basis.BASELINE, plan.basis)
    }

    @Test fun slowOnDifferentWeekdaysDoesNotRepeat() {
        val trips = listOf(trip(1, 6, 60, expectedMin = 45), trip(2, 7, 60, expectedMin = 45)) // Tue, Wed
        val arrive = ms(2026, 10, 20, 9, 0)
        val plan = Estimator.plan(trips, arrive, 0.9, 40 * 60, 5, baselineSec = 45 * 60L, zone = zone)
        assertEquals(Basis.BASELINE, plan.basis)
    }
}
