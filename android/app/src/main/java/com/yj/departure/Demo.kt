package com.yj.departure

import android.content.Context
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.ZoneId
import java.util.Random

/** Sample trips so the estimate can be tried before real data exists. */
object Demo {
    /**
     * Adds 12 weekday trips from the past weeks: leave ~08:05-08:25, walk 11-15 min to the station,
     * 40-58 minutes door to door. The "expected" (map baseline) is 45 minutes, and Tuesdays are made
     * consistently slow so the congestion detection has something to find.
     */
    fun seed(ctx: Context) {
        val db = Db.get(ctx)
        val zone = ZoneId.systemDefault()
        val rnd = Random(42)
        var day = LocalDate.now(zone).minusDays(1)
        var made = 0
        while (made < 12) {
            if (day.dayOfWeek != DayOfWeek.SATURDAY && day.dayOfWeek != DayOfWeek.SUNDAY) {
                val start = day.atTime(8, 5 + rnd.nextInt(21)).atZone(zone).toInstant().toEpochMilli()
                val minutes = if (day.dayOfWeek == DayOfWeek.TUESDAY) 54 + rnd.nextInt(5) else 40 + rnd.nextInt(10)
                val board = start + (11 + rnd.nextInt(5)) * 60_000L
                val end = start + minutes * 60_000L
                db.insertDone(start, end, Direction.OUT, Source.DEMO, boardMs = board, expectedSec = 45 * 60L, walkExpectedSec = 12 * 60L)
                made++
            }
            day = day.minusDays(1)
        }
        Planner.replan(ctx)
    }

    fun clear(ctx: Context) {
        Db.get(ctx).deleteBySource(Source.DEMO)
        Planner.replan(ctx)
    }
}
