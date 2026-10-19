#!/usr/bin/env bash
# role_probe: ballon_api の権限の確認（本番の設定の確認）。リリースの前後に流す。
# 管理用ロールの接続文字列を環境変数 DATABASE_URL_ADMIN で渡す（画面にも出力にも出さない）。
# 期待: テーブルへの select/insert/update/delete/truncate はすべて 42501（permission denied）、関数は通る、最後の 2 つの確認 SQL は 0 行。
set -uo pipefail
: "${DATABASE_URL_ADMIN:?DATABASE_URL_ADMIN を環境変数で渡してください}"

fail=0
probe() { # $1: SQL, $2: 期待（deny|ok）, $3: 名前
  local out
  out=$(psql "$DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1 -At -c "begin; set local role ballon_api; $1; rollback;" 2>&1)
  if [[ "$2" == "deny" ]]; then
    if grep -q "permission denied" <<<"$out"; then echo "OK   (拒否された)   $3"; else echo "NG   (拒否されない) $3"; fail=1; fi
  else
    if grep -q "ERROR" <<<"$out"; then echo "NG   (通らない)     $3"; fail=1; else echo "OK   (通った)       $3"; fi
  fi
}

for t in users action_defs action_bands level_table records record_ops; do
  probe "select count(*) from $t" deny "select $t"
  probe "delete from $t" deny "delete $t"
  probe "truncate $t" deny "truncate $t"
done
probe "insert into records(user_id, action_id, local_date) values (gen_random_uuid(), 'water', current_date)" deny "insert records"
probe "update records set press_points = 10" deny "update records"
probe "select app_total('00000000-0000-0000-0000-000000000000')" ok "function app_total"
probe "select app_home_state('00000000-0000-0000-0000-000000000000', current_date)" ok "function app_home_state"

# ballon_api にテーブルの権限が残っていないか（0 行）
rows=$(psql "$DATABASE_URL_ADMIN" -At -c "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('ballon_api', c.oid, 'select,insert,update,delete,truncate')")
if [[ -z "$rows" ]]; then echo "OK   テーブル権限なし"; else echo "NG   テーブル権限が残る: $rows"; fail=1; fi
# 全員（public）に実行権限が残る関数がないか（0 行）
rows=$(psql "$DATABASE_URL_ADMIN" -At -c "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')")
if [[ -z "$rows" ]]; then echo "OK   public に実行権限が残る関数なし"; else echo "NG   public に実行権限が残る関数: $rows"; fail=1; fi

# ballon_api が他のロールのメンバーになっていないか（0 行。監査 F-9）
rows=$(psql "$DATABASE_URL_ADMIN" -At -c "select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = 'ballon_api'")
if [[ -z "$rows" ]]; then echo "OK   他ロールのメンバーではない"; else echo "NG   他ロールのメンバー: $rows"; fail=1; fi
# 他の DB へ接続できるか（情報。PostgreSQL の既定では PUBLIC に CONNECT が付くため、同じサーバーの他 DB に接続できることがある。
# 接続できても、その DB 内の権限が無ければ読めない。tvmvp 側の権限変更は TV_MVP を止める恐れがあるので行わない。監査 F-9）
rows=$(psql "$DATABASE_URL_ADMIN" -At -c "select datname from pg_database where not datistemplate and datname <> current_database() and has_database_privilege('ballon_api', datname, 'connect')")
if [[ -z "$rows" ]]; then echo "OK   他 DB への CONNECT なし"; else echo "情報 他 DB へ CONNECT 可（権限 0 行かを別途確認）: $(echo $rows | tr '\n' ' ')"; fi

exit $fail
