package com.yj.departure

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

class CongestionTest {
    private val zone = ZoneId.of("Asia/Seoul")

    private fun ms(day: Int, h: Int, m: Int) =
        LocalDateTime.of(2026, 10, day, h, m).atZone(zone).toInstant().toEpochMilli()

    /** Observation on Oct [day] 2026 at [h]:[m] taking [actualMin] where [expectedMin] was expected. */
    private fun obs(day: Int, h: Int, m: Int, actualMin: Int, expectedMin: Int = 45) =
        Obs(ms(day, h, m), actualMin * 60L, expectedMin * 60L)

    @Test fun twoSlowDatesInTheSameSlotAreFlagged() {
        // Tuesdays Oct 6 and 13, 08:05 and 08:20 -> same 08:00-08:30 slot.
        val infos = Congestion.analyze(listOf(obs(6, 8, 5, 58), obs(13, 8, 20, 62)), zone = zone)
        assertEquals(1, infos.size)
        val i = infos[0]
        assertTrue(i.flagged)
        assertEquals(2, i.slowDates)
        assertEquals(15 * 60L, i.medianDelaySec) // delays 13 and 17 min -> median 15
    }

    @Test fun oneSlowDateIsNeverFlagged() {
        val infos = Congestion.analyze(listOf(obs(6, 8, 5, 90)), zone = zone)
        assertFalse(infos[0].flagged)
    }

    @Test fun twoSlowTripsOnTheSameDateCountOnce() {
        val infos = Congestion.analyze(listOf(obs(6, 8, 5, 60), obs(6, 8, 25, 60)), zone = zone)
        assertEquals(1, infos[0].slowDates)
        assertFalse(infos[0].flagged)
    }

    @Test fun slowDaysMustBeAtLeastHalfOfTheSlot() {
        // 2 slow dates out of 5 Tuesdays (Oct 6, 13, 20, 27, Nov?) -> only use Oct dates: 6,13,20,27 + one more Tue.
        val list = listOf(obs(6, 8, 5, 60), obs(13, 8, 5, 60), obs(20, 8, 5, 45), obs(27, 8, 5, 46), obs(27, 8, 20, 44))
        val i = Congestion.analyze(list, zone = zone)[0]
        assertEquals(2, i.slowDates)
        assertFalse(i.flagged) // 2 of 5 slow: not a systematic pattern
    }

    @Test fun smallDelaysAreNotSlow() {
        // 3 min later than expected is below the 5 min / 15% threshold.
        val infos = Congestion.analyze(listOf(obs(6, 8, 5, 48), obs(13, 8, 5, 48)), zone = zone)
        assertFalse(infos[0].flagged)
    }

    @Test fun differentWeekdaysAreDifferentSlots() {
        val infos = Congestion.analyze(listOf(obs(6, 8, 5, 60), obs(7, 8, 5, 60)), zone = zone) // Tue, Wed
        assertEquals(2, infos.size)
        assertTrue(infos.none { it.flagged })
    }

    @Test fun labelsAreReadable() {
        assertEquals("화 08:00~08:30", Congestion.label(Congestion.slotOf(ms(6, 8, 10), zone)))
        assertEquals("월 23:30~24:00", Congestion.label(Congestion.slotOf(ms(5, 23, 45), zone)))
    }

    @Test fun medianOfEvenListAveragesMiddle() {
        assertEquals(15L, Congestion.median(listOf(10L, 20L)))
        assertEquals(20L, Congestion.median(listOf(30L, 10L, 20L)))
    }
}
