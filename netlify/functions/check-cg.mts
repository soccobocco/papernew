// CG 대조 검수 프록시 — Gemini Vision 이 OCR + 대조 검수를 한 번에 수행
//
// 이전 버전 (규칙 기반 대조) 은 다음 문제가 있었음:
//   1. 의뢰서 파싱 시 축 라벨·데이터·주석·Y축 눈금이 모두 하나의 배열로 뒤섞임
//   2. 대조 시 "문자열 포함 여부"만 확인 → 축과 값의 매칭 관계 놓침
//   3. 특별 지시사항 ("레퍼런스처럼", "수출만" 등) 을 CG에 있어야 할 내용으로 오해
//
// 새 버전:
//   - 의뢰서 원본 텍스트 + CG 이미지를 함께 Gemini 에게 전달
//   - 프롬프트로 명확히 지시: 특별 지시사항 무시, Y축 눈금 vs 데이터 값 구분,
//     축 라벨-값-주석 매칭 검증
//   - Gemini 가 JSON 으로 issues[] 반환
//
// 입력 body: { cgId, itemIndex, imageBase64, imageMimeType }
// 출력: { success, reviewResult: { ocrResult, issues, ... }, status }

import { getStore } from "@netlify/blobs";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const TIMEOUT_MS = 90000;   // OCR + 대조까지 하니 여유 있게

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

  // 2. Gemini 호출 (OCR + 대조를 한 번에)
  let geminiResult: any = null;
  try {
    geminiResult = await callGeminiReview(imageBase64, imageMimeType, targetItem, apiKey);
  } catch (e: any) {
    return json({ error: "Gemini 호출 실패: " + e.message }, 500);
  }

  if (!geminiResult || geminiResult.ocrTitle === undefined) {
    return json({
      error: "이미지 분석 결과 파싱 실패",
      raw: geminiResult
    }, 422);
  }

  // 3. 결과 정리
  const ocrResult = {
    title: geminiResult.ocrTitle,
    subtitle: geminiResult.ocrSubtitle || null,
    dataPoints: Array.isArray(geminiResult.ocrDataPoints) ? geminiResult.ocrDataPoints : [],
    footnotes: Array.isArray(geminiResult.ocrFootnotes) ? geminiResult.ocrFootnotes : [],
    colorMapping: Array.isArray(geminiResult.ocrColorMapping) ? geminiResult.ocrColorMapping : [],
    notes: geminiResult.notes || null
  };

  const issues: any[] = Array.isArray(geminiResult.issues) ? geminiResult.issues : [];
  const issueCount = issues.filter((x: any) => x.severity !== "info").length;
  const criticalCount = issues.filter((x: any) => x.severity === "critical").length;

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

  // 4. 의뢰서에 결과 저장
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

// ===== Gemini 호출 =====
async function callGeminiReview(imageBase64: string, mimeType: string, targetItem: any, apiKey: string): Promise<any> {
  const requestText = buildRequestText(targetItem);
  const prompt = buildComparisonPrompt(requestText);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
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

    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("Gemini 응답 JSON 파싱 실패: " + text.slice(0, 300));
    }
  } finally {
    clearTimeout(t);
  }
}

// 의뢰서 원본을 구조화된 텍스트로 재구성
function buildRequestText(item: any): string {
  const parts: string[] = [];

  parts.push(`## 제목`);
  parts.push(item.title || "(없음)");
  parts.push("");

  parts.push(`## 부제 (기준일·범례 등)`);
  parts.push(item.subtitle || "(없음)");
  parts.push("");

  if (item.graphType) {
    parts.push(`## 그래프 종류`);
    parts.push(item.graphType);
    parts.push("");
  }

  parts.push(`## 데이터 항목 (CG 화면에 반드시 표시되어야 하는 내용)`);
  const rows = item.dataRows || [];
  if (rows.length > 0) {
    for (const r of rows) parts.push(`- ${r}`);
  } else {
    parts.push("(없음)");
  }
  parts.push("");

  parts.push(`## ⚠️ CG팀에게 하는 지시사항 (CG 화면에는 절대 나타나지 않아야 함 — 검수 대상 아님)`);
  const instructions = item.specialInstructions || [];
  if (instructions.length > 0) {
    for (const inst of instructions) parts.push(`- ${inst}`);
  } else {
    parts.push("(없음)");
  }

  return parts.join("\n");
}

