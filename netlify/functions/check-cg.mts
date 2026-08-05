// CG 대조 검수 프록시 — Gemini Vision API + 텍스트 대조 로직
//
// 입력 body: { cgId, itemIndex, imageBase64, imageMimeType }
// - cgId: 저장된 CG 의뢰서 ID
// - itemIndex: 여러 CG 중 검수 대상 (기본 0)
// - imageBase64: 완성 CG 이미지 (data URL 접두어 없이 순수 base64)
// - imageMimeType: "image/jpeg" 또는 "image/png"
//
// 처리 흐름:
// 1. Netlify Blobs 에서 의뢰서 로드
// 2. Gemini Vision 으로 이미지에서 텍스트·색상 추출
// 3. 의뢰서 데이터와 대조 → 오류 목록 생성
// 4. 결과 반환 + 의뢰서에 저장 (deliveryImageKey, ocrResult, reviewResult)

import { getStore } from "@netlify/blobs";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const TIMEOUT_MS = 60000;   // Vision 은 좀 오래 걸릴 수 있음

const EXTRACT_PROMPT = `너는 한국 방송용 CG(방송 그래픽) 이미지 검수 도구다.
이미지 속 모든 텍스트를 원문 그대로 정확히 추출해줘.

특히 중요한 규칙:
- 숫자는 반드시 자릿수·콤마·단위(조/억/만/원/%/위안/달러 등)까지 정확히
- 글자 하나라도 빠뜨리거나 바꾸지 말고 원문 그대로
- 표 형식이면 각 셀을 하나의 항목으로
- 색상 정보도 관찰 (그래프 계열이 어떤 색인지)

반환은 반드시 아래 JSON 스키마로:
{
  "title": "이미지 최상단의 큰 제목",
  "subtitle": "부제·기준일 (있으면, 없으면 null)",
  "dataItems": ["텍스트 항목", "다른 항목", ...],
  "footnotes": ["각주·출처·단위 정보"],
  "colorMapping": [
    {"item": "매출 or 영업이익 등 계열명", "color": "진한 파랑 / 연한 파랑 / 빨강 등"}
  ],
  "notes": "그 외 관찰된 특이사항 (있으면)"
}

이미지에서 텍스트를 하나도 추출할 수 없으면 title 을 null 로 반환.`;

export default async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({
      error: "서버 설정 오류 - GEMINI_API_KEY 미등록",
      hint: "Netlify 환경변수에 GEMINI_API_KEY 등록 필요"
    }, 500);
  }

  let body: any;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400);
  }

  const cgId = String(body?.cgId || "").trim();
  const itemIndex = parseInt(body?.itemIndex ?? "0") || 0;
  const imageBase64 = String(body?.imageBase64 || "").trim();
  const imageMimeType = String(body?.imageMimeType || "image/jpeg").trim();

  if (!cgId) return json({ error: "cgId 누락" }, 400);
  if (!imageBase64 || imageBase64.length < 100) return json({ error: "이미지 데이터 없음" }, 400);

  // 1. 의뢰서 로드
  const store = getStore("airscript-cg-requests");
  let cgRequest: any;
  try {
    cgRequest = await store.get(`cg:${cgId}`, { type: "json" });
    if (!cgRequest) return json({ error: "의뢰서를 찾을 수 없음" }, 404);
  } catch (e: any) {
    return json({ error: "의뢰서 로드 실패: " + e.message }, 500);
  }

  const items = cgRequest.items || [];
  const targetItem = items[itemIndex] || items[0];
  if (!targetItem) return json({ error: "검수 대상 CG 항목 없음" }, 400);

  // 2. Gemini Vision 호출
  let ocrResult: any = null;
  try {
    ocrResult = await callGeminiVision(imageBase64, imageMimeType, apiKey);
  } catch (e: any) {
    return json({ error: "Gemini 호출 실패: " + e.message }, 500);
  }

  if (!ocrResult || !ocrResult.title) {
    return json({
      error: "이미지에서 텍스트를 추출하지 못했습니다",
      ocrResult
    }, 422);
  }

  // 3. 대조 검수
  const issues = compareRequestVsOCR(targetItem, ocrResult);
  const issueCount = issues.filter((x: any) => x.severity !== "info").length;
  const criticalCount = issues.filter((x: any) => x.severity === "critical").length;

  // 상태 판정: critical 있으면 issue, 그 외 있으면 issue (경고도 issue), 없으면 matched
  const newStatus = criticalCount > 0 || issueCount > 0 ? "issue" : "matched";

  const reviewResult = {
    itemIndex,
    itemNumber: targetItem.number,
    checkedAt: new Date().toISOString(),
    ocrResult,
    issues,
    issueCount,
    criticalCount,
    verdict: newStatus === "matched" ? "통과" : `오류 ${issueCount}건 (심각 ${criticalCount}건)`
  };

  // 4. 의뢰서에 저장
  try {
    const updated = {
      ...cgRequest,
      status: newStatus,
      reviewResult,
      updatedAt: new Date().toISOString()
    };
    await store.setJSON(`cg:${cgId}`, updated);
  } catch (e) {
    console.error("의뢰서 업데이트 실패", e);
  }

  return json({
    success: true,
    reviewResult,
    status: newStatus
  });
};

