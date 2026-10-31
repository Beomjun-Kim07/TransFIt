package com.yj.departure

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RouteApiTest {
    // Shaped like a real publictraffic response (Gangnam -> Yonsei main gate): three alternatives.
    private val transit = """
    {"status":"OK","properties":{"total":3},
     "routes":[
      {"properties":{"type":"SUBWAY","totalDistance":24118,"totalTime":3336,"transfers":0,"fare":{"value":1650}},
       "steps":[{"properties":{"type":"SUBWAY","distance":23400,"time":2520,"vehicles":[{"name":"2호선","type":"SUBWAY"}]}}]},
      {"properties":{"type":"BUS","totalDistance":14854,"totalTime":3629,"transfers":0,"fare":{"value":1500}},
       "steps":[{"properties":{"type":"BUS","distance":14209,"time":2991,"vehicles":[{"name":"470","type":"BUS"}]}}]},
      {"properties":{"type":"BUS_AND_SUBWAY","totalDistance":24317,"totalTime":3229,"transfers":1,"fare":{"value":1750}},
       "steps":[
         {"properties":{"type":"SUBWAY","distance":23400,"time":2520,"vehicles":[{"name":"2호선","type":"SUBWAY"}]}},
         {"properties":{"type":"WALKING","distance":85,"time":150}},
         {"properties":{"type":"BUS","distance":648,"time":343,"vehicles":[{"name":"서대문03","type":"BUS"},{"name":"서대문04","type":"BUS"}]}}]}
     ]}
    """.trimIndent()

    @Test fun picksTheFastestTransitRoute() {
        val r = RouteApi.parseTransit(transit)
        assertEquals(3229L, r.totalSec)
        assertEquals(1, r.transfers)
        assertEquals("2호선 → 서대문03/서대문04 · 환승 1", r.summary)
    }

    @Test fun noResultsBecomesAnError() {
        try {
            RouteApi.parseTransit("""{"status":"NO_RESULTS"}""")
            fail("expected error")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!.contains("NO_RESULTS"))
        }
    }

    @Test fun parsesWalkingTime() {
        val json = """{"status":"OK","route":{"properties":{"totalDistance":917,"totalTime":893}}}"""
        assertEquals(893L, RouteApi.parseWalk(json))
    }

    @Test fun walkingErrorStatusIsReported() {
        try {
            RouteApi.parseWalk("""{"status":"TOO_FAR_AWAY"}""")
            fail("expected error")
        } catch (e: IllegalStateException) {
            assertTrue(e.message!!.contains("TOO_FAR_AWAY"))
        }
    }
}
