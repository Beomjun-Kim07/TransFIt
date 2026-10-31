package com.yj.departure

import android.Manifest
import android.annotation.SuppressLint
import android.app.TimePickerDialog
import android.content.Context
import android.content.Intent
import android.location.Location
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Notifications.ensureChannel(this)
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) { AppRoot() }
            }
        }
    }
}

private val dateFmt = DateTimeFormatter.ofPattern("M월 d일 (E) HH:mm", Locale.KOREAN)
private fun fmt(ms: Long): String = dateFmt.format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))
private fun mins(sec: Long): String = "${(sec + 30) / 60}분"

@Composable
fun AppRoot() {
    val ctx = LocalContext.current
    var tab by rememberSaveable { mutableIntStateOf(0) }
    // Bumped whenever data/settings change (or the app returns to the foreground) so screens re-read them.
    var tick by remember { mutableIntStateOf(0) }
    val onChanged: () -> Unit = { tick++ }

    val lifecycle = (ctx as ComponentActivity).lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) tick++ }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    // Refresh the map-API baselines once per launch (no-op unless missing/stale/places changed).
    LaunchedEffect(Unit) { Baseline.refresh(ctx) { tick++ } }

    val tabs = listOf("오늘" to "◷", "기록" to "☰", "설정" to "⚙")
    Scaffold(bottomBar = {
        NavigationBar {
            tabs.forEachIndexed { i, (label, icon) ->
                NavigationBarItem(selected = tab == i, onClick = { tab = i }, icon = { Text(icon) }, label = { Text(label) })
            }
        }
    }) { pad ->
        Box(Modifier.padding(pad)) {
            when (tab) {
                0 -> TodayScreen(tick, onChanged)
                1 -> HistoryScreen(tick, onChanged)
                else -> SettingsScreen(tick, onChanged)
            }
        }
    }
}

// ---------------------------------------------------------------- Today

