package com.yj.departure

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

class WalkingTest {
    private val zone = ZoneId.of("Asia/Seoul")

    private fun ms(day: Int, h: Int, m: Int) =
        LocalDateTime.of(2026, 10, day, h, m).atZone(zone).toInstant().toEpochMilli()

    /** Trip leaving home at [h]:[m] on Oct [day], reaching the station after [walkMin] minutes. */
    private fun trip(day: Int, h: Int, m: Int, walkMin: Int): Trip {
        val start = ms(day, h, m)
        return Trip(day.toLong() * 100 + h, start, start + 50 * 60_000L, Direction.OUT, Source.AUTO, boardMs = start + walkMin * 60_000L)
    }

    private val default = 10 * 60L

    @Test fun usesDefaultWhenNothingIsKnown() {
        val e = Walking.estimate(emptyList(), ms(20, 8, 10), null, default, zone)
        assertEquals(Walking.Basis.DEFAULT, e.basis)
        assertEquals(default, e.sec)
    }

    @Test fun usesMapWhenNoPersonalWalks() {
        val e = Walking.estimate(emptyList(), ms(20, 8, 10), mapSec = 15 * 60L, defaultSec = default, zone = zone)
        assertEquals(Walking.Basis.MAP, e.basis)
        assertEquals(15 * 60L, e.sec)
    }

    @Test fun oneWalkIsNotEnough() {
        val e = Walking.estimate(listOf(trip(6, 8, 10, 9)), ms(20, 8, 10), 15 * 60L, default, zone)
        assertEquals(Walking.Basis.MAP, e.basis)
    }

    @Test fun personalMedianWithTwoOrMoreWalks() {
        // Tue 08:10 (9 min) and Wed 17:00 (13 min): different slots -> overall median 11 min
        val trips = listOf(trip(6, 8, 10, 9), trip(7, 17, 0, 13))
        val e = Walking.estimate(trips, ms(20, 8, 10), 15 * 60L, default, zone)
        assertEquals(Walking.Basis.PERSONAL, e.basis)
        assertEquals(11 * 60L, e.sec)
    }

    @Test fun sameSlotRepeatsOverrideTheOverallMedian() {
        // Tuesdays 08:05 and 08:20 were slow (14, 16 min); a Wednesday was quick (8 min).
        val trips = listOf(trip(6, 8, 5, 14), trip(13, 8, 20, 16), trip(7, 8, 10, 8))
        val e = Walking.estimate(trips, ms(20, 8, 10), 15 * 60L, default, zone) // asking about a Tuesday 08:10
        assertEquals(Walking.Basis.SLOT, e.basis)
        assertEquals(2, e.n)
        assertEquals(15 * 60L, e.sec)
    }

    @Test fun implausibleWalksAreIgnored() {
        val start = ms(6, 8, 10)
        val bad = Trip(1, start, start + 50 * 60_000L, Direction.OUT, Source.AUTO, boardMs = start + 5_000L) // 5 s
        val e = Walking.estimate(listOf(bad, bad.copy(id = 2)), ms(20, 8, 10), null, default, zone)
        assertEquals(Walking.Basis.DEFAULT, e.basis)
    }
}
