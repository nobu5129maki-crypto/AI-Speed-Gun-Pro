#!/usr/bin/env bash
# 変更を GitHub に push し、main 経由で Vercel 本番へ反映する
set -euo pipefail

MSG="${1:-Ship updates to GitHub and Vercel}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  git commit -m "$MSG"
fi

push_with_retry() {
  local args=("$@")
  local delay=4
  local i
  for i in 1 2 3 4; do
    if git push "${args[@]}"; then
      return 0
    fi
    echo "push failed (try $i), retry in ${delay}s..." >&2
    sleep "$delay"
    delay=$((delay * 2))
  done
  echo "push failed after retries: ${args[*]}" >&2
  return 1
}

# 作業ブランチ
push_with_retry -u origin "$BRANCH"

# 本番（Vercel Production = main）— upstream は付けない
if [[ "$BRANCH" != "main" ]]; then
  push_with_retry origin "${BRANCH}:main"
fi

echo ""
echo "GitHub: pushed $BRANCH (and main for production)"
echo "Vercel: https://ai-speed-gun-pro.vercel.app"
echo "Dashboard: https://vercel.com/makiuchis-projects/ai-speed-gun-pro"
