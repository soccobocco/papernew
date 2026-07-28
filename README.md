# AIRSCRIPT · 방송 원고 자동검수 & STOCK

한국경제TV 제작1부 대상 원고 검수 · 아카이빙 웹 프로토타입 (**API 키·유료결제 불필요**).

## 특징

- ✅ **DOCX 파일 자동 파싱** (드래그·드롭)
- ✅ **네이버 맞춤법 검사기** 통합 (완전 무료, API 키 불필요)
- ✅ **사전 기반 자동 태깅** — 종목·기관·이벤트·섹터 자동 추출
- ✅ **팀 공유 아카이브** — Netlify Blobs 사용
- ✅ **GitHub → Netlify 자동 배포** 

## 구성

```
airscript-netlify/
├── index.html              ← 프론트엔드 (수정 시 이 파일만 교체)
├── netlify.toml            ← Netlify 설정
├── package.json            ← @netlify/blobs 의존성
├── setup.sh                ← Git 세팅 자동화 스크립트
├── README.md               ← 배포 안내
└── netlify/functions/
    ├── check.mts           ← POST /api/check       · 네이버 맞춤법 검사기 프록시
    ├── extract.mts         ← POST /api/extract     · 사전 기반 메타데이터 추출
    └── manuscripts.mts     ← GET/POST/DELETE       · 아카이브 CRUD
```

---

## 🚀 배포 절차 (총 10분, 한 번만)

### 사전 준비

- **Git** 설치 (macOS/Linux 기본 설치, Windows: https://git-scm.com)
- **GitHub 계정**
- **Netlify 계정** (GitHub 계정으로 로그인 가능)

### 단계별 진행

#### 1️⃣ Git 세팅 스크립트 실행

```bash
cd airscript-netlify
bash setup.sh
```

스크립트가 자동으로:
- Git 저장소 초기화
- 사용자 정보 세팅 (이메일·이름 입력만)
- 최초 커밋 생성
- 다음 단계 명령어 안내

#### 2️⃣ GitHub 저장소 생성 & Push

- https://github.com/new → 저장소 이름 `airscript`, private 권장
- 스크립트가 알려준 명령어 실행:
  ```bash
  git remote add origin https://github.com/[본인아이디]/airscript.git
  git push -u origin main
  ```

#### 3️⃣ Netlify 연결

- https://app.netlify.com → **Add new site** → **Import an existing project**
- **Deploy with GitHub** 선택 → 방금 만든 `airscript` 저장소 선택
- Build 설정은 자동 인식됨 (그대로 진행)
- **Deploy site** 클릭

배포 완료되면 `https://xxx-xxx.netlify.app` URL 제공됨.

---

## 🔄 이후 수정 & 자동 재배포

### 수정 → 자동 배포 (1 커밋 = 1 배포)

```bash
# 파일 수정 후
git add .
git commit -m "무슨 변경했는지"
git push
```

**끝.** 1~2분 뒤 Netlify가 알아서 재배포합니다. 별도 로그인·클릭 필요 없음.

### 무엇을 수정할 수 있나

| 파일 | 이럴 때 수정 |
|---|---|
| `index.html` | UI 개선, 파서 규칙 추가, 새 화면 추가 |
| `netlify/functions/check.mts` | 맞춤법 검수 로직 (다른 API 로 교체 등) |
| `netlify/functions/extract.mts` | 종목·기관 사전 확장, 이벤트 패턴 추가 |
| `netlify/functions/manuscripts.mts` | 저장소 로직 변경 |
| `netlify.toml` | Netlify 설정 |

---

## 🌐 사용된 무료 서비스

| 기능 | 서비스 | 비용 | 인증 |
|---|---|---|---|
| 정적 호스팅 | Netlify | 무료 (100GB/mo) | GitHub 로그인 |
| 서버리스 함수 | Netlify Functions | 무료 (125K req/mo) | 없음 |
| 파일 저장 | Netlify Blobs | 무료 (베타) | 없음 |
| 맞춤법 검사 | 네이버 검사기 | 무료 | 없음 |
| DOCX 파싱 | mammoth.js (CDN) | 무료 | 없음 |
| 메타데이터 추출 | 자체 사전 (내장) | 무료 | 없음 |

---

## 📁 원고 업로드 지원 형식

| 형식 | 지원 | 방식 |
|---|---|---|
| **.docx** | ✅ 자동 파싱 | 브라우저에서 mammoth.js 로 텍스트 추출 |
| **.txt / .md** | ✅ 자동 파싱 | 브라우저 기본 API |
| **.hwp / .hwpx** | ❌ 미지원 | HWP 열어서 텍스트 복사 → 붙여넣기 |
| **붙여넣기** | ✅ 항상 지원 | 어떤 포맷이든 텍스트만 있으면 OK |

HWP 자동 파싱은 JavaScript 라이브러리 부재로 아직 어렵습니다. 
필요시 Netlify Function 에 Python 파서 마이그레이션 검토 (별도 서버 필요).

---

## API 스펙

### `POST /api/check` — 네이버 맞춤법 검사
```json
Request:  { "text": "원고 전문" }
Response: {
  "checks": [
    { "text": "되요", "suggestion": "돼요",
      "type": "error", "reason": "맞춤법",
      "layer": "L4·Naver" }
  ],
  "source": "naver",
  "chunks": 3
}
```

### `POST /api/extract` — 사전 기반 메타데이터 추출
```json
Request:  { "text": "원고 전문" }
Response: {
  "extract": {
    "tickers": ["삼성전자", "SK하이닉스", ...],
    "organizations": ["연준", "MSCI", ...],
    "events": ["FOMC", "MSCI 편입 이슈", ...],
    "sectors": ["반도체", "조선", ...],
    "questionSummaries": ["Q1 요약", "Q2 요약", ...]
  },
  "source": "rule-based"
}
```

### `GET /api/manuscripts`
전체 아카이브 목록 (요약)

### `GET /api/manuscripts/:id`
개별 원고 전체 데이터

### `POST /api/manuscripts`
새 원고 STOCK 저장

### `DELETE /api/manuscripts/:id`
삭제

---

## 🔧 로컬 개발

```bash
cd airscript-netlify
npm install
npx netlify dev
# → http://localhost:8888
```

---

## 다음 개선 후보

- [ ] HWP 파일 서버사이드 파싱 (Python + 별도 서버)
- [ ] 원고 인라인 수정 (검수 지적사항 한 클릭 반영)
- [ ] 프로그램별 대시보드 강화 (게스트 재섭외 · 종목 히트맵)
- [ ] 사내 인증 (Netlify Identity or SSO)
- [ ] 종목·인명·기관 사전 확장 (한경 자체 사전 업로드)
- [ ] Google Gemini 무료 티어로 L4 문맥 검수 옵션 추가
- [ ] 시청률 분석기 · CG 라이브러리와 상호 연동
