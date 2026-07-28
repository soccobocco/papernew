// 맞춤법 검수 프록시 — 부산대 검사기 (speller.town 경유)
// speller.town: 부산대 검사기를 감싼 오픈소스 무료 API 서버
// 요청: POST { "text": "검사할텍스트" }
// 응답: { "suggestions": [{ description, start, end, text, candidates }] }

const SPELLER_URL = "https://speller.town";
const CHUNK_SIZE = 480; // 부산대 검사기 안정 처리 범위
const MAX_CHUNKS = 15;
const TIMEOUT_MS = 12000;

export default async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: any;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400);
  }

  const rawText: string = String(body?.text || "");
  if (rawText.trim().length < 20) {
    return json({ error: "원고가 너무 짧습니다" }, 400);
  }

  // CG 지시어 라인 제외하고 본문만 검수
  const filteredText = filterOutCGLines(rawText);
  const chunks = chunkByLines(filteredText, CHUNK_SIZE).slice(0, MAX_CHUNKS);

  const allChecks: any[] = [];
  const errors: string[] = [];

  for (const chunk of chunks) {
    try {
      const found = await checkWithSpeller(chunk);
      allChecks.push(...found);
    } catch (e: any) {
      errors.push(e.message || "청크 오류");
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

  return json({
    checks: deduped,
    source: "pusan (via speller.town)",
    chunks: chunks.length,
    ...(errors.length > 0 ? { warnings: errors } : {})
  });
};

// -----------------------------------------------------------------
// speller.town 호출 & 응답 파싱
// -----------------------------------------------------------------
async function checkWithSpeller(text: string): Promise<any[]> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(SPELLER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AIRSCRIPT/1.0 (broadcast proofreader)"
      },
      body: JSON.stringify({ text }),
      signal: controller.signal
    });

    if (!resp.ok) {
      throw new Error(`speller.town ${resp.status}`);
    }

    const data: any = await resp.json();
    const suggestions: any[] = Array.isArray(data?.suggestions) ? data.suggestions : [];

    return suggestions
      .map((s: any) => {
        // candidates 는 배열 (여러 후보 가능)
        const candArr: string[] = Array.isArray(s.candidates) ? s.candidates : [];
        const firstCand = candArr[0] || "";
        const origText = String(s.text || "");

        if (!origText || !firstCand || origText === firstCand) return null;

        // 오류 유형 분류: 설명 텍스트에서 힌트
        const desc = String(s.description || "").trim();
        let type: "error" | "warn" | "suggest" = "error";
        if (/추천|권장|일 수 있|의심|가능성/.test(desc)) type = "suggest";
        else if (/띄어쓰기|공백/.test(desc)) type = "warn";

        return {
          text: origText,
          suggestion: firstCand,
          reason: desc.slice(0, 60) || "맞춤법·띄어쓰기",
          type,
          layer: "L4·부산대",
          ...(candArr.length > 1 ? { alternates: candArr.slice(1, 4) } : {})
        };
      })
      .filter(Boolean);
  } finally {
    clearTimeout(t);
  }
}

// -----------------------------------------------------------------
// CG 지시어 라인 제외
// -----------------------------------------------------------------
function filterOutCGLines(text: string): string {
  const lines = text.split("\n");
  const skipRe =
    /^(좌상단S?|우측네임|좌측네임|네임S|서브(?:\([12]단\))?|수퍼|하단S?|월백|통CG|월백\s*통CG|월백S|PPT\s*\d+)\s*>/;
  const filtered = lines.filter((l) => !skipRe.test(l.trim()));
  return filtered.join("\n");
}

// -----------------------------------------------------------------
// 라인 단위 청크 나누기 (문장 경계 유지)
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