// ===== Gemini Vision 호출 =====
async function callGeminiVision(imageBase64: string, mimeType: string, apiKey: string): Promise<any> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: EXTRACT_PROMPT },
            { inline_data: { mime_type: mimeType, data: imageBase64 } }
          ]
        }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1
        }
      }),
      signal: controller.signal
    });

    if (!resp.ok) {
      let errBody: any = null;
      try { errBody = await resp.json(); } catch {}
      const errMsg = errBody?.error?.message || `HTTP ${resp.status}`;
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`인증 실패 - API 키 확인 (${errMsg})`);
      }
      if (resp.status === 429) {
        throw new Error(`할당량 초과 - 하루 1,500 요청 제한 (${errMsg})`);
      }
      throw new Error(errMsg);
    }

    const data: any = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!text) throw new Error("Gemini 응답이 비어있음");

    // JSON 파싱
    try {
      return JSON.parse(text);
    } catch (e) {
      // JSON 아니면 문자열 그대로 반환
      throw new Error("Gemini 응답 파싱 실패: " + text.slice(0, 200));
    }
  } finally {
    clearTimeout(t);
  }
}

// ===== 대조 검수 로직 =====
function compareRequestVsOCR(item: any, ocr: any): any[] {
  const issues: any[] = [];

  const reqTitle = String(item.title || "").trim();
  const ocrTitle = String(ocr.title || "").trim();
  const reqSubtitle = String(item.subtitle || "").trim();
  const ocrSubtitle = String(ocr.subtitle || "").trim();
  const reqDataRows: string[] = (item.dataRows || []).map((x: any) => String(x || "").trim()).filter(Boolean);
  const ocrDataItems: string[] = [
    ...(Array.isArray(ocr.dataItems) ? ocr.dataItems : []),
    ...(Array.isArray(ocr.footnotes) ? ocr.footnotes : [])
  ].map(x => String(x || "").trim()).filter(Boolean);
  const instructions: string[] = (item.specialInstructions || []).map((x: any) => String(x || "").trim()).filter(Boolean);

  // [1] 제목 대조
  if (reqTitle && ocrTitle) {
    const sim = titleSimilarity(reqTitle, ocrTitle);
    if (sim < 0.3) {
      // 매우 다름 → 아예 다른 CG
      issues.push({
        severity: "critical",
        type: "title-mismatch",
        message: "제목이 완전히 다릅니다 — 잘못된 CG 가 만들어졌을 수 있습니다",
        expected: reqTitle,
        actual: ocrTitle
      });
    } else if (sim < 0.85) {
      issues.push({
        severity: "warn",
        type: "title-diff",
        message: "제목이 다릅니다 (오탈자 또는 표현 차이)",
        expected: reqTitle,
        actual: ocrTitle
      });
    }
  } else if (reqTitle && !ocrTitle) {
    issues.push({
      severity: "warn",
      type: "title-missing",
      message: "CG에서 제목을 찾을 수 없음",
      expected: reqTitle,
      actual: "(없음)"
    });
  }

  // [2] 부제 대조
  if (reqSubtitle) {
    const sim = titleSimilarity(reqSubtitle, ocrSubtitle);
    if (!ocrSubtitle || sim < 0.6) {
      issues.push({
        severity: "warn",
        type: "subtitle-diff",
        message: ocrSubtitle ? "부제가 다름" : "부제가 CG에 없음",
        expected: reqSubtitle,
        actual: ocrSubtitle || "(없음)"
      });
    }
  }

  // [3] 숫자 대조 (가장 중요)
  const reqNumbers = extractNumbers(reqDataRows.join(" ") + " " + reqTitle + " " + reqSubtitle);
  const ocrNumbers = extractNumbers(ocrDataItems.join(" ") + " " + ocrTitle + " " + ocrSubtitle);

  // 의뢰서 숫자 중 CG 에 없는 것
  for (const rn of reqNumbers) {
    const found = ocrNumbers.some(on => numbersEqual(rn, on));
    if (!found) {
      // 근사 매치 찾기 (자릿수만 다른 경우 등)
      const near = ocrNumbers.find(on => numbersNear(rn, on));
      if (near) {
        issues.push({
          severity: "critical",
          type: "number-diff",
          message: "숫자 자릿수·값 불일치 (오탈자 위험)",
          expected: rn.original,
          actual: near.original
        });
      } else {
        issues.push({
          severity: "warn",
          type: "number-missing",
          message: "의뢰서에 있는 숫자가 CG 에서 안 보임",
          expected: rn.original,
          actual: "(없음)"
        });
      }
    }
  }

  // CG 에는 있는데 의뢰서에 없는 숫자 (참고용)
  for (const on of ocrNumbers) {
    const found = reqNumbers.some(rn => numbersEqual(on, rn));
    const near = reqNumbers.some(rn => numbersNear(on, rn));
    if (!found && !near) {
      issues.push({
        severity: "info",
        type: "number-extra",
        message: "CG 에만 있는 숫자 (임의 추가 가능성)",
        expected: "(의뢰서에 없음)",
        actual: on.original
      });
    }
  }

  // [4] 데이터 항목 텍스트 대조 (숫자 제외한 문자 내용)
  const reqTexts = extractNonNumericTexts(reqDataRows);
  const ocrAllText = ocrDataItems.join(" ") + " " + ocrTitle + " " + ocrSubtitle;
  for (const rt of reqTexts) {
    if (rt.length < 2) continue;
    if (!ocrAllText.includes(rt)) {
      // 유사 문자열 찾기
      const similar = findSimilarSubstring(rt, ocrAllText);
      if (similar && similar.similarity > 0.7 && similar.similarity < 1) {
        issues.push({
          severity: "warn",
          type: "text-diff",
          message: "텍스트 오탈자 가능성",
          expected: rt,
          actual: similar.text
        });
      } else if (!similar) {
        issues.push({
          severity: "warn",
          type: "text-missing",
          message: "의뢰서 항목이 CG 에서 안 보임",
          expected: rt,
          actual: "(없음)"
        });
      }
    }
  }

  // [5] 색상 지시 대조 (specialInstructions or dataRows 안에 색상 지시 있는지)
  //     예: "파란색: 영업이익, 연한 파란색: 매출"
  const colorInstructions = extractColorInstructions([...reqDataRows, ...instructions]);
  const colorMap: any[] = Array.isArray(ocr.colorMapping) ? ocr.colorMapping : [];
  for (const ci of colorInstructions) {
    // ci = { item: "영업이익", color: "파란색" }
    // ocr colorMap 에서 같은 항목 찾기
    const found = colorMap.find(cm => (cm.item || "").includes(ci.item) || ci.item.includes(cm.item || ""));
    if (found) {
      // 색상 매칭 검사 (진한/연한 포함)
      const expectedColor = normalizeColor(ci.color);
      const actualColor = normalizeColor(found.color || "");
      if (!colorsMatch(expectedColor, actualColor)) {
        issues.push({
          severity: "critical",
          type: "color-mismatch",
          message: `"${ci.item}" 의 색상 지시가 반영되지 않음`,
          expected: `${ci.item}: ${ci.color}`,
          actual: `${ci.item}: ${found.color}`
        });
      }
    }
  }

  return issues;
}

