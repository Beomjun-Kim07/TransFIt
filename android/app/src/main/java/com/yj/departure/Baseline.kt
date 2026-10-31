package com.yj.departure

import android.content.Context
import java.util.Locale

/**
 * Keeps the map-API baselines (whole trip, and home -> station walk) up to date.
 * Each is fetched only when the coordinates changed or the cached value is older than a day,
 * so this costs at most a couple of the 1,000 free daily calls.
 */
object Baseline {
    private const val MAX_AGE_MS = 24 * 3600_000L

    private fun f(v: Double) = String.format(Locale.US, "%.5f", v)

    fun tripKey(p: Prefs): String? =
        if (!p.hasPlaces) null else "${f(p.homeLat!!)},${f(p.homeLng!!)}>${f(p.destLat!!)},${f(p.destLng!!)}"

    fun walkKey(p: Prefs): String? =
        if (p.homeLat == null || p.homeLng == null || !p.hasStationPlace) null
        else "${f(p.homeLat!!)},${f(p.homeLng!!)}>${f(p.boardLat!!)},${f(p.boardLng!!)}"

    /** Fetch whatever is missing/stale. [onMessage] gets a short status line for each finished call. */
    fun refresh(ctx: Context, force: Boolean = false, onMessage: (String) -> Unit = {}) {
        val key = BuildConfig.KAKAO_REST_KEY
        if (key.isEmpty()) return
        val p = Prefs(ctx)
        val now = System.currentTimeMillis()

        val tk = tripKey(p)
        if (tk != null && (force || p.baselineKey != tk || now - p.baselineAtMs > MAX_AGE_MS)) {
            RouteApi.transit(p.homeLat!!, p.homeLng!!, p.destLat!!, p.destLng!!, key) { r ->
                r.onSuccess {
                    p.baselineSec = it.totalSec
                    p.baselineSummary = it.summary
                    p.baselineKey = tk
                    p.baselineAtMs = System.currentTimeMillis()
                    Planner.replan(ctx)
                    onMessage("기준 경로: ${it.summary} (${it.totalSec / 60}분)")
                }.onFailure { onMessage(it.message ?: "기준 경로를 가져오지 못했어요.") }
            }
        }

        val wk = walkKey(p)
        if (wk != null && (force || p.walkKey != wk || now - p.walkAtMs > MAX_AGE_MS)) {
            RouteApi.walk(p.homeLat!!, p.homeLng!!, p.boardLat!!, p.boardLng!!, key) { r ->
                r.onSuccess {
                    p.walkBaselineSec = it
                    p.walkKey = wk
                    p.walkAtMs = System.currentTimeMillis()
                    onMessage("집→역 도보 기준 ${it / 60}분")
                }.onFailure { onMessage(it.message ?: "도보 시간을 가져오지 못했어요.") }
            }
        }
    }
}
