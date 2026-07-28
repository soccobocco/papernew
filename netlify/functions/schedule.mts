// 주간 편성 CRUD — Netlify Blobs `airscript-schedule` store
// GET  /api/schedule/:week   → 해당 주 전체 편성 데이터
// POST /api/schedule/:week   → 해당 주 편성 데이터 저장

import { getStore } from "@netlify/blobs";

export default async (req: Request) => {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  // parts = ["api", "schedule", <week: YYYY-MM-DD>]
  const week = parts[2];

  if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
    return json({ error: "week 파라미터 형식 오류 (YYYY-MM-DD)" }, 400);
  }

  const store = getStore("airscript-schedule");
  const key = `week:${week}`;

  try {
    if (req.method === "GET") {
      const data: any = await store.get(key, { type: "json" });
      return json({
        week,
        entries: data?.entries || {},
        savedAt: data?.savedAt || null
      });
    }

    if (req.method === "POST") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const entries = body?.entries || {};
      await store.setJSON(key, {
        week,
        entries,
        savedAt: new Date().toISOString()
      });
      return json({ ok: true, week });
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
  path: "/api/schedule/:week"
};