@Composable
fun TodayScreen(tick: Int, onChanged: () -> Unit) {
    val ctx = LocalContext.current
    val prefs = remember { Prefs(ctx) }
    val db = remember { Db.get(ctx) }
    val now = System.currentTimeMillis()
    val next = remember(tick) { Planner.computeNext(ctx) }
    val open = remember(tick) { db.openTrip(Direction.OUT) }
    val trips = remember(tick) { db.completed(Direction.OUT) }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("출발 알리미", style = MaterialTheme.typography.headlineSmall)

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("다음 출발 권장", style = MaterialTheme.typography.labelLarge)
                if (next == null) {
                    Text("설정에서 도착 시각과 요일을 정해 주세요.")
                } else {
                    val p = next.plan
                    Text(fmt(p.departMs), style = MaterialTheme.typography.headlineMedium)
                    Text("도착 목표 ${fmt(p.arriveMs)}")
                    Text(Notifications.basisText(p, prefs.confidencePct), style = MaterialTheme.typography.bodyMedium)
                    prefs.baselineSummary?.let {
                        Text("기준 경로: $it (${prefs.baselineSec / 60}분)", style = MaterialTheme.typography.bodySmall)
                    }
                    Text("알림은 ${fmt(next.alarmAtMs)}에 울려요.", style = MaterialTheme.typography.bodySmall)
                }
            }
        }

        if (next != null && next.plan.arriveMs - now in 0..(3 * 3600_000L)) {
            val prob = Estimator.onTimeProbability(trips, now, next.plan.arriveMs, prefs.minSamples)
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("지금 출발하면", style = MaterialTheme.typography.labelLarge)
                    Text(
                        if (prob == null) "기록이 더 쌓이면 정시 도착 확률을 보여드려요."
                        else "정시 도착 확률 ${(prob * 100).toInt()}%",
                        style = MaterialTheme.typography.titleMedium,
                    )
                }
            }
        }

        val boardStation = prefs.boardStation
        if (boardStation != null && BuildConfig.SEOUL_SUBWAY_KEY.isNotEmpty()) {
            var allTrains by remember { mutableStateOf<List<Arrival>?>(null) }
            var trainError by remember { mutableStateOf<String?>(null) }
            val load: () -> Unit = {
                SubwayApi.fetch(boardStation, BuildConfig.SEOUL_SUBWAY_KEY) { r ->
                    r.onSuccess { all -> allTrains = all; trainError = null }
                        .onFailure { trainError = it.message ?: "조회에 실패했어요." }
                }
            }
            val trains = allTrains?.filter { it.subwayId == prefs.boardSubwayId && it.updn == prefs.boardUpdn }
                ?.sortedBy { it.seconds ?: Int.MAX_VALUE }
            LaunchedEffect(tick) { load() }
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        "승차 역 실시간 · $boardStation ${SubwayApi.lineName(prefs.boardSubwayId ?: "")} ${prefs.boardUpdn ?: ""}",
                        style = MaterialTheme.typography.labelLarge,
                    )
                    val list = trains
                    when {
                        trainError != null -> Text(trainError!!, color = MaterialTheme.colorScheme.error)
                        list == null -> Text("불러오는 중…")
                        list.isEmpty() -> Text("지금 조회된 열차가 없어요.")
                        else -> {
                            list.take(3).forEach {
                                Text("${it.msg} · ${it.where} (${it.trainLine})", style = MaterialTheme.typography.bodyMedium)
                            }
                            Text("서버 기준 ${list.first().receivedAt.takeLast(8)}", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    // Real-time train + personal walking/riding time -> "if I leave now ...".
                    val all = allTrains
                    if (all != null && next != null && next.plan.arriveMs - now in 0..(3 * 3600_000L)) {
                        HorizontalDivider()
                        Live.lines(ctx, all, next.plan.arriveMs).forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    }
                    OutlinedButton(onClick = { load() }) { Text("새로고침") }
                }
            }
        }

        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("이동 기록", style = MaterialTheme.typography.labelLarge)
                if (open != null) {
                    Text("이동 중 · ${(now - open.startMs) / 60_000}분 경과 (${sourceLabel(open.source)})")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = {
                            TripRecorder.finish(ctx, Direction.OUT)
                            onChanged()
                        }) { Text("도착했어요") }
                        OutlinedButton(onClick = {
                            db.discardOpen(Direction.OUT)
                            onChanged()
                        }) { Text("기록 취소") }
                    }
                } else {
                    Text(
                        "출발할 때 눌러서 직접 기록할 수 있어요. 위치 설정이 끝나면 집을 나서고 목적지에 도착할 때 자동으로도 기록돼요.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Button(onClick = {
                        TripRecorder.start(ctx, Direction.OUT, Source.MANUAL)
                        onChanged()
                    }) { Text("출발했어요") }
                }
            }
        }
    }
}

private fun sourceLabel(s: String) = when (s) {
    Source.AUTO -> "자동"
    Source.MANUAL -> "수동"
    Source.DEMO -> "예시"
    else -> s
}

// ---------------------------------------------------------------- History

