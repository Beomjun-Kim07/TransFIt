package com.yj.departure

import org.json.JSONObject
import java.util.Locale

/** Best public-transit route between two points (Kakao Map REST API). */
data class TransitRoute(val totalSec: Long, val transfers: Int, val summary: String)

/**
 * Kakao Map route finding.
 *  - GET https://dapi.kakao.com/v2/routing/publictraffic?start_x&start_y&end_x&end_y   (x = longitude, y = latitude)
 *      routes[].properties.{totalTime (s), transfers, type}, routes[].steps[].properties.{type, time, vehicles[].name}
 *  - GET https://dapi.kakao.com/v2/routing/walk?...
 *      route.properties.{totalTime (s), totalDistance (m)}
 * Neither takes a departure time: the result is a typical-conditions estimate, used here only as a baseline.
 */
object RouteApi {
    private const val TRANSIT = "https://dapi.kakao.com/v2/routing/publictraffic"
    private const val WALK = "https://dapi.kakao.com/v2/routing/walk"

    /** Picks the fastest route of the response. */
    fun parseTransit(json: String): TransitRoute {
        val root = JSONObject(json)
        val status = root.optString("status")
        if (status != "OK") error("대중교통 경로를 찾지 못했어요 ($status).")
        val routes = root.getJSONArray("routes")
        var best: JSONObject? = null
        var bestTime = Long.MAX_VALUE
        for (i in 0 until routes.length()) {
            val r = routes.getJSONObject(i)
            val t = r.getJSONObject("properties").optLong("totalTime", Long.MAX_VALUE)
            if (t < bestTime) { bestTime = t; best = r }
        }
        best ?: error("대중교통 경로가 비어 있어요.")
        val transfers = best.getJSONObject("properties").optInt("transfers")
        val parts = ArrayList<String>()
        val steps = best.optJSONArray("steps")
        if (steps != null) {
            for (i in 0 until steps.length()) {
                val p = steps.getJSONObject(i).optJSONObject("properties") ?: continue
                val type = p.optString("type")
                if (type != "SUBWAY" && type != "BUS") continue
                val vehicles = p.optJSONArray("vehicles") ?: continue
                val names = (0 until vehicles.length()).map { vehicles.getJSONObject(it).optString("name") }.filter { it.isNotBlank() }
                if (names.isNotEmpty()) parts.add(names.joinToString("/"))
            }
        }
        val line = if (parts.isEmpty()) "도보" else parts.joinToString(" → ")
        return TransitRoute(bestTime, transfers, "$line · 환승 $transfers")
    }

    fun parseWalk(json: String): Long {
        val root = JSONObject(json)
        val status = root.optString("status")
        if (status != "OK") error("도보 경로를 찾지 못했어요 ($status).")
        return root.getJSONObject("route").getJSONObject("properties").getLong("totalTime")
    }

    private fun httpMessage(code: Int) = when (code) {
        401 -> "키가 올바르지 않아요 (401)."
        403 -> "접근이 거부됐어요 (403). 카카오맵 사용 설정을 확인해 주세요."
        429 -> "무료 호출 한도를 넘었어요 (429)."
        else -> "길찾기에 실패했어요 (HTTP $code)."
    }

    private fun url(base: String, sLat: Double, sLng: Double, eLat: Double, eLng: Double): String =
        String.format(Locale.US, "%s?start_x=%.6f&start_y=%.6f&end_x=%.6f&end_y=%.6f", base, sLng, sLat, eLng, eLat)

    private fun get(url: String, key: String): String = try {
        Http.get(url, mapOf("Authorization" to "KakaoAK $key"))
    } catch (e: Http.HttpError) {
        error(httpMessage(e.code))
    }

    fun transit(sLat: Double, sLng: Double, eLat: Double, eLng: Double, key: String, onDone: (Result<TransitRoute>) -> Unit) {
        Http.async({ parseTransit(get(url(TRANSIT, sLat, sLng, eLat, eLng), key)) }, onDone)
    }

    fun walk(sLat: Double, sLng: Double, eLat: Double, eLng: Double, key: String, onDone: (Result<Long>) -> Unit) {
        Http.async({ parseWalk(get(url(WALK, sLat, sLng, eLat, eLng), key)) }, onDone)
    }
}
