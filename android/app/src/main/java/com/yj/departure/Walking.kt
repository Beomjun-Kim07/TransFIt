package com.yj.departure

import java.time.ZoneId

/** How long the home -> boarding-station walk takes, personalised from recorded trips. */
object Walking {
    const val MIN_SEC = 30L
    const val MAX_SEC = 60 * 60L
    /** A same-slot (weekday + 30 min) estimate needs at least this many repeats. */
    const val MIN_REPEATS = 2

    enum class Basis { SLOT, PERSONAL, MAP, DEFAULT }

    data class Est(val sec: Long, val basis: Basis, val n: Int)

    /**
     * 1. SLOT     - median of this user's walks in the same weekday + 30-min slot (needs >= 2 of them);
     * 2. PERSONAL - median of all of this user's walks (needs >= 2);
     * 3. MAP      - the map API's walking time;
     * 4. DEFAULT  - [defaultSec].
     */
    fun estimate(
        trips: List<Trip>,
        departMs: Long,
        mapSec: Long?,
        defaultSec: Long,
        zone: ZoneId = ZoneId.systemDefault(),
    ): Est {
        val walks = trips.filter { it.direction == Direction.OUT }.mapNotNull { t ->
            val w = t.walkSec ?: return@mapNotNull null
            if (w in MIN_SEC..MAX_SEC) t.startMs to w else null
        }
        if (walks.size >= MIN_REPEATS) {
            val slot = Congestion.slotOf(departMs, zone)
            val inSlot = walks.filter { Congestion.slotOf(it.first, zone) == slot }
            return if (inSlot.size >= MIN_REPEATS) Est(Congestion.median(inSlot.map { it.second }), Basis.SLOT, inSlot.size)
            else Est(Congestion.median(walks.map { it.second }), Basis.PERSONAL, walks.size)
        }
        return if (mapSec != null) Est(mapSec, Basis.MAP, 0) else Est(defaultSec, Basis.DEFAULT, 0)
    }

    fun label(e: Est): String = when (e.basis) {
        Basis.SLOT -> "같은 요일·시간대 내 기록 ${e.n}회"
        Basis.PERSONAL -> "내 기록 ${e.n}회"
        Basis.MAP -> "지도 API 기준"
        Basis.DEFAULT -> "기본값"
    }
}
