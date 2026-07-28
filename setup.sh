#!/bin/bash
# AIRSCRIPT — Git 저장소 초기화 + 최초 커밋 자동화
# 실행: bash setup.sh

set -e

cd "$(dirname "$0")"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   AIRSCRIPT · GitHub → Netlify 배포 세팅        ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# Git 확인
if ! command -v git &> /dev/null; then
  echo "❌ Git이 설치되어 있지 않습니다."
  echo "   https://git-scm.com/download 에서 설치 후 다시 실행."
  exit 1
fi

# 1) Git 초기화
if [ ! -d .git ]; then
  git init -q
  echo "✅ Git 저장소 초기화"
else
  echo "ℹ️  Git 저장소 이미 존재"
fi

# 2) Git 기본 설정 확인
if [ -z "$(git config user.email)" ]; then
  read -p "  Git 사용자 이메일: " email
  git config user.email "$email"
fi
if [ -z "$(git config user.name)" ]; then
  read -p "  Git 사용자 이름: " name
  git config user.name "$name"
fi

# 3) 파일 추가 및 커밋
git add -A
if git diff --cached --quiet; then
  echo "ℹ️  변경사항 없음 (이미 커밋됨)"
else
  git commit -q -m "AIRSCRIPT 배포"
  echo "✅ 초기 커밋 완료"
fi

# 4) 기본 브랜치 정리
git branch -M main 2>/dev/null || true

# 5) 원격 저장소 안내
echo ""
echo "──────────────────────────────────────────────────"
echo ""
if git remote get-url origin &> /dev/null; then
  REMOTE=$(git remote get-url origin)
  echo "✅ 원격 저장소 이미 연결됨:"
  echo "   $REMOTE"
  echo ""
  echo "  다음 단계: git push -u origin main"
else
  echo "📌 다음 단계 (한 번만 하면 됨):"
  echo ""
  echo "  ① GitHub 저장소 생성:"
  echo "     https://github.com/new"
  echo "     • Repository name: airscript"
  echo "     • Private 권장"
  echo "     • Add README/gitignore/license 체크 ✗ (다 해제)"
  echo "     • Create repository 클릭"
  echo ""
  echo "  ② 생성된 저장소 URL 을 아래 명령어에 붙여넣기:"
  echo ""
  echo "     git remote add origin https://github.com/[본인아이디]/airscript.git"
  echo "     git push -u origin main"
  echo ""
  echo "  ③ Netlify 에 연결 (한 번만):"
  echo "     https://app.netlify.com"
  echo "     → Add new site → Import an existing project"
  echo "     → Deploy with GitHub → airscript 저장소 선택"
  echo "     → Deploy site 클릭"
  echo ""
  echo "──────────────────────────────────────────────────"
  echo ""
  echo "이후 수정 시:"
  echo "  git add . && git commit -m \"수정내용\" && git push"
  echo "  → Netlify 가 알아서 1~2분 뒤 재배포"
  echo ""
fi
