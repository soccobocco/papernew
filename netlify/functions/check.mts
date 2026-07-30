// 맞춤법 검수 프록시 — 바른 (bareun.ai) 클라우드 REST API
//
// 스펙:
//   URL: https://api.bareun.ai/bareun.RevisionService/CorrectError
//   Method: POST
//   Header: api-key, Content-Type: application/json
//   Body:  { document: { content, language: "ko-KR" }, encoding_type: "UTF8" }
//   응답:  { origin, revised, revised_blocks 또는 revisedBlocks: [...] }
//   ※ bareun 은 gRPC connectrpc 기반이라 응답이 카멜케이스로 올 수 있음
//
// API 키는 Netlify 환경변수 BAREUN_API_KEY 에 등록되어 있어야 합니다.
// 무료 구간: 하루 50,000 어절

const BAREUN_URL = "https://api.bareun.ai/bareun.RevisionService/CorrectError";
const CHUNK_SIZE = 1500;
const MAX_CHUNKS = 20;
const TIMEOUT_MS = 30000;

export default async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const apiKey = process.env.BAREUN_API_KEY;
  if (!apiKey) {
    return json({
      error: "서버 설정 오류 - BAREUN_API_KEY 미등록",
      hint: "Netlify 환경변수에 BAREUN_API_KEY 등록 필요"
    }, 500);
  }

  let body: any;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400);
  }

  const rawText: string = String(body?.text || "");
  const debugMode = body?.debug === true;
  if (rawText.trim().length < 20) {
    return json({ error: "원고가 너무 짧습니다" }, 400);
  }

  const filteredText = filterOutCGLines(rawText);
  const chunks = chunkByLines(filteredText, CHUNK_SIZE).slice(0, MAX_CHUNKS);

  const allChecks: any[] = [];
  const diagnostics: string[] = [];
  let firstRawResponse: any = null;   // 진단용: 첫 청크의 raw 응답 샘플
  let success = 0;
  let failed = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const { checks: found, rawResponse } = await checkViaBareun(chunk, apiKey);
      if (i === 0) firstRawResponse = rawResponse;
      if (found && found.length > 0) allChecks.push(...found);
      success++;
      diagnostics.push(`chunk ${i + 1}: OK (${found?.length || 0}건)`);
    } catch (e: any) {
      failed++;
      const msg = e.message || "unknown";
      diagnostics.push(`chunk ${i + 1}: 실패 — ${msg}`);
      console.error(`[check] chunk ${i + 1} 실패:`, msg);
    }
  }

  // 중복 제거
  const seen = new Set();
  const deduped = allChecks.filter((c) => {
    const key = c.text + "|" + c.suggestion;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[check] 바른 · 청크 ${chunks.length} (성공 ${success}, 실패 ${failed}) · 지적 ${deduped.length}건`);
  // 지적 0건일 때는 첫 응답 구조 로깅 (필드명 진단용)
  if (deduped.length === 0 && firstRawResponse) {
    console.log("[check] 첫 청크 원본 응답 키:", Object.keys(firstRawResponse || {}));
    console.log("[check] 첫 청크 원본 응답 샘플:", JSON.stringify(firstRawResponse).slice(0, 1500));
  }

  const result: any = {
    checks: deduped,
    source: failed === chunks.length ? "실패" : "바른 (bareun.ai)",
    chunks: chunks.length,
    success,
    failed,
    total: deduped.length,
    diagnostics: diagnostics.slice(0, 10)
  };

  // 진단: 지적 0건이거나 debug 모드면 원본 응답 샘플 포함
  if (debugMode || (deduped.length === 0 && firstRawResponse)) {
    result.rawSample = {
      keys: firstRawResponse ? Object.keys(firstRawResponse) : [],
      body: firstRawResponse ? JSON.stringify(firstRawResponse).slice(0, 2500) : null
    };
  }

  return json(result);
};

// -----------------------------------------------------------------
// 바른 REST API 호출 - 원본 응답도 함께 반환
// -----------------------------------------------------------------
async function checkViaBareun(text: string, apiKey: string): Promise<{ checks: any[], rawResponse: any }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(BAREUN_URL, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        document: {
          content: text,
          language: "ko-KR"
        },
        encoding_type: "UTF8",
        config: {
          enable_cleanup_whitespace: true
        }
      }),
      signal: controller.signal
    });

    if (!resp.ok) {
      let errBody: any = null;
      try { errBody = await resp.json(); } catch {}
      const errMsg = errBody?.error?.message || errBody?.message || errBody?.error || `HTTP ${resp.status}`;
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`인증 실패 — API 키 확인 (${errMsg})`);
      }
      if (resp.status === 429) {
        throw new Error(`무료 할당량 초과 — 하루 50,000 어절 (${errMsg})`);
      }
      throw new Error(`HTTP ${resp.status}: ${errMsg}`);
    }

    const data: any = await resp.json();

    // snake_case, camelCase 둘 다 지원 (bareun 은 connectrpc 기반)
    const blocks: any[] =
      (Array.isArray(data?.revised_blocks) && data.revised_blocks) ||
      (Array.isArray(data?.revisedBlocks) && data.revisedBlocks) ||
      [];

    const results: any[] = [];
    for (const block of blocks) {
      const origin = String(block?.origin || "").trim();
      const revised = String(block?.revised || "").trim();
      if (!origin || !revised || origin === revised) continue;

      // revisions 배열 (교정 후보들)
      const revisions: any[] = Array.isArray(block.revisions) ? block.revisions : [];
      const firstRev = revisions[0] || {};

      // 카테고리 추출
      const category = String(firstRev.category || firstRev.helpCategory || "").trim();

      // 설명 추출 (helps.comment 또는 help.comment)
      const helps = firstRev.helps || firstRev.help || {};
      const comment = String(helps?.comment || "").replace(/<[^>]+>/g, "").trim();
      const reason = comment || category || "맞춤법·띄어쓰기";

      // 카테고리 기반 타입 분류
      let type: "error" | "warn" | "suggest" = "error";
      const catText = category + " " + reason;
      if (/띄어쓰기|공백|whitespace|spacing/i.test(catText)) {
        type = "warn";
      } else if (/추천|권장|의심|가능성|suggest/i.test(catText)) {
        type = "suggest";
      }

      results.push({
        text: origin,
        suggestion: revised,
        reason: reason.slice(0, 80),
        type,
        layer: "L4·바른",
        category: category || undefined
      });
    }

    return { checks: results, rawResponse: data };
  } finally {
    clearTimeout(t);
  }
}

// -----------------------------------------------------------------
// CG 지시어 라인 제외 (검수 대상 아님)
// -----------------------------------------------------------------
function filterOutCGLines(text: string): string {
  const lines = text.split("\n");
  const skipRe =
    /^(좌상단S?|우측네임|좌측네임|네임S|서브(?:\([12]단\))?|수퍼|하단S?|월백|통CG|월백\s*통CG|월백S|PPT\s*\d+)\s*>/;
  const filtered = lines.filter((l) => !skipRe.test(l.trim()));
  return filtered.join("\n");
}

// -----------------------------------------------------------------
// 라인 단위 청크 (문단 경계 존중)
// -----------------------------------------------------------------
function chunkByLines(text: string, target: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let cur = "";
  for (const line of lines) {
    if ((cur + "\n" + line).length > target && cur) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? cur + "\n" + line : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => c.trim().length > 0);
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export const config = {
  path: "/api/check"
};
