#!/usr/bin/env bash
# API の配備用 zip を作る。出力: dist/api-<日時>-<sha>.zip（最後の行にパスを出力）
# App Service の Oryx が requirements.txt から依存を入れる前提（SCM_DO_BUILD_DURING_DEPLOYMENT=true）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/app/backend"
mkdir -p "$ROOT/dist"
SHA=$(git -C "$ROOT" rev-parse --short HEAD)
OUT="$ROOT/dist/api-$(date +%Y%m%d-%H%M%S)-$SHA.zip"
# トップ直下の .py（テスト・.venv・__pycache__ は含まれない）と requirements.txt だけ
zip -q "$OUT" ./*.py requirements.txt
echo "含まれるファイル:" >&2
unzip -Z1 "$OUT" >&2
echo "$OUT"