// 대조 검수 프롬프트
function buildComparisonPrompt(requestText: string): string {
  return `너는 한국 방송사(한국경제TV) 의 CG (Computer Graphics · 방송 그래픽) 검수 도구다.

의뢰서에 지시된 내용대로 완성된 CG 이미지가 만들어졌는지 대조 검수를 정확히 수행해줘.

# 의뢰서 원본

${requestText}

# 검수 방법

첨부된 이미지가 완성된 CG 다. 이 이미지를 자세히 관찰하고 의뢰서와 대조해서 모든 오류를 찾아라.

## 🚫 반드시 무시해야 할 것

"CG팀에게 하는 지시사항" 섹션의 내용은 **CG 화면에 나타나지 않아야 하는** 지시사항이다:
- "레퍼런스처럼", "이런 스타일로 그려주세요"
- "파란색으로", "빨간색으로" 같은 색상 지시
- "수출만, 수입제외" 같은 데이터 필터링 지시
- "아래 CG 참고 부탁드립니다", "첫째주 삭제해주세요" 같은 요청 사항
- "(수출만, 수입제외)" 같은 괄호 표기 지시

**이런 내용이 CG 이미지에 없다고 오류로 잡지 마라.** 원래 CG에 있으면 안 되는 것들이다.

## ✅ 반드시 검증해야 할 것

1. **제목**: 의뢰서 "제목" 섹션과 CG 최상단 큰 제목이 일치하는가
2. **부제·기준일**: 의뢰서 "부제" 섹션 (※ 로 시작하거나 기준·단위 정보) 이 CG에 반영됐는가
3. **데이터 값 (숫자)**: 자릿수, 콤마, 단위(조/억/만/원/%/위안/달러 등) 정확히 일치
4. **주석·라벨**: +71% 같은 증감률 주석이 올바른 값이고 깨지지 않았는가
5. **축 라벨-데이터-주석 매칭**: 각 데이터 포인트가 올바른 축 라벨(월/년도/회사명)과 대응하는가
6. **누락 항목**: 의뢰서 "데이터 항목" 에 있는데 CG에 없는 것
7. **임의 추가**: CG에 있는데 의뢰서에 없는 것
8. **색상 지시 준수**: 데이터 항목 안에 "파란색: 영업이익" 같은 색상 지시가 있으면 CG에서 그렇게 반영됐는가

## 📊 Y축 눈금 vs 실제 데이터 값 구분

라인·바 그래프의 경우:
- **Y축 눈금** (예: 500, 600, 700, 800, 900, 1000 이렇게 규칙적으로 나열된 숫자) → **그래프 배경 눈금**, 검증 대상 아님
- **실제 데이터 포인트 값** (예: 658, 677, 873...) → 검증 대상

의뢰서 "데이터 항목" 에 Y축 눈금도 함께 들어있을 수 있는데, 그건 규칙적인 등간격 숫자 (100 단위 등) 로 알아볼 수 있다.

# 반환 형식 (반드시 JSON)

{
  "ocrTitle": "이미지 최상단 제목 (텍스트 못 읽었으면 null)",
  "ocrSubtitle": "이미지의 부제 · 기준일 (있으면)",
  "ocrDataPoints": [
    {"label": "축 라벨 (예: '26년 1월', 'HD현대중공업 2025')", "value": "데이터 값 (예: '658', '4조 1471억')", "annotation": "주석 (예: '+71%', 없으면 null)"}
  ],
  "ocrFootnotes": ["각주·출처·단위 정보"],
  "ocrColorMapping": [
    {"item": "매출 or 영업이익 등 계열명", "color": "진한 파랑 / 연한 파랑 / 빨강 등"}
  ],
  "notes": "그 외 관찰된 특이사항 (있으면, 없으면 null)",
  "issues": [
    {
      "severity": "critical" | "warn" | "info",
      "type": "title-mismatch" | "subtitle-mismatch" | "number-mismatch" | "annotation-broken" | "text-missing" | "text-extra" | "color-mismatch" | "layout-issue",
      "message": "오류의 간단한 한국어 설명 (맥락 포함)",
      "expected": "의뢰서에 있던 내용 (원문 그대로)",
      "actual": "CG에 있는 내용 (원문 그대로)"
    }
  ]
}

## severity 기준

- **critical**: 방송 사고급 오류
  - 숫자 값 자체가 다름 (예: 의뢰 980 → CG 989)
  - 주석 값이 깨짐 (예: 의뢰 "+61%" → CG "+989, 63%")
  - 아예 다른 CG (제목 자체가 완전히 다름)
  - 색상 지시 반전 (파란색↔빨간색 등)
- **warn**: 오탈자·부제 차이·미묘한 텍스트 차이
- **info**: 참고 수준 (CG에만 있는 부가 정보 등)

## 특히 놓치지 말아야 할 오류 예시

- 의뢰서 "980 +61%" ↔ CG "989 +989,63%" → 값도 다르고 주석도 깨진 심각한 오류 두 개
- 의뢰서 "9,300" ↔ CG "9,030" → 자릿수 실수, 심각
- 의뢰서 "SK하이닉스 컨콜 주요 내용" ↔ CG "SK하이닉스 분기별 실적 추이" → 완전히 다른 CG, 방송사고급
- 의뢰서 "파란색: 영업이익, 연한 파란색: 매출" ↔ CG 색상 반대로 → 색상 지시 미준수

이미지에서 텍스트를 하나도 못 추출하면 ocrTitle 을 null.
오류가 하나도 없으면 issues 를 빈 배열로.`;
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
