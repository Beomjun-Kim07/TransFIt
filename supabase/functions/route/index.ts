// Supabase Edge Function: route
// 브라우저가 카카오 키를 들고 있지 않도록, 길찾기를 서버에서 대신 호출한다.
// 입력: { from: "노원역", to: "연세대학교 정문" }                       ← 이름으로 지오코딩
//       { fromX, fromY, toX, toY, from?, to? }                        ← 좌표(경도 x, 위도 y)를 주면 지오코딩 생략. from/to는 표시 이름
// 출력: { from:{name,x,y}, to:{name,x,y}, originIsStop, destIsStop, routes:[{type,totalTime,totalDistance,transfers,fare,originIsStop,destIsStop,steps:[...]}] }
//       steps[].stops: SUBWAY·BUS 구간의 정거장 이름 목록(승차·하차 포함, 카카오 stops 순서). 웹이 segments.stop_names에 저장 →
//       tick 하차 알림이 실시간으로 못 잡을 때 정거장 수로 비례 추정한다. WALKING은 null.
//       첫 승차 지점이 출발 좌표에서 30m 이상이면 WALKING step(added:true)을 앞에, 마지막 하차 지점이 도착 좌표에서 30m 이상이면 뒤에 붙이고
//       totalTime/totalDistance에 더한다. 30m 이내면 originIsStop / destIsStop: true
// 단위: time/totalTime은 초, distance/totalDistance는 m (2026-10-31 실제 응답으로 확인).
// 카카오 stops에는 이름만 오고 정류장 번호가 없다. BUS 구간은 path.points의 첫/끝 좌표로
// 서울 버스 API getStationByPos를 불러 arsId(5자리)를 채운다. (BUS_KEY 없거나 실패하면 null)

const KAKAO = Deno.env.get("KAKAO_REST_KEY") ?? "";
const BUS_KEY = Deno.env.get("BUS_KEY") ?? "";
const H = { Authorization: `KakaoAK ${KAKAO}` };
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function geocode(q: string) {
  const u = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=5`;
  const r = await fetch(u, { headers: H });
  if (!r.ok) throw new Error(`장소 검색 실패 ${r.status}`);
  const j = await r.json();
  const d = j.documents?.[0];
  if (!d) throw new Error(`'${q}'을(를) 찾지 못했어요`);
  return { name: d.place_name, x: d.x, y: d.y, address: d.road_address_name || d.address_name };
}

// 카카오 publictraffic은 출발지→첫 승차 지점 도보를 생략할 때가 있다 (2026-11-01 확인: 건영3차아파트 출발인데 첫 step이 BUS, 승차 지점은 396m 밖).
// 첫 step이 WALKING이 아니고 출발 좌표와 첫 승차 지점이 ORIGIN_STOP_M 이상 떨어져 있으면 도보 step을 앞에 붙인다.
// 거리는 /v2/routing/walk, 시간은 거리 ÷ 3.7 km/h (네이버 도보 상수, 웹·watch.py와 같은 기준). 30m 이내면 originIsStop:true.
const ORIGIN_STOP_M = 30;
const WALK_MPS = 3.7 * 1000 / 3600;
function haversine(x1: number, y1: number, x2: number, y2: number) {
  const p = Math.PI / 180, dx = (x2 - x1) * p * Math.cos((y1 + y2) / 2 * p), dy = (y2 - y1) * p;
  return 6371000 * Math.hypot(dx, dy);
}
const walkCache = new Map<string, number>();
async function walkDistance(x1: number, y1: number, x2: number, y2: number): Promise<number> {
  const key = `${x1.toFixed(5)},${y1.toFixed(5)}>${x2.toFixed(5)},${y2.toFixed(5)}`;
  if (walkCache.has(key)) return walkCache.get(key)!;
  let d = haversine(x1, y1, x2, y2);
  try {
    const r = await fetch(`https://dapi.kakao.com/v2/routing/walk?start_x=${x1}&start_y=${y1}&end_x=${x2}&end_y=${y2}`, { headers: H });
    if (r.ok) { const j = await r.json(); const wd = Number(j?.route?.legs?.[0]?.properties?.distance); if (wd > 0) d = wd; }
  } catch (_) { /* 직선거리로 */ }
  walkCache.set(key, d);
  return d;
}
/** 첫 step 앞에 출발지 도보를 붙인다. → { route, originIsStop } */
async function prependOriginWalk(route: any, origin: { name: string; x: string; y: string }, rawFirst: any) {
  const first = route.steps[0];
  const pts: number[][] = rawFirst?.path?.points ?? [];
  if (!first || first.type === "WALKING" || !pts.length) return { route, originIsStop: false };
  const ox = Number(origin.x), oy = Number(origin.y), [sx, sy] = pts[0];
  const straight = haversine(ox, oy, sx, sy);
  if (straight < ORIGIN_STOP_M) return { route, originIsStop: true };
  const distance = Math.round(await walkDistance(ox, oy, sx, sy));
  const time = Math.round(distance / WALK_MPS);
  const walk = { type: "WALKING", time, distance, from: origin.name, to: first.from, arsId: null, arsIdTo: null, stops: null, line: null, vehicleType: null,
                 guidance: `${origin.name}에서 ${first.from ?? "승차 지점"}까지 도보 (카카오 응답에 없어 추가)`, added: true };
  return { route: { ...route, totalTime: (route.totalTime ?? 0) + time, totalDistance: (route.totalDistance ?? 0) + distance, steps: [walk, ...route.steps] }, originIsStop: false };
}

