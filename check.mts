// 맞춤법 검수 프록시 — 부산대 검사기
// 1차: speller.town (오픈소스 wrapper)
// 2차 fallback: 부산대 직접 (nara-speller.co.kr)
// 3차 fallback: 이전 부산대 URL (speller.cs.pusan.ac.kr)

const SPELLER_TOWN = "https://speller.town";
const NARA_SPELLER = "https://nara-speller.co.kr/speller/results";
const OLD_PUSAN = "http://speller.cs.pusan.ac.kr/results";
const CHUNK_SIZE = 480;
const MAX_CHUNKS = 15;
const TIMEOUT_MS = 15000;

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

  const filteredText = filterOutCGLines(rawText);
  const chunks = chunkByLines(filteredText, CHUNK_SIZE).slice(0, MAX_CHUNKS);

  const allChecks: any[] = [];
  const diagnostics: string[] = [];
  let usedSource = "";

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let found: any[] | null = null;

    // 시도 1: speller.town
    try {
      found = await checkViaSpellerTown(chunk);
      if (found !== null) {
        if (!usedSource) usedSource = "speller.town";
        diagnostics.push(`chunk ${i + 1}: speller.town OK (${found.length}건)`);
      }
    } catch (e: any) {
      diagnostics.push(`chunk ${i + 1}: speller.town 실패 — ${e.message}`);
    }

    // 시도 2: nara-speller.co.kr (부산대 공식 통합 URL)
    if (found === null) {
      try {
        found = await checkViaNaraSpeller(chunk);
        if (found !== null) {
          if (!usedSource) usedSource = "nara-speller (부산대 직접)";
          diagnostics.push(`chunk ${i + 1}: nara-speller OK (${found.length}건)`);
        }
      } catch (e: any) {
        diagnostics.push(`chunk ${i + 1}: nara-speller 실패 — ${e.message}`);
      }
    }

    // 시도 3: 이전 부산대 URL
    if (found === null) {
      try {
        found = await checkViaOldPusan(chunk);
        if (found !== null) {
          if (!usedSource) usedSource = "부산대 (구 URL)";
          diagnostics.push(`chunk ${i + 1}: 구 URL OK (${found.length}건)`);
        }
      } catch (e: any) {
        diagnostics.push(`chunk ${i + 1}: 구 URL 실패 — ${e.message}`);
      }
    }

    if (found) allChecks.push(...found);
  }

  // 중복 제거
  const seen = new Set();
  const deduped = allChecks.filter((c) => {
    const key = c.text + "|" + c.suggestion;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[check] 소스=${usedSource || "모두 실패"}, 청크=${chunks.length}, 지적=${deduped.length}건`);
  console.log("[check] diagnostics:", diagnostics.slice(0, 5));

  return json({
    checks: deduped,
    source: usedSource || "실패",
    chunks: chunks.length,
    total: deduped.length,
    diagnostics: diagnostics.slice(0, 10)
  });
};

// -----------------------------------------------------------------
// speller.town — JSON 응답, 파싱 쉬움
// -----------------------------------------------------------------
async function checkViaSpellerTown(text: string): Promise<any[]> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(SPELLER_TOWN, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "AIRSCRIPT/1.0"
      },
      body: JSON.stringify({ text }),
      signal: controller.signal
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data: any = await resp.json();
    const suggestions: any[] = Array.isArray(data?.suggestions) ? data.suggestions : [];

    return suggestions
      .map((s: any) => {
        const candArr: string[] = Array.isArray(s.candidates) ? s.candidates : [];
        const firstCand = candArr[0] || "";
        const origText = String(s.text || "");
        if (!origText || !firstCand || origText === firstCand) return null;
        const desc = String(s.description || "").trim();
        let type: "error" | "warn" | "suggest" = "error";
        if (/추천|권장|일 수 있|의심|가능성/.test(desc)) type = "suggest";
        else if (/띄어쓰기|공백/.test(desc)) type = "warn";
        return {
          text: origText,
          suggestion: firstCand,
          reason: desc.slice(0, 60) || "맞춤법·띄어쓰기",
          type,
          layer: "L4·부산대"
        };
      })
      .filter(Boolean);
  } finally {
    clearTimeout(t);
  }
}

// -----------------------------------------------------------------
// nara-speller.co.kr — HTML 응답, JS 변수 data 파싱
// -----------------------------------------------------------------
async function checkViaNaraSpeller(text: string): Promise<any[]> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const params = new URLSearchParams();
    params.append("text1", text);

    const resp = await fetch(NARA_SPELLER, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Origin: "https://nara-speller.co.kr",
        Referer: "https://nara-speller.co.kr/speller/",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
      },
      body: params.toString(),
      signal: controller.signal
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const html = await resp.text();
    return parseBusanHtml(html);
  } finally {
    clearTimeout(t);
  }
}

// -----------------------------------------------------------------
// speller.cs.pusan.ac.kr — 이전 URL (백업)
// -----------------------------------------------------------------
async function checkViaOldPusan(text: string): Promise<any[]> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const params = new URLSearchParams();
    params.append("text1", text);

    const resp = await fetch(OLD_PUSAN, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
        Referer: "http://speller.cs.pusan.ac.kr/"
      },
      body: params.toString(),
      signal: controller.signal
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const html = await resp.text();
    return parseBusanHtml(html);
  } finally {
    clearTimeout(t);
  }
}

// -----------------------------------------------------------------
// 부산대 HTML 응답 파싱 — data = [{errInfo: [...]}] 변수 추출
// -----------------------------------------------------------------
function parseBusanHtml(html: string): any[] {
  const patterns = [
    /(?:var\s+)?data\s*=\s*(\[[\s\S]*?\]);/,
    /errorInfo\s*=\s*(\[[\s\S]*?\]);/,
    /"errInfo"\s*:\s*(\[[\s\S]*?\])/
  ];

  let data: any = null;
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      try {
        data = JSON.parse(m[1]);
        break;
      } catch (e) {
        // 다음 패턴 시도
      }
    }
  }

  if (!data) throw new Error("응답에서 오류 데이터 추출 실패");

  const results: any[] = [];
  const items = Array.isArray(data) ? data : [data];
  for (const item of items) {
    const errInfo = Array.isArray(item.errInfo) ? item.errInfo : Array.isArray(item) ? item : [];
    for (const err of errInfo) {
      const orgStr = String(err.orgStr || err.original || "").trim();
      const candStr = String(err.candWord || err.candidate || err.suggestion || "").trim();
      if (!orgStr || !candStr) continue;
      const cands = candStr.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
      const firstCand = cands[0];
      if (!firstCand || firstCand === orgStr) continue;

      const help = String(err.help || err.description || "")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .trim();

      const method = Number(err.correctMethod || 0);
      let type: "error" | "warn" | "suggest" = "error";
      if (method === 2) type = "warn";
      else if (method >= 3 || /추천|권장|의심/.test(help)) type = "suggest";

      results.push({
        text: orgStr,
        suggestion: firstCand,
        reason: help.slice(0, 60) || "맞춤법·띄어쓰기",
        type,
        layer: "L4·부산대"
      });
    }
  }

  return results;
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
