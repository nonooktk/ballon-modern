#!/usr/bin/env bash
# マイグレーションを順に流す。管理用ロールの接続文字列を環境変数 DATABASE_URL_ADMIN で渡す（出力しない）。
# 例: DATABASE_URL_ADMIN='postgresql://...' ./db/apply.sh
# 各ファイルは冪等（何度流しても同じ結果）。ballon_api のパスワードは別途 `alter role ballon_api password '...'` で設定する。
set -euo pipefail
: "${DATABASE_URL_ADMIN:?DATABASE_URL_ADMIN（管理用ロールの接続文字列）を環境変数で渡してください}"
dir="$(cd "$(dirname "$0")" && pwd)/migrations"
for f in "$dir"/*.sql; do
  echo "apply: $(basename "$f")"
  psql "$DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1 --single-transaction -q -f "$f"
done
echo "done"
