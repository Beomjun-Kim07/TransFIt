// Supabase Edge Function: route
// 브라우저가 카카오 키를 들고 있지 않도록, 길찾기를 서버에서 대신 호출한다.
// 입력: { from: "노원역", to: "연세대학교 정문" }                       ← 이름으로 지오코딩
//       { fromX, fromY, toX, toY, from?, to? }                        ← 좌표(경도 x, 위도 y)를 주면 지오코딩 생략. from/to는 표시 이름
// 출력: { from:{name,x,y}, to:{name,x,y}, routes:[{type,totalTime,totalDistance,transfers,fare,steps:[...]}] }
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
    const routes = await Promise.all((j.routes ?? []).map(simplify));
    return new Response(JSON.stringify({ from: a, to: b, routes }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
