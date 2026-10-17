#!/usr/bin/env bash
# 使い方: scripts/deploy.sh <api|web> <zip>
# 統括の承認後にだけ実行する（Azure を変更する）。az login 済みであること。
set -euo pipefail
TARGET="${1:?api か web を指定してください}"
ZIP="${2:?zip のパスを指定してください}"
[ -f "$ZIP" ] || { echo "zip が見つかりません: $ZIP" >&2; exit 1; }
RG=rg-001-gen12
SUB=9b680e6d-e5a6-4381-aad5-a30afcbc8459
case "$TARGET" in
  api) APP=app-ballon-api-nonooktk; CHECK=/health ;;
  web) APP=app-ballon-web-nonooktk; CHECK=/ ;;
  *) echo "api か web を指定してください" >&2; exit 2 ;;
esac
echo "配備: $TARGET ($APP) <- $ZIP"
az webapp deploy --subscription "$SUB" -g "$RG" -n "$APP" --src-path "$ZIP" --type zip
URL="https://$APP.azurewebsites.net$CHECK"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null -w "確認 $URL -> HTTP %{http_code}\n" "$URL"; then exit 0; fi
  echo "待機中 ($i/10)" >&2; sleep 15
done
echo "確認に失敗: $URL（切り戻しは docs/deploy-local.md）" >&2
exit 1
