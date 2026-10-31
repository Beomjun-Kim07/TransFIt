package com.yj.departure

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import java.time.Instant
import java.time.ZoneId

/** Decides when the next "leave now" reminder should fire and schedules it. */
object Planner {

    /** The next reminder: the [plan] it announces and when ([alarmAtMs]) to announce it. */
    data class Next(val plan: Plan, val alarmAtMs: Long)

    fun computeNext(ctx: Context, nowMs: Long = System.currentTimeMillis()): Next? {
        val prefs = Prefs(ctx)
        val zone = ZoneId.systemDefault()
        val trips = Db.get(ctx).completed(Direction.OUT)
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        for (d in 0L..7L) {
            val date = today.plusDays(d)
            if (!prefs.isDayActive(date.dayOfWeek)) continue
            val target = date.atTime(prefs.arriveMinute / 60, prefs.arriveMinute % 60).atZone(zone)
            val plan = Estimator.plan(
                trips = trips,
                arriveMs = target.toInstant().toEpochMilli(),
                confidence = prefs.confidencePct / 100.0,
                fallbackSec = prefs.fallbackMin * 60L,
                minSamples = prefs.minSamples,
                baselineSec = prefs.baselineOrNull,
                zone = zone,
            )
            val alarmAt = plan.departMs - prefs.leadMin * 60_000L
            if (alarmAt > nowMs) return Next(plan, alarmAt)
        }
        return null
    }

    private fun pendingIntent(ctx: Context, plan: Plan?): PendingIntent {
        val i = Intent(ctx, AlarmReceiver::class.java)
        if (plan != null) {
            i.putExtra("arriveMs", plan.arriveMs)
            i.putExtra("departMs", plan.departMs)
            i.putExtra("durationSec", plan.durationSec)
            i.putExtra("samples", plan.samples)
            i.putExtra("basis", plan.basis.name)
            i.putExtra("delaySec", plan.delaySec)
        }
        return PendingIntent.getBroadcast(ctx, 1, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** Recompute the next reminder and (re)schedule the alarm. Call after any data/settings change. */
    fun replan(ctx: Context) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        am.cancel(pendingIntent(ctx, null))
        val next = computeNext(ctx) ?: return
        val pi = pendingIntent(ctx, next.plan)
        try {
            if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next.alarmAtMs, pi)
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next.alarmAtMs, pi)
            }
        } catch (e: SecurityException) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next.alarmAtMs, pi)
        }
    }
}
