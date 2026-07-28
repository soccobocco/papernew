// 원고 아카이브 CRUD — Netlify Blobs 기반 팀 공유 저장소
// GET    /api/manuscripts        → 전체 목록 (요약)
// GET    /api/manuscripts/:id    → 개별 원고 전체 (raw + parsed + AI)
// POST   /api/manuscripts        → 새 원고 STOCK (body: 전체 데이터)
// DELETE /api/manuscripts/:id    → 삭제

import { getStore } from "@netlify/blobs";

export default async (req: Request) => {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  // parts = ["api", "manuscripts", <id?>]
  const id = parts[2];

  const store = getStore("airscript-manuscripts");

  try {
    // ---------- LIST ----------
    if (req.method === "GET" && !id) {
      const { blobs } = await store.list({ prefix: "ms:" });
      const items = await Promise.all(
        blobs.map(async (b: any) => {
          const key = b.key;
          try {
            const data: any = await store.get(key, { type: "json" });
            if (!data) return null;
            // 목록에서는 raw text 제외 (성능)
            const summary = {
              id: data.id || key.slice(3),
              program: data.program || null,
              corner: data.corner || null,
              airDate: data.airDate || null,
              airTime: data.airTime || null,
              duration: data.duration || null,
              guest: data.guest || null,
              guestAffiliation: data.guestAffiliation || null,
              mc: data.mc || null,
              questionCount: data.questionCount || 0,
              cgCount: data.cgCount || 0,
              charCount: data.charCount || 0,
              tickers: data.tickers || [],
              events: data.events || [],
              sectors: data.sectors || [],
              organizations: data.organizations || [],
              stockedAt: data.stockedAt || null
            };
            return summary;
          } catch {
            return null;
          }
        })
      );
      const filtered = items.filter(Boolean);
      // 최신순 정렬
      filtered.sort((a: any, b: any) => (b?.stockedAt || "").localeCompare(a?.stockedAt || ""));
      return json({ items: filtered });
    }

    // ---------- GET ONE ----------
    if (req.method === "GET" && id) {
      const data: any = await store.get(`ms:${id}`, { type: "json" });
      if (!data) return json({ error: "not found" }, 404);
      return json({ manuscript: data });
    }

    // ---------- CREATE ----------
    if (req.method === "POST" && !id) {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const newId = body.id || "ms_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      const entry = {
        ...body,
        id: newId,
        stockedAt: body.stockedAt || new Date().toISOString()
      };
      await store.setJSON(`ms:${newId}`, entry);
      return json({ id: newId, stockedAt: entry.stockedAt });
    }

    // ---------- DELETE ----------
    if (req.method === "DELETE" && id) {
      await store.delete(`ms:${id}`);
      return json({ deleted: id });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e: any) {
    return json({ error: e.message || "서버 오류" }, 500);
  }
};

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export const config = {
  path: ["/api/manuscripts", "/api/manuscripts/:id"]
};
