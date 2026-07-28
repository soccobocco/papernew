// 메타데이터 자동 추출 — 사전 기반 (API 키 불필요)
// 한경TV 방송 원고에서 자주 등장하는 종목·기관·이벤트·섹터를 사전으로 매칭
// 나중에 Gemini free tier 로 문맥 이해 추가 가능 (아래 옵션 코드 참조)

// -----------------------------------------------------------------
// 사전 데이터 (필요시 확장)
// -----------------------------------------------------------------

// KOSPI/KOSDAQ 주요 종목 + 미국 빅테크
const TICKERS = [
  // 반도체
  "삼성전자", "SK하이닉스", "마이크론", "TSMC", "인텔", "AMD", "엔비디아", "브로드컴", "퀄컴", "삼성전기", "삼화콘덴서", "리노공업", "동진쎄미켐", "에스에프에이", "원익IPS", "한미반도체",
  // 자동차
  "현대차", "기아", "현대모비스", "만도", "현대위아", "한온시스템", "테슬라", "GM", "포드", "폭스바겐", "토요타",
  // 2차전지
  "LG에너지솔루션", "삼성SDI", "SK온", "포스코퓨처엠", "에코프로", "에코프로비엠", "엘앤에프", "CATL", "BYD",
  // 조선·방산
  "HD현대중공업", "HD한국조선해양", "삼성중공업", "한화오션", "현대미포조선", "한화에어로스페이스", "LIG넥스원", "현대로템", "한화시스템", "한국항공우주",
  // 바이오
  "삼성바이오로직스", "셀트리온", "SK바이오팜", "유한양행", "한미약품", "종근당", "일라이릴리", "노보노디스크",
  // 인터넷·게임
  "네이버", "카카오", "크래프톤", "엔씨소프트", "넷마블", "카카오게임즈", "위메이드", "메타", "구글", "알파벳", "아마존", "애플", "마이크로소프트", "MS",
  // 금융
  "KB금융", "신한지주", "하나금융지주", "우리금융지주", "삼성생명", "삼성화재", "미래에셋증권", "한국투자증권", "키움증권", "메리츠증권",
  // 화학·소재
  "LG화학", "롯데케미칼", "포스코퓨처엠", "포스코홀딩스", "고려아연", "POSCO", "현대제철",
  // 유통·화장품
  "아모레퍼시픽", "LG생활건강", "신세계", "이마트", "롯데쇼핑", "코스맥스", "한국콜마",
  // 전력·에너지
  "한전KPS", "두산에너빌리티", "OCI", "한화솔루션", "SK이노베이션", "S-Oil", "GS", "SK", "한국전력",
  // 미국 금융
  "골드만삭스", "JP모건", "모건스탠리", "뱅크오브아메리카", "웰스파고", "씨티그룹", "BlackRock", "블랙록",
  // AI/로봇
  "레인보우로보틱스", "로보스타", "유진로봇", "두산로보틱스", "티로보틱스", "스페이스X", "SpaceX",
  // 조선/원자재
  "한화엔진", "STX중공업"
];

// 기관·단체
const ORGANIZATIONS = [
  "연준", "미 연준", "Fed", "FRB", "FOMC", "미국 연준",
  "한국은행", "한은", "금통위", "금융통화위원회",
  "ECB", "유럽중앙은행", "BOJ", "일본은행", "PBOC", "인민은행",
  "MSCI", "FTSE", "S&P", "다우존스",
  "노무라", "골드만삭스", "JP모건", "모건스탠리", "HSBC", "UBS", "도이체방크", "블룸버그", "로이터", "CNBC", "월스트리트저널", "WSJ", "파이낸셜타임스", "FT",
  "IMF", "세계은행", "WTO", "OECD", "UN", "OPEC", "OPEC+",
  "삼성증권", "미래에셋증권", "한국투자증권", "키움증권", "메리츠증권", "NH투자증권", "대신증권", "하나증권", "KB증권", "신한투자증권",
  "금융감독원", "금감원", "금융위원회", "금융위", "기획재정부", "기재부", "산업통상자원부", "산자부", "통계청",
  "국립국어원",
  "TrendForce", "IDC", "Gartner", "가트너"
];

// 매크로 이벤트 (정규식 패턴)
const EVENT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /FOMC/g, label: "FOMC" },
  { re: /금통위|금융통화위원회/g, label: "금통위" },
  { re: /기준금리\s*(?:인상|인하|동결|결정)/g, label: "기준금리 결정" },
  { re: /MSCI\s*(?:선진국|편입|편출|관찰대상국|리밸런싱)/g, label: "MSCI 편입 이슈" },
  { re: /어닝\s*(?:서프라이즈|쇼크)/g, label: "어닝 시즌" },
  { re: /2분기\s*실적|3분기\s*실적|4분기\s*실적|1분기\s*실적/g, label: "실적 발표" },
  { re: /ADR\s*상장/g, label: "ADR 상장" },
  { re: /IPO|기업공개|공모청약/g, label: "IPO" },
  { re: /CPI|소비자물가/g, label: "CPI 발표" },
  { re: /PCE|개인소비지출/g, label: "PCE 발표" },
  { re: /고용보고서|비농업\s*고용|실업률/g, label: "고용지표" },
  { re: /GDP\s*(?:성장률|발표)/g, label: "GDP 발표" },
  { re: /무역수지|경상수지/g, label: "무역/경상수지" },
  { re: /테이퍼링|양적완화|QE|QT/g, label: "통화정책" },
  { re: /트럼프|바이든|시진핑|기시다|다카이치/g, label: "정치 이벤트" },
  { re: /관세|보복관세|보편관세/g, label: "관세 이슈" },
  { re: /반도체\s*수출\s*규제|반도체\s*제재|CHIPS Act|칩스법/g, label: "반도체 규제" }
];

