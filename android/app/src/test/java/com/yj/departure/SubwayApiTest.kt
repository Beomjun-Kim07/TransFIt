package com.yj.departure

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SubwayApiTest {
    // Trimmed copy of a real realtimeStationArrival response (Sinchon, 2026-10-27 evening).
    private val sample = """
    {"errorMessage":{"status":200,"code":"INFO-000","message":"정상 처리되었습니다.","link":"","developerMessage":"","total":3},
     "realtimeArrivalList":[
      {"subwayId":"1002","updnLine":"외선","trainLineNm":"성수행 - 홍대입구방면","statnNm":"신촌","barvlDt":"110",
       "arvlMsg2":"1분 50초 후","arvlMsg3":"아현","arvlCd":"99","bstatnNm":"성수","recptnDt":"2026-10-27 20:13:06"},
      {"subwayId":"1002","updnLine":"내선","trainLineNm":"성수행 - 이대방면","statnNm":"신촌","barvlDt":"0",
       "arvlMsg2":"전역 도착","arvlMsg3":"홍대입구","arvlCd":"5","bstatnNm":"성수","recptnDt":"2026-10-27 20:13:06"},
      {"subwayId":"1077","updnLine":"상행","trainLineNm":"강남행 - 어딘가방면","statnNm":"신촌","barvlDt":"380",
       "arvlMsg2":"6분 20초 후","arvlMsg3":"어딘가","arvlCd":"99","bstatnNm":"강남","recptnDt":"2026-10-27 20:13:06"}
     ]}
    """.trimIndent()

    @Test fun parsesRealResponseShape() {
        val r = SubwayApi.parse(sample)
        assertEquals(3, r.size)
        assertEquals("2호선", r[0].line)
        assertEquals("외선", r[0].updn)
        assertEquals(110, r[0].seconds)
        assertEquals("1분 50초 후", r[0].msg)
        assertEquals("아현", r[0].where)
        assertEquals("신분당선", r[2].line)
    }

    @Test fun zeroSecondsMeansUnknown() {
        assertNull(SubwayApi.parse(sample)[1].seconds)
    }

    @Test fun unknownLineIdIsKept() {
        assertEquals("노선 9999", SubwayApi.lineName("9999"))
    }

    @Test fun stripsTrailingStationSuffix() {
        assertEquals("신촌", SubwayApi.normalizeStation("신촌역"))
        assertEquals("신촌", SubwayApi.normalizeStation(" 신촌 "))
        assertEquals("역", SubwayApi.normalizeStation("역")) // too short to strip
    }

    @Test fun apiErrorsBecomeReadableMessages() {
        val noData = """{"status":500,"code":"INFO-200","message":"해당하는 데이터가 없습니다.","link":"","developerMessage":"","total":0}"""
        try { SubwayApi.parse(noData); fail("expected error") } catch (e: IllegalStateException) {
            assertTrue(e.message!!.contains("역 이름"))
        }
        val badKey = """{"RESULT":{"CODE":"INFO-100"},"status":500,"code":"INFO-100","message":"인증키가 유효하지 않습니다."}"""
        try { SubwayApi.parse(badKey); fail("expected error") } catch (e: IllegalStateException) {
            assertTrue(e.message!!.contains("인증키"))
        }
    }
}
