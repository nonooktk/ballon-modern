# db

PostgreSQL 16 のマイグレーション。設計は `02_プロジェクト/ballon-modern/ARCHITECTURE.md` §4 と `DB動きレビュー資料.md`。

| ファイル | 内容 |
| --- | --- |
| `migrations/0001_init.sql` | ロール（`ballon_owner`・`ballon_api`）、テーブル 6 つ、制約・トリガ、関数 7 本、権限、初期データ。冪等（何度流しても同じ） |
| `migrations/0002_reset_me.sql` | デモ用リセット関数 `app_reset_me`（本人の記録を全削除。`record_ops.record_id` を空にでき、`kind` に `reset` を追加）。冪等 |
| `apply.sh` | `migrations/` を順に流す（psql）。管理用ロールの接続文字列を `DATABASE_URL_ADMIN` で渡す |
| `role_probe.sh` | `ballon_api` の権限の確認（本番の設定の確認）。リリースの前後に流す |

## 流し方

```bash
# 管理用ロール（CREATEROLE が使えるもの）の接続文字列。画面にも出力にも出さない
export DATABASE_URL_ADMIN='postgresql://<admin>:<password>@<host>:5432/ballon?sslmode=require'
./db/apply.sh

# ballon_api のパスワードはマイグレーションに書かない。管理者が別に設定し、API のアプリ設定 DATABASE_URL に入れる
psql "$DATABASE_URL_ADMIN" -c "alter role ballon_api password '<新しいパスワード>'"

# 権限の確認（すべて OK になること）
./db/role_probe.sh
```

## 方針

- API は `ballon_api` で接続する。このロールは**関数の実行だけ**ができ、テーブルには何の権限もない（`select` もできない）。
- 書き込みも読み取りも関数 7 本（`app_login`・`app_home_state`・`app_press`・`app_confirm`・`app_cancel`・`app_total`・`app_trend`）。関数は `security definer`（所有者 `ballon_owner`）。
- 内部の補助関数（`_` で始まるもの）には `ballon_api` の実行権限を与えない。
- 1 日の上限は関数 `_daily_cap()`（600）。テストでは差し替えて確かめる。

## 0002 の適用と確認

```bash
./db/apply.sh      # 0001・0002 を順に流す（どちらも冪等）
./db/role_probe.sh # 直接のテーブル操作は引き続きすべて拒否されること

# 関数の存在と権限（ballon_api が true、public が false）
psql "$DATABASE_URL_ADMIN" -At -c "select to_regprocedure('app_reset_me(uuid, uuid)') is not null, has_function_privilege('ballon_api','app_reset_me(uuid, uuid)','execute'), has_function_privilege('public','app_reset_me(uuid, uuid)','execute')"
# 期待: t|t|f
```
