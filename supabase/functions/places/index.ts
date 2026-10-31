// Supabase Edge Function: places
// 장소 자동완성. 브라우저가 카카오 키를 들고 있지 않도록 서버에서 대신 검색한다. (--no-verify-jwt)
// GET ?q=검색어  →  [{ name, address(도로명 우선), x, y, category }]  (최대 7개, q가 2자 미만이면 [])

const KAKAO = Deno.env.get("KAKAO_REST_KEY") ?? "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
    if (q.length < 2) return json([]);
    if (!KAKAO) throw new Error("KAKAO_REST_KEY가 설정되지 않았어요");
    const u = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=7`;
    const r = await fetch(u, { headers: { Authorization: `KakaoAK ${KAKAO}` } });
    if (!r.ok) throw new Error(`장소 검색 실패 ${r.status}`);
    const j = await r.json();
    const out = (j.documents ?? []).map((d: any) => ({
      name: d.place_name,
      address: d.road_address_name || d.address_name || "",
      x: Number(d.x), y: Number(d.y),              // 경도, 위도
      category: d.category_group_name || (d.category_name ?? "").split(" > ").pop() || "",
    }));
    return json(out);
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 400);
  }
});
