// AI 검수 프록시 — 네이버 맞춤법 검사기 사용 (무료·API 키 불필요)
// 원고를 청크로 나눠서 네이버에 순차 요청, 결과를 통합 반환

const NAVER_URL = "https://m.search.naver.com/p/csearch/ocontent/util/SpellerProxy";
const CHUNK_SIZE = 480; // 네이버 한 번에 처리 가능한 대략 최대치
const MAX_CHUNKS = 12;

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

  // CG 지시어 라인은 제외하고 검수 (본문만)
  const filteredText = filterOutCGLines(rawText);

  // 청크 나누기 (문장 경계 유지)
  const chunks = chunkByLines(filteredText, CHUNK_SIZE).slice(0, MAX_CHUNKS);

  const allChecks: any[] = [];
  const errors: string[] = [];

  for (const chunk of chunks) {
    try {
      const naverChecks = await checkWithNaver(chunk);
      allChecks.push(...naverChecks);
    } catch (e: any) {
      errors.push(e.message || "청크 오류");
    }
  }

  // 중복 제거 (같은 text→suggestion 조합)
  const seen = new Set();
  const deduped = allChecks.filter((c) => {
    const key = c.text + "|" + c.suggestion;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return json({
    checks: deduped,
    source: "naver",
    chunks: chunks.length,
    ...(errors.length > 0 ? { warnings: errors } : {})
  });
};

// -----------------------------------------------------------------
// 네이버 맞춤법 검사기 호출
// -----------------------------------------------------------------
async function checkWithNaver(text: string): Promise<any[]> {
  const callback = "jQuery" + Date.now();
  const url = new URL(NAVER_URL);
  url.searchParams.set("_callback", callback);
  url.searchParams.set("q", text);
  url.searchParams.set("where", "nexearch");
  url.searchParams.set("color_blindness", "0");

  const resp = await fetch(url.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://search.naver.com/",
      Accept: "*/*",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8"
    }
  });

  if (!resp.ok) {
    throw new Error(`Naver ${resp.status}`);
  }

  const jsonp = await resp.text();

  // JSONP 언랩핑: "jQuery1234567890({ ... });"
  const start = jsonp.indexOf("(");
  const end = jsonp.lastIndexOf(")");
  if (start < 0 || end <= start) {
    throw new Error("JSONP 형식 오류");
  }
  const jsonStr = jsonp.slice(start + 1, end);

  let data: any;
  try {
    data = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error("JSON 파싱 실패");
  }

  const result = data?.message?.result;
  if (!result) return [];

  const errataCount = Number(result.errata_count || 0);
  if (errataCount === 0) return [];

  // 응답의 `html` 필드는 원문에 오류가 마크업된 형태
  // <span class="re_word wrap_error"...>단어</span> 패턴 추출
  const html: string = String(result.html || result.origin_html || "");

  return parseNaverHtml(html);
}

// -----------------------------------------------------------------
// 네이버 응답 HTML 파싱 — 오류 마크업 추출
// 실제 마크업 예시:
//   <span class="re_word wrap_error" data-error-input="되요" data-error-output="돼요" data-error-type="0">
//     되요
//   </span>
// -----------------------------------------------------------------
function parseNaverHtml(html: string): any[] {
  const results: any[] = [];

  // 여러 마크업 패턴에 대응
  const patterns = [
    // 최신 포맷: data 속성 있음
    /<span[^>]*class="[^"]*(?:re_word|wrap_error)[^"]*"[^>]*data-error-input="([^"]+)"[^>]*data-error-output="([^"]+)"[^>]*(?:data-error-help="([^"]*)")?[^>]*>[\s\S]*?<\/span>/gi,
    // 대안 포맷: 태그 내부 스판 구조
    /<span[^>]*class="[^"]*wrap_error[^"]*"[^>]*>\s*<span[^>]*class="[^"]*txt_word[^"]*"[^>]*>([^<]+)<\/span>[\s\S]*?<span[^>]*class="[^"]*ori_word[^"]*"[^>]*>([^<]+)<\/span>[\s\S]*?(?:<span[^>]*class="[^"]*tooltip_help[^"]*"[^>]*>([^<]+)<\/span>)?[\s\S]*?<\/span>/gi
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    const localRe = new RegExp(re.source, re.flags);
    while ((m = localRe.exec(html)) !== null) {
      const text = stripTags(m[1] || "").trim();
      const suggestion = stripTags(m[2] || "").trim();
      const reason = stripTags(m[3] || "").trim() || "맞춤법·띄어쓰기";
      if (text && suggestion && text !== suggestion) {
        results.push({
          text,
          suggestion,
          reason: reason.slice(0, 60),
          type: "error",
          layer: "L4·Naver"
        });
      }
    }
    if (results.length > 0) break; // 첫 번째로 성공한 패턴만 사용
  }

  return results;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
}

// -----------------------------------------------------------------
// CG 지시어 라인 제거 (검수 대상에서 제외)
// -----------------------------------------------------------------
function filterOutCGLines(text: string): string {
  const lines = text.split("\n");
  const skipRe = /^(좌상단S?|우측네임|좌측네임|네임S|서브(?:\([12]단\))?|수퍼|하단S?|월백|통CG|월백\s*통CG|월백S|PPT\s*\d+)\s*>/;
  const filtered = lines.filter((l) => !skipRe.test(l.trim()));
  return filtered.join("\n");
}

// -----------------------------------------------------------------
// 텍스트를 라인 단위로 청크 나누기 (한 청크 대략 CHUNK_SIZE 문자)
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