/** 마지막 step 뒤에 도착지 도보를 붙인다 (마지막 하차 지점 ↔ 도착 좌표). → { route, destIsStop } */
async function appendDestWalk(route: any, dest: { name: string; x: string; y: string }, rawLast: any) {
  const last = route.steps[route.steps.length - 1];
  const pts: number[][] = rawLast?.path?.points ?? [];
  if (!last || last.type === "WALKING" || !pts.length) return { route, destIsStop: false };
  const dx = Number(dest.x), dy = Number(dest.y), [ex, ey] = pts[pts.length - 1];
  if (haversine(ex, ey, dx, dy) < ORIGIN_STOP_M) return { route, destIsStop: true };
  const distance = Math.round(await walkDistance(ex, ey, dx, dy));
  const time = Math.round(distance / WALK_MPS);
  const walk = { type: "WALKING", time, distance, from: last.to, to: dest.name, arsId: null, arsIdTo: null, stops: null, line: null, vehicleType: null,
                 guidance: `${last.to ?? "하차 지점"}에서 ${dest.name}까지 도보 (카카오 응답에 없어 추가)`, added: true };
  return { route: { ...route, totalTime: (route.totalTime ?? 0) + time, totalDistance: (route.totalDistance ?? 0) + distance, steps: [...route.steps, walk] }, destIsStop: false };
}

// 좌표(경도 x, 위도 y) 근처 정류장 중 이름이 같은 것, 없으면 가장 가까운 것의 arsId
const arsCache = new Map<string, string | null>();
async function resolveArsId(x: number, y: number, name: string | null): Promise<string | null> {
  if (!BUS_KEY || x == null || y == null) return null;
  const key = `${x.toFixed(5)},${y.toFixed(5)}`;
  if (arsCache.has(key)) return arsCache.get(key)!;
  let out: string | null = null;
  try {
    const u = `http://ws.bus.go.kr/api/rest/stationinfo/getStationByPos?serviceKey=${BUS_KEY}&tmX=${x}&tmY=${y}&radius=100&resultType=json`;
    const r = await fetch(u);
    const j = await r.json();
    const items: any[] = (j?.msgBody?.itemList ?? []).filter((it: any) => it.arsId && it.arsId !== "0");
    const norm = (t: string) => (t ?? "").replace(/\s|\(.*?\)/g, "");
    const same = name ? items.find((it) => norm(it.stationNm) === norm(name)) : undefined;
    const pick = same ?? items.sort((a, b) => Number(a.dist) - Number(b.dist))[0];
    out = pick?.arsId ?? null;
  } catch (_) { out = null; }
  arsCache.set(key, out);
  return out;
}

