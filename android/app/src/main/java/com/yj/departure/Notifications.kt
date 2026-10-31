package com.yj.departure

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

object Notifications {
    private const val CHANNEL = "departure_alerts"

    const val ID_DEPART = 1
    const val ID_RECORDED = 2
    const val ID_TEST = 3

    fun ensureChannel(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) != null) return
        val ch = NotificationChannel(CHANNEL, "출발 알림", NotificationManager.IMPORTANCE_HIGH)
        ch.description = "출발해야 할 시각과 이동 기록 알림"
        nm.createNotificationChannel(ch)
    }

    fun show(ctx: Context, id: Int, title: String, text: String) {
        if (!Perms.notifications(ctx)) return
        ensureChannel(ctx)
        val open = PendingIntent.getActivity(
            ctx, 0, Intent(ctx, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify(id, n)
    }

    private val timeFmt = DateTimeFormatter.ofPattern("HH:mm", Locale.KOREAN)

    fun hhmm(ms: Long, zone: ZoneId = ZoneId.systemDefault()): String =
        timeFmt.format(Instant.ofEpochMilli(ms).atZone(zone))

    /** One sentence saying where the recommended duration comes from. */
    fun basisText(plan: Plan, confidencePct: Int): String = when (plan.basis) {
        Basis.PERSONAL -> "평소 소요 ${plan.durationSec / 60}분 (${confidencePct}% 기준, 내 기록 ${plan.samples}회)"
        Basis.CONGESTION ->
            "기준 경로 ${(plan.durationSec - plan.delaySec) / 60}분 + 정체 의심 ${plan.delaySec / 60}분 " +
                "(같은 요일·시간대에서 반복) = ${plan.durationSec / 60}분"
        Basis.BASELINE -> "기준 경로 ${plan.durationSec / 60}분 (지도 API · 내 기록이 쌓이면 개인화돼요)"
        Basis.FALLBACK -> "기록·경로 정보가 없어 기본 소요 ${plan.durationSec / 60}분으로 계산했어요"
    }

    /** The text shown when it is time to get ready to leave; [live] are optional real-time lines. */
    fun departureText(plan: Plan, confidencePct: Int, live: List<String> = emptyList()): String {
        val head = "출발 권장 ${hhmm(plan.departMs)} · 도착 목표 ${hhmm(plan.arriveMs)}\n${basisText(plan, confidencePct)}"
        return if (live.isEmpty()) head else head + "\n" + live.joinToString("\n")
    }
}
