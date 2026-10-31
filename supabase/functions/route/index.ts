// Supabase Edge Function: route
// 브라우저가 카카오 키를 들고 있지 않도록, 길찾기를 서버에서 대신 호출한다.
// 입력: { from: "노원역", to: "연세대학교 정문" }
// 출력: { from:{name,x,y}, to:{name,x,y}, routes:[{type,totalTime,totalDistance,transfers,fare,steps:[...]}] }

const KAKAO = Deno.env.get("KAKAO_REST_KEY") ?? "";
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

function simplify(route: any) {
  const p = route.properties ?? {};
  const steps = (route.steps ?? []).map((s: any) => {
    const sp = s.properties ?? {};
    const stops = sp.stops ?? [];
    const veh = (sp.vehicles ?? [])[0];
    return {
      type: sp.type,                       // WALKING / SUBWAY / BUS
      time: sp.time, distance: sp.distance,
      from: stops[0]?.name ?? null, to: stops[stops.length - 1]?.name ?? null,
      line: veh?.name ?? null, vehicleType: veh?.type ?? null,
      guidance: sp.guidance ?? null,
    };
  });
  return { type: p.type, totalTime: p.totalTime, totalDistance: p.totalDistance, transfers: p.transfers, fare: p.fare, steps };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!KAKAO) throw new Error("KAKAO_REST_KEY가 설정되지 않았어요");
    const { from, to } = await req.json();
    const [a, b] = await Promise.all([geocode(from), geocode(to)]);
    const u = `https://dapi.kakao.com/v2/routing/publictraffic?start_x=${a.x}&start_y=${a.y}&end_x=${b.x}&end_y=${b.y}` +
              `&s_name=${encodeURIComponent(a.name)}&e_name=${encodeURIComponent(b.name)}`;
    const r = await fetch(u, { headers: H });
    if (!r.ok) throw new Error(`길찾기 실패 ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const routes = (j.routes ?? []).map(simplify);
    return new Response(JSON.stringify({ from: a, to: b, routes }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
