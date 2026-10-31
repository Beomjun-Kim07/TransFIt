package com.yj.departure

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LiveTest {
    private val now = 1_000_000_000L

    @Test fun picksFirstCatchableTrainAndLatestOnTimeTrain() {
        // etas 2, 6.7, 11.7 min; walk 5 min; station->dest 30 min (27 min ride + 3 min average wait);
        // target = now + 50 min.
        val core = Live.advise(now, listOf(120, 400, 700), walkSec = 300, restSec = 1800, targetMs = now + 3000_000L)
        assertEquals(400, core.boardEtaSec)                       // 120 s is too soon to catch after a 5 min walk
        assertEquals(now + (400 + 1620) * 1000L, core.arriveMs)    // ride = 1800 - 180 = 1620 s
        assertEquals(980L, core.slackSec)                          // 3000 - 2020
        assertEquals(now + (700 - 300) * 1000L, core.leaveByMs)    // latest train 700 s still arrives by 3000 s
    }

    @Test fun noCatchableTrain() {
        val core = Live.advise(now, listOf(100, 200), walkSec = 300, restSec = 1800, targetMs = now + 3000_000L)
        assertNull(core.boardEtaSec)
        assertNull(core.arriveMs)
        assertNull(core.slackSec)
    }

    @Test fun targetCannotBeMet() {
        val core = Live.advise(now, listOf(120, 400), walkSec = 60, restSec = 1800, targetMs = now + 1500_000L)
        assertNull(core.leaveByMs)           // every train arrives after the target
        assertEquals(true, core.slackSec!! < 0) // and leaving now is late
    }

    @Test fun restEstimatePrefersPersonalThenBaselineMinusWalk() {
        val start = 0L
        fun trip(restMin: Int) = Trip(1, start, start + 60 * 60_000L, Direction.OUT, Source.AUTO, boardMs = start + (60 - restMin) * 60_000L)
        val personal = (1..5).map { trip(30 + it) } // rests 31..35 min
        assertEquals(33.0 * 60, Live.restEstimate(personal, 50 * 60L, 10 * 60L, 0.5, minSamples = 5)!!.toDouble(), 1.0)
        assertEquals(40 * 60L, Live.restEstimate(emptyList(), 50 * 60L, 10 * 60L, 0.9, 5))   // 50 - 10
        assertNull(Live.restEstimate(emptyList(), null, null, 0.9, 5))
        assertNull(Live.restEstimate(emptyList(), 50 * 60L, null, 0.9, 5))
    }
}
