package com.yj.departure

import android.net.Uri
import org.json.JSONObject

/** One upcoming train at a station, from the Seoul real-time arrival API. */
data class Arrival(
    val subwayId: String,
    val line: String,          // "2호선"
    val updn: String,          // "내선"/"외선" (line 2) or "상행"/"하행"
    val trainLine: String,     // "성수행 - 이대방면"
    val station: String,
    val seconds: Int?,         // barvlDt: seconds until arrival; null when the API gives 0/blank
    val msg: String,           // arvlMsg2: "1분 50초 후", "전역 도착", ...
    val where: String,         // arvlMsg3: where the train is now
    val receivedAt: String,    // recptnDt: when the server received this data
)

/**
 * Seoul subway real-time arrival (서울열린데이터광장).
 * GET http://swopenapi.seoul.go.kr/api/subway/{KEY}/json/realtimeStationArrival/{start}/{end}/{station}
 * (HTTP only - the server does not answer on HTTPS, so the app whitelists this one host for cleartext.)
 */
object SubwayApi {
    private const val BASE = "http://swopenapi.seoul.go.kr/api/subway"

    private val lineNames = mapOf(
        "1001" to "1호선", "1002" to "2호선", "1003" to "3호선", "1004" to "4호선", "1005" to "5호선",
        "1006" to "6호선", "1007" to "7호선", "1008" to "8호선", "1009" to "9호선",
        "1063" to "경의중앙선", "1065" to "공항철도", "1067" to "경춘선", "1075" to "수인분당선",
        "1077" to "신분당선", "1092" to "우이신설선", "1032" to "GTX-A",
    )

    fun lineName(subwayId: String) = lineNames[subwayId] ?: "노선 $subwayId"

    /** The API wants the station name without a trailing "역" (e.g. "신촌"). */
    fun normalizeStation(input: String): String {
        val s = input.trim()
        return if (s.length > 1 && s.endsWith("역")) s.dropLast(1) else s
    }

    private fun friendly(code: String, message: String) = when (code) {
        "INFO-100" -> "인증키가 유효하지 않아요 ($code)."
        "INFO-200" -> "조회된 열차가 없어요. 역 이름을 확인해 주세요 (예: 신촌)."
        else -> "$message ($code)"
    }

    /** Parses a response; throws [IllegalStateException] with a readable message on API-level errors. */
    fun parse(json: String): List<Arrival> {
        val root = JSONObject(json)
        val status = root.optJSONObject("errorMessage") ?: root
        val code = status.optString("code")
        if (code != "INFO-000") error(friendly(code, status.optString("message")))
        val list = root.optJSONArray("realtimeArrivalList") ?: return emptyList()
        val out = ArrayList<Arrival>()
        for (i in 0 until list.length()) {
            val o = list.getJSONObject(i)
            val id = o.optString("subwayId")
            out.add(
                Arrival(
                    subwayId = id,
                    line = lineName(id),
                    updn = o.optString("updnLine"),
                    trainLine = o.optString("trainLineNm"),
                    station = o.optString("statnNm"),
                    seconds = o.optString("barvlDt").toIntOrNull()?.takeIf { it > 0 },
                    msg = o.optString("arvlMsg2"),
                    where = o.optString("arvlMsg3"),
                    receivedAt = o.optString("recptnDt"),
                )
            )
        }
        return out
    }

    fun fetch(station: String, key: String, timeoutMs: Int = 8000, onDone: (Result<List<Arrival>>) -> Unit) {
        Http.async({
            val name = Uri.encode(normalizeStation(station))
            parse(Http.get("$BASE/$key/json/realtimeStationArrival/0/20/$name", timeoutMs = timeoutMs))
        }, onDone)
    }
}