@Composable
fun HistoryScreen(tick: Int, onChanged: () -> Unit) {
    val ctx = LocalContext.current
    val prefs = remember { Prefs(ctx) }
    val db = remember { Db.get(ctx) }
    val all = remember(tick) { db.completed() }
    val outSecs = remember(tick) {
        all.filter { it.direction == Direction.OUT }.mapNotNull { it.durationSec }
            .filter { it in Estimator.MIN_VALID_SEC..Estimator.MAX_VALID_SEC }
    }

    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 16.dp),
        contentPadding = PaddingValues(vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item { Text("이동 기록", style = MaterialTheme.typography.headlineSmall) }
        item {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (outSecs.isEmpty()) {
                        Text("아직 가는 길 기록이 없어요.")
                    } else {
                        Text("가는 길 ${outSecs.size}회", style = MaterialTheme.typography.titleMedium)
                        Text("중앙값 ${mins(Estimator.quantile(outSecs, 0.5).toLong())} · ${prefs.confidencePct}% 기준 ${mins(Estimator.quantile(outSecs, prefs.confidencePct / 100.0).toLong())}")
                        Text("최소 ${mins(outSecs.min())} ~ 최대 ${mins(outSecs.max())}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
        item {
            val infos = remember(tick) {
                val obs = all.filter { it.direction == Direction.OUT }.mapNotNull { t ->
                    val d = t.durationSec ?: return@mapNotNull null
                    val e = t.expectedSec ?: return@mapNotNull null
                    if (d !in Estimator.MIN_VALID_SEC..Estimator.MAX_VALID_SEC) null else Obs(t.startMs, d, e)
                }
                Congestion.analyze(obs)
            }
            val flagged = infos.filter { it.flagged }
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("정체 의심 시간대", style = MaterialTheme.typography.titleMedium)
                    if (flagged.isEmpty()) {
                        Text(
                            "아직 없어요. 같은 요일·30분 시간대에서 지도 기준보다 5분(또는 15%) 이상 느린 날이 서로 다른 날짜로 2번 이상 반복되면 표시돼요.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    } else {
                        flagged.forEach {
                            Text("${Congestion.label(it.slot)} · 평소보다 +${it.medianDelaySec / 60}분 (${it.slowDates}일 반복, 기록 ${it.n}회)")
                        }
                        Text("이 시간대에는 기준 소요시간에 위 지연이 더해져 출발 시각이 앞당겨져요.", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
        items(all, key = { it.id }) { t ->
            Card(Modifier.fillMaxWidth()) {
                Row(Modifier.padding(start = 16.dp, top = 8.dp, bottom = 8.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        val dir = if (t.direction == Direction.OUT) "가는 길" else "오는 길"
                        Text("$dir · ${fmt(t.startMs)}")
                        Text("소요 ${mins(t.durationSec ?: 0)} · ${sourceLabel(t.source)}", style = MaterialTheme.typography.bodySmall)
                    }
                    TextButton(onClick = {
                        db.deleteTrip(t.id)
                        Planner.replan(ctx)
                        onChanged()
                    }) { Text("삭제") }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- Settings

@SuppressLint("MissingPermission")
private fun fetchLocation(ctx: Context, onDone: (Location?) -> Unit) {
    if (!Perms.fineLocation(ctx)) return onDone(null)
    LocationServices.getFusedLocationProviderClient(ctx)
        .getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, CancellationTokenSource().token)
        .addOnSuccessListener { onDone(it) }
        .addOnFailureListener { onDone(null) }
}

@Composable
private fun SectionTitle(text: String) {
    Text(text, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
    HorizontalDivider()
}

@Composable
private fun SliderRow(label: String, value: Int, range: IntRange, step: Int, unit: String, onFinished: (Int) -> Unit) {
    var v by remember(value) { mutableFloatStateOf(value.toFloat()) }
    Text("$label: ${v.toInt()}$unit")
    Slider(
        value = v,
        onValueChange = { v = it },
        valueRange = range.first.toFloat()..range.last.toFloat(),
        steps = (range.last - range.first) / step - 1,
        onValueChangeFinished = { onFinished(v.toInt()) },
    )
}

@Composable
private fun PlaceRow(label: String, lat: Double?, lng: Double?, onPick: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label)
            Text(
                if (lat == null || lng == null) "미설정" else "%.5f, %.5f".format(lat, lng),
                style = MaterialTheme.typography.bodySmall,
            )
        }
        OutlinedButton(onClick = onPick) { Text("현재 위치로") }
    }
}

@Composable
private fun PermRow(label: String, ok: Boolean, action: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(if (ok) "✓" else "✗", modifier = Modifier.padding(end = 8.dp), color = if (ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
        Text(label, Modifier.weight(1f))
        if (!ok) OutlinedButton(onClick = onClick) { Text(action) }
    }
}

@Composable
private fun DayDot(label: String, selected: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(40.dp).clip(CircleShape)
            .background(if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun SettingsScreen(tick: Int, onChanged: () -> Unit) {
    val ctx = LocalContext.current
    val prefs = remember { Prefs(ctx) }
    var message by remember { mutableStateOf<String?>(null) }

    val multiLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { onChanged() }
    val singleLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { onChanged() }

    // Re-register the geofences and the alarm after any setting that affects them.
    val apply = {
        GeofenceHelper.register(ctx) { _, m -> message = m }
        Planner.replan(ctx)
        // Map-API baselines (whole trip, home -> station walk): fetched only if missing, stale or the places changed.
        Baseline.refresh(ctx) { m -> message = m; onChanged() }
        onChanged()
    }

    // `tick` is read so permission/status rows refresh when the user returns from system settings.
    @Suppress("UNUSED_EXPRESSION") tick

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("설정", style = MaterialTheme.typography.headlineSmall)
        message?.let { Text(it, color = MaterialTheme.colorScheme.primary) }

        SectionTitle("장소 검색 (서울)")
        var query by remember { mutableStateOf("") }
        var results by remember { mutableStateOf<List<PlaceResult>>(emptyList()) }
        var searching by remember { mutableStateOf(false) }
        if (BuildConfig.KAKAO_REST_KEY.isEmpty()) {
            Text(
                "카카오 REST 키가 없어요. 저장소 루트의 .env.local에 KAKAO_REST_KEY=… 를 넣고 다시 빌드해 주세요.",
                style = MaterialTheme.typography.bodySmall,
            )
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    label = { Text("예: 연세대학교 정문") },
                )
                Button(enabled = query.isNotBlank() && !searching, onClick = {
                    searching = true
                    PlaceSearch.search(query.trim(), BuildConfig.KAKAO_REST_KEY) { r ->
                        searching = false
                        r.onSuccess {
                            results = it
                            message = if (it.isEmpty()) "서울 안에서 찾은 장소가 없어요." else null
                        }.onFailure { message = it.message ?: "검색에 실패했어요." }
                    }
                }) { Text(if (searching) "…" else "검색") }
            }
            results.forEach { p ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Text(p.name, style = MaterialTheme.typography.titleSmall)
                        Text(p.address, style = MaterialTheme.typography.bodySmall)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = {
                                prefs.homeLat = p.lat; prefs.homeLng = p.lng
                                message = "집을 ‘${p.name}’(으)로 설정했어요."
                                apply()
                            }) { Text("집으로") }
                            TextButton(onClick = {
                                prefs.destLat = p.lat; prefs.destLng = p.lng
                                message = "목적지를 ‘${p.name}’(으)로 설정했어요."
                                apply()
                            }) { Text("목적지로") }
                        }
                    }
                }
            }
        }

        SectionTitle("장소")
        PlaceRow("집", prefs.homeLat, prefs.homeLng) {
            fetchLocation(ctx) { loc ->
                if (loc == null) message = "위치를 가져오지 못했어요. 위치 권한과 GPS를 확인해 주세요."
                else { prefs.homeLat = loc.latitude; prefs.homeLng = loc.longitude; apply() }
            }
        }
        PlaceRow("목적지 (학교/직장)", prefs.destLat, prefs.destLng) {
            fetchLocation(ctx) { loc ->
                if (loc == null) message = "위치를 가져오지 못했어요. 위치 권한과 GPS를 확인해 주세요."
                else { prefs.destLat = loc.latitude; prefs.destLng = loc.longitude; apply() }
            }
        }
        SliderRow("인식 반경", prefs.radiusM, 100..400, 50, "m") { prefs.radiusM = it; apply() }

        SectionTitle("지하철 승차 역")
        var stationQuery by remember { mutableStateOf(prefs.boardStation ?: "") }
        var found by remember { mutableStateOf<List<Arrival>>(emptyList()) }
        var loadingTrains by remember { mutableStateOf(false) }
        prefs.boardStation?.let {
            Text("현재 설정: $it · ${SubwayApi.lineName(prefs.boardSubwayId ?: "")} ${prefs.boardUpdn ?: ""}")
            Text(
                prefs.boardName?.let { n -> "역 위치: $n (걷기 시간 측정용 지오펜스)" } ?: "역 위치: 아직 찾지 못했어요",
                style = MaterialTheme.typography.bodySmall,
            )
            if (prefs.hasStationPlace) {
                SliderRow("승차 역 인식 반경", prefs.stationRadiusM, 50..150, 10, "m") { v -> prefs.stationRadiusM = v; apply() }
            }
        }
        if (BuildConfig.SEOUL_SUBWAY_KEY.isEmpty()) {
            Text(
                "서울 열린데이터광장 키가 없어요. 저장소 루트의 .env.local에 SUBWAY_KEY=… 를 넣고 다시 빌드해 주세요.",
                style = MaterialTheme.typography.bodySmall,
            )
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = stationQuery,
                    onValueChange = { stationQuery = it },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    label = { Text("역 이름 (예: 신촌)") },
                )
                Button(enabled = stationQuery.isNotBlank() && !loadingTrains, onClick = {
                    loadingTrains = true
                    SubwayApi.fetch(stationQuery, BuildConfig.SEOUL_SUBWAY_KEY) { r ->
                        loadingTrains = false
                        r.onSuccess { found = it; message = null }
                            .onFailure { found = emptyList(); message = it.message ?: "조회에 실패했어요." }
                    }
                }) { Text(if (loadingTrains) "…" else "조회") }
            }
            found.groupBy { it.subwayId to it.updn }.forEach { (_, list) ->
                val first = list.first()
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Text("${first.line} ${first.updn} · ${first.trainLine}", style = MaterialTheme.typography.titleSmall)
                        list.take(2).forEach { Text("${it.msg} · ${it.where}", style = MaterialTheme.typography.bodySmall) }
                        TextButton(onClick = {
                            prefs.boardStation = first.station
                            prefs.boardSubwayId = first.subwayId
                            prefs.boardUpdn = first.updn
                            message = "승차 역을 ${first.station} ${first.line} ${first.updn}(으)로 설정했어요."
                            onChanged()
                            // Find the station's position: needed for the walking-time geofence and map walking baseline.
                            if (BuildConfig.KAKAO_REST_KEY.isNotEmpty()) {
                                PlaceSearch.findStation(first.station, first.line, BuildConfig.KAKAO_REST_KEY) { r ->
                                    r.onSuccess {
                                        prefs.boardLat = it.lat
                                        prefs.boardLng = it.lng
                                        prefs.boardName = it.name
                                        message = "승차 역 위치를 ‘${it.name}’(으)로 찾았어요."
                                        apply()
                                    }.onFailure { message = "역 위치를 찾지 못했어요: ${it.message}" }
                                }
                            }
                        }) { Text("이 방향으로 설정") }
                    }
                }
            }
        }

        SectionTitle("도착 목표")
        val h = prefs.arriveMinute / 60
        val m = prefs.arriveMinute % 60
        OutlinedButton(onClick = {
            TimePickerDialog(ctx, { _, hh, mm -> prefs.arriveMinute = hh * 60 + mm; apply() }, h, m, true).show()
        }) { Text("도착 목표 시각  %02d:%02d".format(h, m)) }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            val names = listOf("월", "화", "수", "목", "금", "토", "일")
            DayOfWeek.entries.forEachIndexed { i, d ->
                DayDot(names[i], prefs.isDayActive(d)) { prefs.toggleDay(d); apply() }
            }
        }
        SliderRow("정시 도착 신뢰도 (과거 이동의 몇 %가 제시간)", prefs.confidencePct, 50..99, 1, "%") { prefs.confidencePct = it; apply() }
        SliderRow("출발 몇 분 전에 알릴까", prefs.leadMin, 0..30, 5, "분") { prefs.leadMin = it; apply() }
        SliderRow("기록이 부족할 때 쓸 기본 소요", prefs.fallbackMin, 10..120, 5, "분") { prefs.fallbackMin = it; apply() }
        SliderRow("개인 기록으로 전환하는 최소 횟수", prefs.minSamples, 1..15, 1, "회") { prefs.minSamples = it; apply() }

        SectionTitle("권한 · 설정 점검")
        PermRow("정확한 위치", Perms.fineLocation(ctx), "허용") {
            multiLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
        }
        PermRow("위치 ‘항상 허용’ (앱이 꺼져 있어도 출발/도착 감지)", Perms.backgroundLocation(ctx), "허용") {
            if (!Perms.fineLocation(ctx)) message = "먼저 ‘정확한 위치’를 허용해 주세요."
            else singleLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        }
        PermRow("알림", Perms.notifications(ctx), "허용") {
            singleLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        PermRow("정확한 알람 (정시에 알림)", Perms.exactAlarm(ctx), "설정") {
            ctx.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${ctx.packageName}")))
        }
        PermRow("배터리 제한 해제 (백그라운드 유지)", Perms.batteryUnrestricted(ctx), "설정") {
            ctx.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }

        SectionTitle("시험용")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = {
                Notifications.show(ctx, Notifications.ID_TEST, "테스트 알림", "알림이 이렇게 보여요.")
            }) { Text("테스트 알림") }
            OutlinedButton(onClick = { GeofenceHelper.register(ctx) { _, mm -> message = mm } }) { Text("지오펜스 재등록") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { Demo.seed(ctx); onChanged() }) { Text("예시 기록 12개 추가") }
            OutlinedButton(onClick = { Demo.clear(ctx); onChanged() }) { Text("예시 기록 삭제") }
        }
    }
}
