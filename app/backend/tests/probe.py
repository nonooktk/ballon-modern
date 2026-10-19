"""role_probe: ballon_api の権限の確認（本番の設定の確認と同じ内容）。
管理用の接続で `set local role ballon_api` してから、直接のテーブル操作が 42501 になり、関数は通ることを確かめる。
問題の一覧を返す（空なら健全）。"""
from __future__ import annotations

import psycopg
from psycopg import errors

TABLES = ["users", "action_defs", "action_bands", "level_table", "records", "record_ops"]
DIRECT = {
    "select": "select count(*) from {t}",
    "update": "update {t} set {c} = {c}",
    "delete": "delete from {t}",
    "truncate": "truncate {t}",
}
FIRST_COLUMN = {"users": "id", "action_defs": "id", "action_bands": "band", "level_table": "level",
                "records": "id", "record_ops": "op_id"}
INSERT = {
    "users": "insert into users(google_sub, email) values ('x', 'x')",
    "action_defs": "insert into action_defs values ('x','x','x','repeatable','none',true,1)",
    "action_bands": "insert into action_bands values ('morning', 1, 'x')",
    "level_table": "insert into level_table values (99, 10)",
    "records": "insert into records(user_id, action_id, local_date) values (gen_random_uuid(), 'water', current_date)",
    "record_ops": "insert into record_ops(user_id, op_id, record_id, kind, local_date) "
                  "values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'press', current_date)",
}
FUNCTIONS = [
    "select app_total('00000000-0000-0000-0000-000000000000')",
    "select app_home_state('00000000-0000-0000-0000-000000000000', current_date)",
    "select app_trend('00000000-0000-0000-0000-000000000000', current_date)",
]
# 全テーブルに権限が無いか／全員（public）に実行権限が残る関数が無いか／ballon_api が実行できる関数は 8 本だけか
SQL_TABLE_PRIV = (
    "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace "
    "where n.nspname = 'public' and c.relkind = 'r' "
    "and has_table_privilege('ballon_api', c.oid, 'select,insert,update,delete,truncate')"
)
SQL_PUBLIC_EXEC = (
    "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
    "where n.nspname = 'public' and p.prokind = 'f' "
    "and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a "
    "where a.grantee = 0 and a.privilege_type = 'EXECUTE')"
)
SQL_API_EXEC = (
    "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
    "where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('ballon_api', p.oid, 'execute') "
    "order by 1"
)
# ballon_api が他のロールのメンバーになっていないか（0 行。監査 F-9）
SQL_MEMBERSHIP = (
    "select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid "
    "join pg_roles u on u.oid = m.member where u.rolname = 'ballon_api'"
)
API_FUNCTIONS = ["app_cancel", "app_confirm", "app_home_state", "app_login", "app_press", "app_reset_me", "app_total", "app_trend"]


def _denied(conn: psycopg.Connection, sql: str) -> bool:
    """ballon_api として実行して、権限エラー（42501）になったか。"""
    try:
        with conn.transaction():
            conn.execute("set local role ballon_api")
            conn.execute(sql)
    except errors.InsufficientPrivilege:
        return True
    except psycopg.Error:
        return False   # 権限エラー以外（あるはずのない失敗）は「拒否された」とは数えない
    return False


def run_probe(admin_url: str) -> list[str]:
    problems: list[str] = []
    with psycopg.connect(admin_url, autocommit=True) as conn:
        for t in TABLES:
            for kind, tmpl in DIRECT.items():
                if not _denied(conn, tmpl.format(t=t, c=FIRST_COLUMN[t])):
                    problems.append(f"{kind} on {t} が拒否されない")
            if not _denied(conn, INSERT[t]):
                problems.append(f"insert on {t} が拒否されない")
        for sql in FUNCTIONS:
            try:
                with conn.transaction():
                    conn.execute("set local role ballon_api")
                    conn.execute(sql)
            except psycopg.Error as e:
                problems.append(f"関数が通らない: {sql} ({type(e).__name__})")
        problems += [f"テーブル権限が残る: {r[0]}" for r in conn.execute(SQL_TABLE_PRIV)]
        problems += [f"public に実行権限が残る関数: {r[0]}" for r in conn.execute(SQL_PUBLIC_EXEC)]
        problems += [f"ballon_api が他ロールのメンバー: {r[0]}" for r in conn.execute(SQL_MEMBERSHIP)]
        api_exec = [r[0] for r in conn.execute(SQL_API_EXEC)]
        if api_exec != API_FUNCTIONS:
            problems.append(f"ballon_api が実行できる関数が 8 本と違う: {api_exec}")
    return problems
