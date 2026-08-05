// CG 의뢰서 CRUD — Netlify Blobs 기반 팀 공유 저장소
// GET    /api/cg-requests        → 전체 목록 (요약)
// GET    /api/cg-requests/:id    → 개별 의뢰서 전체
// POST   /api/cg-requests        → 새 의뢰서 등록 (body: 전체 데이터)
// DELETE /api/cg-requests/:id    → 삭제
//
// 의뢰서 데이터 스키마:
// {
//   id, airDate, program, corner, cgTypeFormat, // 헤더 라인에서 파싱
//   items: [                                    // 여러 CG (통CG1, 통CG2 등)
//     { number, graphType, title, subtitle, dataRows[], specialInstructions[], raw }
//   ],
//   raw,                                        // 원본 텍스트
//   status,                                     // "draft" | "reviewed" | "cg-uploaded" | "matched" | "issue"
//   deliveryImageKey,                           // CG 이미지 저장 키 (Phase 2)
//   ocrResult,                                  // Gemini OCR 결과 (Phase 2)
//   reviewResult,                               // 대조 결과 (Phase 2)
//   createdAt, updatedAt
// }

import { getStore } from "@netlify/blobs";

export default async (req: Request) => {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const id = parts[2];

  const store = getStore("airscript-cg-requests");

  try {
    // ---------- LIST ----------
    if (req.method === "GET" && !id) {
      const { blobs } = await store.list({ prefix: "cg:" });
      const items = await Promise.all(
        blobs.map(async (b: any) => {
          const key = b.key;
          try {
            const data: any = await store.get(key, { type: "json" });
            if (!data) return null;
            // 목록에서는 raw text 제외 (성능)
            const summary = {
              id: data.id || key.slice(3),
              airDate: data.airDate || null,
              program: data.program || null,
              corner: data.corner || null,
              cgTypeFormat: data.cgTypeFormat || null,
              status: data.status || "draft",
              itemCount: (data.items || []).length,
              titles: (data.items || []).map((i: any) => i.title).filter(Boolean),
              hasDelivery: !!data.deliveryImageKey,
              reviewIssueCount: data.reviewResult?.issueCount || 0,
              createdAt: data.createdAt || null,
              updatedAt: data.updatedAt || null
            };
            return summary;
          } catch {
            return null;
          }
        })
      );
      const filtered = items.filter(Boolean);
      // 최신순 정렬 (updatedAt 우선, 없으면 createdAt)
      filtered.sort((a: any, b: any) => {
        const ka = b?.updatedAt || b?.createdAt || "";
        const kb = a?.updatedAt || a?.createdAt || "";
        return ka.localeCompare(kb);
      });
      return json({ items: filtered });
    }

    // ---------- GET ONE ----------
    if (req.method === "GET" && id) {
      const data: any = await store.get(`cg:${id}`, { type: "json" });
      if (!data) return json({ error: "not found" }, 404);
      return json({ request: data });
    }

    // ---------- CREATE / UPDATE ----------
    if (req.method === "POST") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const now = new Date().toISOString();
      const newId = id || body.id || "cg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      // 기존 데이터가 있으면 병합 (부분 업데이트 지원)
      const existing: any = id ? await store.get(`cg:${id}`, { type: "json" }) : null;
      const entry = {
        ...(existing || {}),
        ...body,
        id: newId,
        createdAt: existing?.createdAt || body.createdAt || now,
        updatedAt: now
      };
      await store.setJSON(`cg:${newId}`, entry);
      return json({ id: newId, createdAt: entry.createdAt, updatedAt: entry.updatedAt });
    }

    // ---------- DELETE ----------
    if (req.method === "DELETE" && id) {
      await store.delete(`cg:${id}`);
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
  path: ["/api/cg-requests", "/api/cg-requests/:id"]
};
