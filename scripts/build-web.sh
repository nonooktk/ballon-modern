#!/usr/bin/env bash
# 画面の配備用 zip を作る（Next.js standalone）。出力: dist/web-<日時>-<sha>.zip（最後の行にパス）
# 必須の環境変数（ビルド時に埋め込まれる。秘匿値ではない）:
#   NEXT_PUBLIC_API_BASE_URL      例: https://app-ballon-api-nonooktk.azurewebsites.net
#   NEXT_PUBLIC_GOOGLE_CLIENT_ID  例: xxxx.apps.googleusercontent.com
set -euo pipefail
: "${NEXT_PUBLIC_API_BASE_URL:?NEXT_PUBLIC_API_BASE_URL を設定してください}"
: "${NEXT_PUBLIC_GOOGLE_CLIENT_ID:?NEXT_PUBLIC_GOOGLE_CLIENT_ID を設定してください}"
export NEXT_PUBLIC_API_BASE_URL NEXT_PUBLIC_GOOGLE_CLIENT_ID
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/app/frontend"
npm ci
npm run build
[ -f .next/standalone/server.js ] || { echo "standalone 出力がありません" >&2; exit 1; }
mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static .next/standalone/public
cp -r .next/static .next/standalone/.next/static
[ -d public ] && cp -r public .next/standalone/public
mkdir -p "$ROOT/dist"
SHA=$(git -C "$ROOT" rev-parse --short HEAD)
OUT="$ROOT/dist/web-$(date +%Y%m%d-%H%M%S)-$SHA.zip"
(cd .next/standalone && zip -q -r "$OUT" .)
echo "$OUT"