async function simplify(route: any) {
  const p = route.properties ?? {};
  const steps = await Promise.all((route.steps ?? []).map(async (s: any) => {
    const sp = s.properties ?? {};
    const stops = sp.stops ?? [];
    const veh = (sp.vehicles ?? [])[0];
    const pts: number[][] = s.path?.points ?? [];
    const from = stops[0]?.name ?? null, to = stops[stops.length - 1]?.name ?? null;
    let arsId: string | null = null, arsIdTo: string | null = null;
    if (sp.type === "BUS" && pts.length) {
      [arsId, arsIdTo] = await Promise.all([
        resolveArsId(pts[0][0], pts[0][1], from),
        resolveArsId(pts[pts.length - 1][0], pts[pts.length - 1][1], to),
      ]);
    }
    return {
      type: sp.type,                       // WALKING / SUBWAY / BUS
      time: sp.time, distance: sp.distance, // 초, m
      from, to,
      arsId, arsIdTo,                      // BUS만: 승차/하차 정류장 번호(5자리), 못 찾으면 null
      stops: sp.type === "SUBWAY" || sp.type === "BUS" ? stops.map((x: any) => x?.name).filter(Boolean) : null,   // 정거장 이름 (승차·하차 포함)
      line: veh?.name ?? null, vehicleType: veh?.type ?? null,
      guidance: sp.guidance ?? null,
    };
  }));
  return { type: p.type, totalTime: p.totalTime, totalDistance: p.totalDistance, transfers: p.transfers, fare: p.fare, steps };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!KAKAO) throw new Error("KAKAO_REST_KEY가 설정되지 않았어요");
    const { from, to, fromX, fromY, toX, toY } = await req.json();
    const hasXY = [fromX, fromY, toX, toY].every((v) => v !== undefined && v !== null && v !== "" && !isNaN(Number(v)));
    const [a, b] = hasXY
      ? [{ name: from || "출발", x: String(fromX), y: String(fromY), address: null },
         { name: to || "도착", x: String(toX), y: String(toY), address: null }]
      : await Promise.all([geocode(from), geocode(to)]);
    const u = `https://dapi.kakao.com/v2/routing/publictraffic?start_x=${a.x}&start_y=${a.y}&end_x=${b.x}&end_y=${b.y}` +
              `&s_name=${encodeURIComponent(a.name)}&e_name=${encodeURIComponent(b.name)}`;
    const r = await fetch(u, { headers: H });
    if (!r.ok) throw new Error(`길찾기 실패 ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const raw = j.routes ?? [];
    const simplified = await Promise.all(raw.map(simplify));
    const fixed = await Promise.all(simplified.map(async (r: any, i: number) => {
      const o = await prependOriginWalk(r, a, raw[i]?.steps?.[0]);
      const d = await appendDestWalk(o.route, b, raw[i]?.steps?.[raw[i].steps.length - 1]);
      return { route: { ...d.route, originIsStop: o.originIsStop, destIsStop: d.destIsStop }, originIsStop: o.originIsStop, destIsStop: d.destIsStop };
    }));
    const routes = fixed.map((f) => f.route);
    const originIsStop = fixed.some((f) => f.originIsStop);   // 출발지가 정류장/역 자체(30m 이내) → 웹이 집→정류장 도보 분을 물어 넣는다
    const destIsStop = fixed.some((f) => f.destIsStop);       // 도착지가 정류장/역 자체
    return new Response(JSON.stringify({ from: a, to: b, originIsStop, destIsStop, routes }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
