package com.yj.departure

import android.content.Context

/**
 * Combines the real-time train arrivals at the boarding station with the (personalised) walking and
 * riding times: "if I leave now, which train do I catch, and when do I arrive?"
 */
object Live {
    /** Average waiting time already contained in the "station -> destination" estimates (seconds). */
    const val AVG_WAIT_SEC = 180L

    data class Core(
        /** Seconds until the first train we can still catch if we leave right now (null: none in the list). */
        val boardEtaSec: Int?,
        /** Predicted arrival at the destination if we leave now and take that train. */
        val arriveMs: Long?,
        /** Target minus predicted arrival; negative = late (seconds). */
        val slackSec: Long?,
        /** Latest moment we can leave and still catch a train that arrives by the target (null: no such train). */
        val leaveByMs: Long?,
    )

    /**
     * [etasSec]: seconds from [nowMs] until each upcoming train reaches the station.
     * [walkSec]: home -> station. [restSec]: station -> destination including waiting.
     */
    fun advise(nowMs: Long, etasSec: List<Int>, walkSec: Long, restSec: Long, targetMs: Long): Core {
        val ride = (restSec - AVG_WAIT_SEC).coerceAtLeast(60)
        val sorted = etasSec.sorted()
        val first = sorted.firstOrNull { it >= walkSec }
        val arriveMs = first?.let { nowMs + it * 1000L + ride * 1000L }
        val slack = arriveMs?.let { (targetMs - it) / 1000 }
        val lastOk = sorted.lastOrNull { nowMs + it * 1000L + ride * 1000L <= targetMs }
        val leaveBy = lastOk?.let { nowMs + (it - walkSec) * 1000L }
        return Core(first, arriveMs, slack, leaveBy)
    }

    /** Station -> destination duration (seconds), or null when nothing is known. */
    fun restEstimate(trips: List<Trip>, baselineSec: Long?, walkBaselineSec: Long?, confidence: Double, minSamples: Int): Long? {
        val rests = trips.filter { it.direction == Direction.OUT }.mapNotNull { it.restSec }
            .filter { it in 60..Estimator.MAX_VALID_SEC }
        if (rests.size >= minSamples) return Estimator.quantile(rests, confidence).toLong()
        if (baselineSec != null && walkBaselineSec != null) return (baselineSec - walkBaselineSec).coerceAtLeast(300)
        return null
    }

    private fun hhmm(ms: Long) = Notifications.hhmm(ms)

    /** Text lines for the Today screen and the alarm notification. */
    fun lines(ctx: Context, arrivals: List<Arrival>, targetMs: Long, nowMs: Long = System.currentTimeMillis()): List<String> {
        val prefs = Prefs(ctx)
        val trips = Db.get(ctx).completed(Direction.OUT)
        val etas = arrivals
            .filter { it.subwayId == prefs.boardSubwayId && it.updn == prefs.boardUpdn }
            .mapNotNull { it.seconds }
        val walk = Walking.estimate(trips, nowMs, prefs.walkBaselineOrNull, defaultSec = 10 * 60L)
        val rest = restEstimate(trips, prefs.baselineOrNull, prefs.walkBaselineOrNull, prefs.confidencePct / 100.0, prefs.minSamples)
            ?: return listOf("집→역 걷기 ${walk.sec / 60}분 (${Walking.label(walk)})")
        val out = ArrayList<String>()
        out.add("집→역 걷기 ${walk.sec / 60}분 (${Walking.label(walk)}) · 역→목적지 ${rest / 60}분")
        val core = advise(nowMs, etas, walk.sec, rest, targetMs)
        if (core.boardEtaSec == null) {
            out.add("지금 나가서 탈 수 있는 열차가 목록에 없어요.")
        } else {
            val slack = core.slackSec!!
            val verdict = if (slack >= 0) "${slack / 60}분 여유" else "${-slack / 60}분 지각"
            out.add("지금 출발하면 ${core.boardEtaSec / 60}분 뒤 열차 → ${hhmm(core.arriveMs!!)} 도착 예상 (목표 ${hhmm(targetMs)}, $verdict)")
        }
        val leaveBy = core.leaveByMs
        out.add(
            when {
                leaveBy == null -> "조회된 열차로는 목표 시각에 못 맞춰요."
                leaveBy >= nowMs -> "늦어도 ${hhmm(leaveBy)}까지 출발하세요."
                else -> "목표에 맞는 열차를 이미 놓쳤어요."
            }
        )
        return out
    }
}
