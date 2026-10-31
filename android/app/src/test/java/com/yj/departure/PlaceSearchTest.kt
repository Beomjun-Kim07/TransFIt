package com.yj.departure

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaceSearchTest {
    // Shaped like the documented Kakao Local keyword-search response (all values are strings; x = longitude, y = latitude).
    private val sample = """
    {
      "meta": {"total_count": 3, "pageable_count": 3, "is_end": true},
      "documents": [
        {"id": "1", "place_name": "연세대학교 신촌캠퍼스", "category_name": "교육 > 대학교",
         "address_name": "서울 서대문구 연세로 50", "road_address_name": "서울 서대문구 연세로 50",
         "x": "126.938", "y": "37.566", "place_url": "http://place.map.kakao.com/1"},
        {"id": "2", "place_name": "연세대학교 원주캠퍼스", "category_name": "교육 > 대학교",
         "address_name": "강원 원주시 흥업면 연세대길 1", "road_address_name": "",
         "x": "127.9", "y": "37.3"},
        {"id": "3", "place_name": "주소없는곳", "address_name": "서울 중구 어딘가", "road_address_name": "", "x": "abc", "y": "37.5"}
      ]
    }
    """.trimIndent()

    @Test fun keepsSeoulResultsWithCoordinates() {
        val r = PlaceSearch.parse(sample)
        assertEquals(1, r.size)
        assertEquals("연세대학교 신촌캠퍼스", r[0].name)
        assertEquals(37.566, r[0].lat, 1e-9)    // y = latitude
        assertEquals(126.938, r[0].lng, 1e-9)   // x = longitude
        assertEquals("서울 서대문구 연세로 50", r[0].address)
    }

    @Test fun canKeepNonSeoulResults() {
        val r = PlaceSearch.parse(sample, seoulOnly = false)
        assertEquals(2, r.size) // the entry with an unparsable x is skipped
        assertTrue(r.any { it.name.contains("원주") })
    }

    @Test fun prefersTheStationOfTheRequestedLine() {
        val hits = listOf(
            PlaceResult("신촌역 경의중앙선", "서울 서대문구 창천동", 37.5598, 126.9426),
            PlaceResult("신촌역 2호선", "서울 서대문구 신촌로 90", 37.5551, 126.9369),
        )
        assertEquals("신촌역 2호선", PlaceSearch.pickStation(hits, "2호선")!!.name)
        assertEquals("신촌역 경의중앙선", PlaceSearch.pickStation(hits, "9호선")!!.name) // falls back to the first hit
        assertEquals(null, PlaceSearch.pickStation(emptyList(), "2호선"))
    }

    @Test fun errorMessagesAreSpecific() {
        assertTrue(PlaceSearch.errorMessage(403).contains("카카오맵"))
        assertTrue(PlaceSearch.errorMessage(429).contains("한도"))
        assertTrue(PlaceSearch.errorMessage(401).contains("키"))
    }
}