// ===== 헬퍼: 숫자 추출 =====
interface NumInfo { original: string; normalized: string; value: number; unit: string; }

function extractNumbers(text: string): NumInfo[] {
  // 예: "9,300", "1,023", "8.66위안", "3조 2천억", "465.8%", "40조원"
  const re = /(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]+)?)\s*(조|억|만|원|%|위안|달러|배|명|건|위|점|건원)?/g;
  const results: NumInfo[] = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const original = m[0].trim();
    const numStr = m[0].replace(/,/g, "").replace(/[^\d.]/g, "");
    const value = parseFloat(numStr);
    if (isNaN(value)) continue;
    const unit = (m[1] || "").trim();
    // "3조 2천억" 같은 복합 표현은 안 잡음 (단순 매칭)
    results.push({
      original,
      normalized: numStr + unit,
      value,
      unit
    });
  }
  return results;
}

function numbersEqual(a: NumInfo, b: NumInfo): boolean {
  return a.value === b.value && a.unit === b.unit;
}

function numbersNear(a: NumInfo, b: NumInfo): boolean {
  // 같은 단위 & 값이 자릿수만 다르거나 (오타 위험) 매우 유사
  if (a.unit !== b.unit) return false;
  if (a.value === b.value) return false;
  // 자릿수 다른 경우 (예: 9,300 vs 9,030)
  const sa = String(a.value);
  const sb = String(b.value);
  if (sa.length !== sb.length) return false;
  // 한 두 자리 다른 경우
  let diff = 0;
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) diff++;
  return diff <= 2 && sa.length >= 3;
}

