package com.yj.departure

import org.json.JSONObject
import java.net.URLEncoder

/** One search hit. */
data class PlaceResult(val name: String, val address: String, val lat: Double, val lng: Double)

/**
 * Place-name -> coordinates, using the Kakao Local keyword search API
 * (https://dapi.kakao.com/v2/local/search/keyword.json, header "Authorization: KakaoAK <REST key>").
 * Response: documents[].{place_name, address_name, road_address_name, x (longitude), y (latitude)}, all strings.
 */
object PlaceSearch {
    private const val ENDPOINT = "https://dapi.kakao.com/v2/local/search/keyword.json"

    /** Turns a keyword-search response into results. Only Seoul addresses are kept when [seoulOnly]. */
    fun parse(json: String, seoulOnly: Boolean = true): List<PlaceResult> {
        val docs = JSONObject(json).getJSONArray("documents")
        val out = ArrayList<PlaceResult>()
        for (i in 0 until docs.length()) {
            val d = docs.getJSONObject(i)
            val address = d.optString("road_address_name").ifBlank { d.optString("address_name") }
            val lng = d.optString("x").toDoubleOrNull() ?: continue
            val lat = d.optString("y").toDoubleOrNull() ?: continue
            if (seoulOnly && !d.optString("address_name").startsWith("서울")) continue
            out.add(PlaceResult(d.optString("place_name"), address, lat, lng))
        }
        return out
    }

    /** Friendly message for an HTTP error from the API. */
    fun errorMessage(code: Int): String = when (code) {
        401 -> "키가 올바르지 않아요 (401). REST API 키를 확인해 주세요."
        403 -> "접근이 거부됐어요 (403). 카카오 개발자 콘솔에서 ‘카카오맵’ 사용 설정을 ON으로 바꿨는지 확인해 주세요."
        429 -> "무료 호출 한도를 넘었어요 (429)."
        else -> "검색에 실패했어요 (HTTP $code)."
    }

    /** Among station hits, prefer the one whose name mentions the line (e.g. "신촌역 2호선"). */
    fun pickStation(hits: List<PlaceResult>, lineName: String): PlaceResult? =
        hits.firstOrNull { it.name.contains(lineName) } ?: hits.firstOrNull()

    /** Finds the coordinates of a subway station (Kakao category SW8 = 지하철역). */
    fun findStation(station: String, lineName: String, key: String, onDone: (Result<PlaceResult>) -> Unit) {
        Http.async({
            val q = SubwayApi.normalizeStation(station) + "역"
            val url = "$ENDPOINT?query=${URLEncoder.encode(q, "UTF-8")}&category_group_code=SW8&size=15"
            val body = try {
                Http.get(url, mapOf("Authorization" to "KakaoAK $key"))
            } catch (e: Http.HttpError) {
                error(errorMessage(e.code))
            }
            pickStation(parse(body), lineName) ?: error("서울에서 ‘$q’을(를) 찾지 못했어요.")
        }, onDone)
    }

    /** Runs the search off the main thread; [onDone] is called on the main thread. */
    fun search(query: String, key: String, onDone: (Result<List<PlaceResult>>) -> Unit) {
        Http.async({
            val url = "$ENDPOINT?query=${URLEncoder.encode(query, "UTF-8")}&size=15"
            val body = try {
                Http.get(url, mapOf("Authorization" to "KakaoAK $key"))
            } catch (e: Http.HttpError) {
                error(errorMessage(e.code))
            }
            parse(body)
        }, onDone)
    }
}