// 섹터·테마
const SECTORS = [
  "반도체", "메모리", "파운드리", "HBM", "AI 반도체", "AI",
  "자동차", "전기차", "배터리", "2차전지", "2차 전지", "이차전지",
  "조선", "방산", "우주항공", "우주",
  "바이오", "제약", "헬스케어",
  "화장품", "K-뷰티", "K-팝", "엔터",
  "유통", "면세", "백화점", "관광",
  "금융", "은행", "증권", "보험",
  "게임", "메타버스", "웹툰",
  "전력기기", "신재생", "신재생에너지", "원자력", "원전", "태양광", "풍력", "수소",
  "로봇", "로보틱스", "휴머노이드",
  "화학", "정유", "석유화학", "철강",
  "건설", "부동산", "리츠",
  "통신", "5G", "6G",
  "MLCC", "OLED", "디스플레이"
];

// -----------------------------------------------------------------
// 핸들러
// -----------------------------------------------------------------
export default async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const text: string = String(body?.text || "");
  if (text.trim().length < 20) {
    return json({ error: "원고가 너무 짧습니다" }, 400);
  }

  // 사전 기반 추출
  const tickers = matchDictionary(text, TICKERS);
  const organizations = matchDictionary(text, ORGANIZATIONS);
  const events = matchPatterns(text, EVENT_PATTERNS);
  const sectors = matchDictionary(text, SECTORS);
  const questionSummaries = extractQuestions(text);

  return json({
    extract: {
      tickers,
      organizations,
      events,
      sectors,
      questionSummaries
    },
    source: "rule-based"
  });
};

// -----------------------------------------------------------------
// 사전 기반 매칭 — 원고에서 사전 항목이 등장한 것만 추출
// -----------------------------------------------------------------
function matchDictionary(text: string, dict: string[]): string[] {
  const found = new Set<string>();
  for (const item of dict) {
    // 단어 경계 없이 검색 (한글 특성상)
    if (text.includes(item)) {
      found.add(item);
    }
  }
  return Array.from(found).slice(0, 15);
}

function matchPatterns(
  text: string,
  patterns: Array<{ re: RegExp; label: string }>
): string[] {
  const found = new Set<string>();
  for (const { re, label } of patterns) {
    const localRe = new RegExp(re.source, re.flags);
    if (localRe.test(text)) {
      found.add(label);
    }
  }
  return Array.from(found).slice(0, 10);
}

// -----------------------------------------------------------------
// 질문 요약 추출 — 원고에서 (질문N) 또는 Q. 마커 뒤 첫 문장 뽑기
// -----------------------------------------------------------------
function extractQuestions(text: string): string[] {
  const lines = text.split("\n").map((l) => l.trim());
  const questions: string[] = [];
  let capturing = false;
  let buffer = "";
  const qMarkerRe = /\((질문[\d\-]+|추가질문[\d\-]+)\)/;
  const qSungtooRe = /^(?:Q\.|\d+\.)\s*(.+)$/;
  const speakerRe = /^[가-힣]{2,4}\s*(?:\/|>>)/;
  const cgRe = /^(좌상단|우측네임|좌측네임|네임S|서브|수퍼|하단S|월백|통CG|PPT)/;

  for (const line of lines) {
    if (!line) continue;

    // 성투 스타일 Q. 라인
    const qs = line.match(qSungtooRe);
    if (qs && qs[1].length > 10) {
      questions.push(summarize(qs[1]));
      continue;
    }

    // 마켓인사이트 스타일 (질문N) 이후 다음 라인부터
    if (qMarkerRe.test(line)) {
      if (buffer) {
        questions.push(summarize(buffer));
      }
      buffer = "";
      capturing = true;
      continue;
    }

    if (capturing) {
      // 새 발화자 or CG 지시어 만나면 종료
      if (speakerRe.test(line) || cgRe.test(line) || /답변|인사|내용 정리/.test(line)) {
        if (buffer) {
          questions.push(summarize(buffer));
          buffer = "";
        }
        capturing = false;
      } else {
        buffer += " " + line;
      }
    }
  }
  if (buffer) questions.push(summarize(buffer));

  return questions.slice(0, 12);
}

function summarize(text: string): string {
  // 첫 문장만 or 20자 요약
  const clean = text.replace(/\s+/g, " ").trim();
  const firstSent = clean.split(/[?.!]/)[0].trim();
  if (firstSent.length <= 25) return firstSent;
  return firstSent.slice(0, 22) + "...";
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export const config = {
  path: "/api/extract"
};