// ===== 헬퍼: 텍스트 유사도 =====
function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const na = a.replace(/\s+/g, "");
  const nb = b.replace(/\s+/g, "");
  if (na === nb) return 1;
  const longer = na.length > nb.length ? na : nb;
  const shorter = na.length > nb.length ? nb : na;
  if (!longer.length) return 1;
  // Levenshtein 거리 기반 유사도
  const dist = levenshtein(na, nb);
  return (longer.length - dist) / longer.length;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp: number[][] = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function extractNonNumericTexts(rows: string[]): string[] {
  // 각 행에서 순수 텍스트 부분만 (숫자·기호 최소 2글자 이상 한글·영문 덩어리)
  const results: string[] = [];
  for (const r of rows) {
    // 숫자·%·조·억·... 제거하고 남은 텍스트
    const stripped = r.replace(/[0-9,\.\s%]+(?:조|억|만|원|위안|달러|배|명|건|위|점)?/g, " ").trim();
    // 3글자 이상 청크
    const chunks = stripped.split(/[\s,·:()\/\+\-]+/).filter(x => x.length >= 3);
    results.push(...chunks);
  }
  return [...new Set(results)];
}

function findSimilarSubstring(needle: string, haystack: string): { text: string, similarity: number } | null {
  if (!needle || !haystack) return null;
  const nlen = needle.length;
  let best: { text: string, similarity: number } | null = null;
  // 슬라이딩 윈도우로 유사한 부분 찾기
  const windowSize = Math.max(2, nlen);
  for (let i = 0; i <= haystack.length - windowSize; i++) {
    const window = haystack.slice(i, i + windowSize);
    const sim = titleSimilarity(needle, window);
    if (sim > (best?.similarity || 0)) best = { text: window, similarity: sim };
  }
  return (best && best.similarity > 0.5) ? best : null;
}

// ===== 헬퍼: 색상 지시 파싱 =====
function extractColorInstructions(lines: string[]): { item: string; color: string }[] {
  const results: { item: string; color: string }[] = [];
  const colorNames = ["파란색", "빨간색", "빨강", "노란색", "초록색", "녹색", "검정", "흰색", "회색", "주황색", "보라색", "핑크", "분홍색"];
  for (const line of lines) {
    // 패턴 1: "파란색: 영업이익 , 연한 파란색 : 매출"
    // 패턴 2: "영업이익 - 파란색"
    const parts = line.split(/[,、]/);
    for (const part of parts) {
      // "파란색 : 영업이익" or "영업이익 : 파란색"
      const m = part.match(/^\s*(?:(연한|진한)\s*)?([^:]+?)\s*[:：]\s*(?:(연한|진한)\s*)?(.+?)\s*$/);
      if (m) {
        const left = ((m[1] || "") + " " + m[2]).trim();
        const right = ((m[3] || "") + " " + m[4]).trim();
        // 어느 쪽이 색상인지 판별
        const leftIsColor = colorNames.some(c => left.includes(c));
        const rightIsColor = colorNames.some(c => right.includes(c));
        if (leftIsColor && !rightIsColor) {
          results.push({ item: right, color: left });
        } else if (rightIsColor && !leftIsColor) {
          results.push({ item: left, color: right });
        }
      }
    }
  }
  return results;
}

function normalizeColor(s: string): { base: string; modifier: string } {
  const lower = s.toLowerCase().replace(/\s+/g, "");
  let modifier = "";
  if (/연한|light|옅은|밝은/.test(lower)) modifier = "light";
  else if (/진한|dark|짙은/.test(lower)) modifier = "dark";
  let base = "";
  if (/파란|파랑|blue|남색|navy/.test(lower)) base = "blue";
  else if (/빨간|빨강|red|주홍/.test(lower)) base = "red";
  else if (/노란|노랑|yellow/.test(lower)) base = "yellow";
  else if (/초록|녹색|green/.test(lower)) base = "green";
  else if (/회색|gray|grey/.test(lower)) base = "gray";
  else base = lower;
  return { base, modifier };
}

function colorsMatch(a: { base: string; modifier: string }, b: { base: string; modifier: string }): boolean {
  if (a.base !== b.base) return false;
  // modifier 가 다르면 불일치 (연한 vs 진한)
  if (a.modifier && b.modifier && a.modifier !== b.modifier) return false;
  return true;
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export const config = {
  path: "/api/check-cg"
};
