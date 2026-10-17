# Azure 手順書（ふうせん / ballon-modern）

統括がコピペで実行する手順です。**このファイルを作ったタキシードサムは、Azure を変更するコマンドを実行していません**（読み取りの `az ... show/list` だけ実行）。

- 作成: 2026-10-17 / 担当: タキシードサム / 設計の正本: 保管庫の `02_プロジェクト/ballon-modern/ARCHITECTURE.md`（§1・§2・§6.3・§10・§13 U11）
- 実行の順: §0 → §1 → §2 → §3 → §4 → §5 → §6。§4 のロール割当は管理者の作業を待つ
- **秘匿値の扱い**: パスワードと接続文字列はシェル変数に入れるだけで、ファイル・ログ・Slack・チャットに出さない。`az webapp config appsettings set` は応答に全設定の値を表示するため、**必ず `-o none` を付ける**（下のコマンドには付けてある）
- `<...>` はプレースホルダ。実値に置き換える。実値を貼った行をコミットしない

## 0. 共通の変数と事前確認

```bash
export SUB=9b680e6d-e5a6-4381-aad5-a30afcbc8459
export RG=rg-001-gen12
export PLAN=asp-guapp-nonooktk
export API_APP=app-ballon-api-nonooktk
export WEB_APP=app-ballon-web-nonooktk
export PG_SERVER=psql-tvmvp-73bb
export PG_HOST=${PG_SERVER}.postgres.database.azure.com
export WEB_URL=https://${WEB_APP}.azurewebsites.net
export API_URL=https://${API_APP}.azurewebsites.net

az account set --subscription "$SUB"
az account show --query '{name:name,id:id}' -o table
```

2026-10-17 に読み取りで確認した現状（作成前の状態）:

| 項目 | 値 |
| --- | --- |
| プラン `asp-guapp-nonooktk` | B1・Linux・Japan East |
| DB サーバー `psql-tvmvp-73bb` | PostgreSQL 16・Standard_B1ms・Japan East・管理者 `tvmvpadmin`・パスワード認証のみ（Entra 認証は無効）・公開アクセス有効 |
| 既存 DB | `tvmvp`（TV_MVP）、`postgres`、`azure_*`（システム用） |
| ファイアウォール | `allow-local-devip`（統括の端末の IP）、`AllowAllAzureServicesAndResourcesWithinAzureIps_*`（0.0.0.0＝Azure 内のサービスから接続可） |
| `max_connections` | 50（既定値。TV_MVP と共有） |
| バックアップ | 保持 7 日・ジオ冗長なし |
| Web App 名 | `app-ballon-api-nonooktk`・`app-ballon-web-nonooktk` は DNS 上で未使用（作成可能の見込み） |
| ランタイム | `NODE:22-lts` と `PYTHON:3.12` が選べる |

## 1. Web App を 2 つ作る

```bash
# API（Python 3.12）
az webapp create -g "$RG" -p "$PLAN" -n "$API_APP" --runtime "PYTHON:3.12"

# 画面（Node 22 LTS）
az webapp create -g "$RG" -p "$PLAN" -n "$WEB_APP" --runtime "NODE:22-lts"

# 共通の設定: HTTPS のみ・TLS 1.2 以上・FTP 無効・Always On（スリープ回避）
for APP in "$API_APP" "$WEB_APP"; do
  az webapp update -g "$RG" -n "$APP" --https-only true -o none
  az webapp config set -g "$RG" -n "$APP" --always-on true --min-tls-version 1.2 --ftps-state Disabled -o none
done

# 起動コマンド
# API: ワーカーは 1 つ（メモリ上のレート制限が割れないため。ARCHITECTURE.md ADR-4）
az webapp config set -g "$RG" -n "$API_APP" \
  --startup-file "python -m uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1" -o none
# 画面: Next.js の standalone 出力
az webapp config set -g "$RG" -n "$WEB_APP" --startup-file "node server.js" -o none
```

確認:

```bash
az webapp show -g "$RG" -n "$API_APP" --query '{state:state,rt:siteConfig.linuxFxVersion,https:httpsOnly,alwaysOn:siteConfig.alwaysOn}' -o table
az webapp show -g "$RG" -n "$WEB_APP" --query '{state:state,rt:siteConfig.linuxFxVersion,https:httpsOnly,alwaysOn:siteConfig.alwaysOn}' -o table
```

> 注意（B1 の相乗り）: giver-poker と同じ B1 を使う。CPU を取り合う。giver-poker の本番日（講義）と重ならないようにする（§6 ②）。

## 2. PostgreSQL に DB `ballon` とロール 2 つを作る

役割:

| ロール | 用途 | 権限の範囲 |
| --- | --- | --- |
| `ballon_owner` | マイグレーション（テーブル・関数の作成）。統括が手元から流す | DB `ballon` の所有者 |
| `ballon_api` | API の実行時。**関数の実行だけ**ができる（権限の付与は T2 のマイグレーションで行う） | DB `ballon` への接続のみ。接続数は 5 まで |

### 2.1 手元の IP を一時的に許可する

統括の端末の IP が `allow-local-devip` と同じなら、この手順は不要。違うときだけ実行する。

```bash
export MY_IP=$(curl -s https://api.ipify.org)
az postgres flexible-server firewall-rule create -g "$RG" -n "$PG_SERVER" \
  --rule-name allow-ballon-migrate --start-ip-address "$MY_IP" --end-ip-address "$MY_IP"
```

作業が終わったら §2.5 で削除する。

### 2.2 パスワードを作る（画面に出さない）

```bash
export BALLON_OWNER_PW=$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40)
export BALLON_API_PW=$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40)
# 控えは統括のパスワード管理ツールに保存する。echo しない。このシェルを閉じると変数は消える
```

### 2.3 DB とロールを作る（管理者 `tvmvpadmin` で接続）

```bash
# 管理者のパスワードは対話で聞かれる
psql "host=$PG_HOST port=5432 dbname=postgres user=tvmvpadmin sslmode=require" \
  -v ON_ERROR_STOP=1 -v owner_pw="$BALLON_OWNER_PW" -v api_pw="$BALLON_API_PW" <<'SQL'
-- ロール（スーパーユーザー・DB 作成・ロール作成の権限なし）
CREATE ROLE ballon_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 2;
CREATE ROLE ballon_api   LOGIN PASSWORD :'api_pw'   NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 5;

-- 管理者が所有者を指定して DB を作るには、そのロールのメンバーである必要がある（Azure の管理者はスーパーユーザーではない）
GRANT ballon_owner TO tvmvpadmin;
CREATE DATABASE ballon OWNER ballon_owner;
REVOKE ALL ON DATABASE ballon FROM PUBLIC;
GRANT CONNECT ON DATABASE ballon TO ballon_owner, ballon_api;
-- メンバーシップは作成のためだけ。済んだら外す
REVOKE ballon_owner FROM tvmvpadmin;
SQL
```

> `REVOKE ... FROM PUBLIC` は **`ballon` だけ**に掛ける。`tvmvp` など他の DB の権限は変えない（TV_MVP を壊さないため）。`ballon_api` が他の DB に接続できてしまう点は §6 ④ で確認する。

### 2.4 確認（パスワードは出ない）

```bash
psql "host=$PG_HOST port=5432 dbname=postgres user=tvmvpadmin sslmode=require" -c \
 "select rolname, rolsuper, rolcreatedb, rolcreaterole, rolconnlimit from pg_roles where rolname like 'ballon_%' order by 1;" -c \
 "select datname, pg_get_userbyid(datdba) as owner from pg_database where datname = 'ballon';"
```

期待: 2 ロールとも `rolsuper=f`・`rolcreatedb=f`・`rolcreaterole=f`。`ballon` の所有者が `ballon_owner`。

### 2.5 一時の許可を消す

```bash
az postgres flexible-server firewall-rule delete -g "$RG" -n "$PG_SERVER" --rule-name allow-ballon-migrate --yes
```

### 2.6 接続文字列を作る（出力しない）

```bash
# sslmode=require を付ける（Azure の PostgreSQL は TLS 必須）
export DB_URL_API="postgresql://ballon_api:${BALLON_API_PW}@${PG_HOST}:5432/ballon?sslmode=require"
export DB_URL_OWNER="postgresql://ballon_owner:${BALLON_OWNER_PW}@${PG_HOST}:5432/ballon?sslmode=require"
# DB_URL_OWNER はマイグレーション用（T2 の手順で使う）。Web App には登録しない
```

> パスワードに記号を入れない生成方法にしてあるので、URL エンコードは不要。

## 3. アプリ設定を登録する

**値は `<...>` を置き換える。`-o none` を外さない**（外すと全設定の値が画面に出る）。

```bash
# API
az webapp config appsettings set -g "$RG" -n "$API_APP" -o none --settings \
  DATABASE_URL="$DB_URL_API" \
  GOOGLE_CLIENT_ID="<§5 で作った OAuth クライアント ID>" \
  ALLOWED_ORIGINS="$WEB_URL" \
  RATE_LIMIT_WRITE_PER_SEC="<T1 の確定値>" \
  RATE_LIMIT_WRITE_PER_MIN="<T1 の確定値>" \
  RATE_LIMIT_REPEATABLE_PER_DAY="<T1 の確定値>" \
  RATE_LIMIT_LEDGER_PER_DAY="<T1 の確定値>" \
  WEBSITES_PORT=8000 \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true

# 画面（NEXT_PUBLIC_* はビルド時に埋め込まれるので、ここではなく GitHub のリポジトリ変数で渡す。docs/github-setup.md）
az webapp config appsettings set -g "$RG" -n "$WEB_APP" -o none --settings \
  PORT=8080 \
  HOSTNAME=0.0.0.0 \
  SCM_DO_BUILD_DURING_DEPLOYMENT=false
```

確認（**キー名だけ**を出す。値は出さない）:

```bash
az webapp config appsettings list -g "$RG" -n "$API_APP" --query '[].name' -o tsv
az webapp config appsettings list -g "$RG" -n "$WEB_APP" --query '[].name' -o tsv
```

メモ:
- CORS（`ALLOWED_ORIGINS`）は本番の画面の URL だけにした。ARCHITECTURE.md §10 は「画面の URL と localhost」だが、本番 API に localhost を許すと開発中の誤操作で本番データを触れるため、まず外してある。必要なら `"$WEB_URL,http://localhost:3000"` に変える（統括判断）
- `RATE_LIMIT_*` の名前と値は T1（ツボツボ）が確定する。`.env.example` にキー名を置いてある
- 反映後、各 Web App は自動で再起動する

## 4. GitHub Actions の OIDC（ユーザー割り当てマネージド ID）

この環境では AAD（Entra）のアプリ登録とロール割当ができないため、**ユーザー割り当てマネージド ID + federated credential** で組む。ロール割当だけ管理者に依頼する。

### 4.1 統括が実行する（マネージド ID と federated credential）

```bash
export MI_NAME=id-ballon-deploy
az identity create -g "$RG" -n "$MI_NAME" -l japaneast

# main ブランチからの実行だけを信頼する（deploy-*.yml も main 以外では動かさない）
az identity federated-credential create -g "$RG" --identity-name "$MI_NAME" \
  --name gh-ballon-modern-main \
  --issuer https://token.actions.githubusercontent.com \
  --subject "repo:nonooktk/ballon-modern:ref:refs/heads/main" \
  --audiences api://AzureADTokenExchange

# GitHub に登録する 3 つの値（秘匿値ではない）を控える
export MI_CLIENT_ID=$(az identity show -g "$RG" -n "$MI_NAME" --query clientId -o tsv)
export MI_PRINCIPAL_ID=$(az identity show -g "$RG" -n "$MI_NAME" --query principalId -o tsv)
export TENANT_ID=$(az account show --query tenantId -o tsv)
echo "AZURE_CLIENT_ID=$MI_CLIENT_ID"; echo "AZURE_TENANT_ID=$TENANT_ID"; echo "AZURE_SUBSCRIPTION_ID=$SUB"
echo "principalId=$MI_PRINCIPAL_ID   # 管理者への依頼に書く"
```

### 4.2 管理者への依頼文（そのまま送れる）

```
件名: Azure ロール割当のお願い（GitHub Actions デプロイ用マネージド ID）

サブスクリプション 9b680e6d-e5a6-4381-aad5-a30afcbc8459 のリソースグループ rg-001-gen12 に、
ユーザー割り当てマネージド ID「id-ballon-deploy」（principalId: <4.1 で出た値>）を作りました。
GitHub Actions からの Web App デプロイ用です。次のロール割当をお願いします。

1. ロール「Website Contributor」
   スコープ: Web App app-ballon-api-nonooktk（/subscriptions/9b680e6d-e5a6-4381-aad5-a30afcbc8459/resourceGroups/rg-001-gen12/providers/Microsoft.Web/sites/app-ballon-api-nonooktk）
2. ロール「Website Contributor」
   スコープ: Web App app-ballon-web-nonooktk（同上のパスで名前だけ web に）
3. ロール「Reader」
   スコープ: リソースグループ rg-001-gen12（az の login 後にリソースを解決するため。読み取りのみ）

他のリソースへの権限は付けないでください。
```

参考コマンド（管理者が実行する場合）:

```bash
API_ID=$(az webapp show -g "$RG" -n "$API_APP" --query id -o tsv)
WEB_ID=$(az webapp show -g "$RG" -n "$WEB_APP" --query id -o tsv)
az role assignment create --assignee-object-id "$MI_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal --role "Website Contributor" --scope "$API_ID"
az role assignment create --assignee-object-id "$MI_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal --role "Website Contributor" --scope "$WEB_ID"
az role assignment create --assignee-object-id "$MI_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal --role "Reader" --scope "/subscriptions/$SUB/resourceGroups/$RG"
```

### 4.3 GitHub に値を登録する

`docs/github-setup.md` の「Actions のリポジトリ変数」を参照（`gh variable set`）。

### 4.4 つまずきやすい点（未検証。初回の実行で確認する）

- ログインで「No subscriptions found」になるときは、Reader（RG）の割当が未反映。反映に数分かかる
- `azure/login` のあと `az webapp deploy` が 403 になるときは、Website Contributor の割当先（Web App の ID）の綴りを確認する
- federated credential の `subject` は大文字小文字を区別する。リポジトリ名は `nonooktk/ballon-modern`

## 5. Google Cloud で OAuth クライアント ID を作る

画面操作（統括）。クライアント ID は秘匿値ではない（クライアントシークレットは使わない）。

1. https://console.cloud.google.com/ で、このアプリ用のプロジェクトを作る（または既存を選ぶ）。名前の例: `ballon-modern`
2. 「API とサービス」→「OAuth 同意画面」（新しい画面では「Google Auth Platform」→「ブランディング／対象」）
   - アプリ名: `ふうせん`、ユーザーサポートメール: 統括のメール
   - 対象（User type）: **外部**
   - スコープ: `openid`・`email`・`profile` のみ（機密スコープは足さない）
3. **公開ステータスを「本番環境」にする**（「アプリを公開」）。テストのままだと、追加したテストユーザーしかログインできない。「Google アカウントなら誰でも」の要件に合わない
4. 「クライアント」→「クライアントを作成」
   - 種類: **ウェブ アプリケーション**
   - 名前: `ballon-modern-web`
   - **承認済みの JavaScript 生成元**:
     - `https://app-ballon-web-nonooktk.azurewebsites.net`
     - `http://localhost:3000`
   - 承認済みのリダイレクト URI: 空でよい（Google Identity Services のボタン方式のため）
5. 発行された **クライアント ID**（`...apps.googleusercontent.com`）を控える。使う場所は 3 つ:
   - API のアプリ設定 `GOOGLE_CLIENT_ID`（§3）
   - GitHub のリポジトリ変数 `NEXT_PUBLIC_GOOGLE_CLIENT_ID`（`docs/github-setup.md`）
   - ローカルの `.env` / `.env.local`

> 反映に数分〜数時間かかることがある。ログインのボタンで「origin_mismatch」が出たら、生成元の URL の綴り（末尾スラッシュなし）を確認する。

## 6. 確認項目（U11）

公開前に確認し、結果を IMPLEMENTATION_PLAN.md に記帳する（記帳はハローキティ）。

### ① 同意画面が「本番環境」になっている

Google Cloud の OAuth 同意画面で、公開ステータスが「本番環境」であること。別の Google アカウント（テストユーザーに入れていないもの）でログインできることをスモークで確かめる。

### ② B1 の CPU 共有（giver-poker）

```bash
PLAN_ID=$(az appservice plan show -g "$RG" -n "$PLAN" --query id -o tsv)
az monitor metrics list --resource "$PLAN_ID" --metric CpuPercentage MemoryPercentage \
  --interval PT1H --offset 7d --aggregation Average Maximum -o table
```

見方: 平均が高止まり（目安 70% 以上）なら、公開の時期を giver-poker の講義日からずらすか、プランを上げる相談をする。

### ③ B1ms の接続数

```bash
psql "host=$PG_HOST port=5432 dbname=postgres user=tvmvpadmin sslmode=require" \
  -c "show max_connections;" \
  -c "select datname, usename, count(*) from pg_stat_activity where datname is not null group by 1,2 order by 3 desc;"
```

見方: `max_connections` は 50（読み取りで確認済み）。システムの予約を引いて実際に使えるのは 40 前後。TV_MVP の接続数に `ballon_api` の上限 5 を足しても余裕があること。API の接続プールの最大は 5 以下にする（T1）。

### ④ `ballon_api` が他の DB に接続できないこと

```bash
for DB in tvmvp postgres; do
  echo "== $DB"
  PGPASSWORD="$BALLON_API_PW" psql "host=$PG_HOST port=5432 dbname=$DB user=ballon_api sslmode=require" \
    -c "select current_database();" 2>&1 | head -3
done
```

見方:
- 接続が拒否される（permission denied for database）→ 合格
- **接続できてしまう場合**（`tvmvp` の既定では PUBLIC に CONNECT が付いている見込み）→ 接続後にテーブルへ触れないかを確認する:

```bash
PGPASSWORD="$BALLON_API_PW" psql "host=$PG_HOST port=5432 dbname=tvmvp user=ballon_api sslmode=require" \
  -c "select table_schema, table_name, privilege_type from information_schema.role_table_grants where grantee in ('ballon_api','PUBLIC') and table_schema not in ('pg_catalog','information_schema');"
```

0 行なら実害なし（接続はできるが何も読めない）として統括が受容を判断する。1 行以上ある、または接続自体も止めたい場合は、**TV_MVP が使っているロール名を確認してから** `tvmvp` の `PUBLIC` の CONNECT を外す案を別途相談する（TV_MVP を止める恐れがあるので、この手順書では実行しない）。

### ⑤ リージョン・バックアップ・Always On

```bash
az webapp show -g "$RG" -n "$API_APP" --query '{loc:location,alwaysOn:siteConfig.alwaysOn}' -o table
az webapp show -g "$RG" -n "$WEB_APP" --query '{loc:location,alwaysOn:siteConfig.alwaysOn}' -o table
az postgres flexible-server show -g "$RG" -n "$PG_SERVER" --query '{loc:location,backupDays:backup.backupRetentionDays,geo:backup.geoRedundantBackup}' -o table
```

期待: すべて Japan East、Always On が True。バックアップは保持 7 日・ジオ冗長なし（2026-10-17 の読み取りの結果）。データを失うと困る規模になったら保持日数を延ばす相談をする。

### ⑥ デプロイの OIDC

§4 のロール割当が済み、`deploy-api.yml` を手動実行して成功すること（実行は統括の承認後）。

### ⑦ マイグレーションを流す場所

初期は統括が手元から `ballon_owner` で流す（§2.1 の IP 許可が要る）。T2 のマイグレーションは `db/` に置かれる。本番で流す手順は T2 の完了後に追記する。

## 7. 切り戻しと後片付け

| 場面 | 手順 |
| --- | --- |
| API／画面のデプロイが悪かった | GitHub の Actions で `deploy-api`（または `deploy-web`）を「Run workflow」し、`git_ref` に**前回デプロイした SHA**を入れて再実行する。直前の SHA は各実行の記録に残す |
| アプリ設定を間違えた | §3 のコマンドを正しい値で再実行する（キー名の一覧は `appsettings list --query '[].name'`） |
| DB のマイグレーションが悪かった | T2 のマイグレーションに down（元に戻す）手順を添える。本番は DB のバックアップ（PITR・保持 7 日）が最後の手段。復元は別の DB サーバーとして作られるので、統括判断 |
| 全部やり直す（破壊的。統括判断） | 下の削除コマンド。DB `ballon` は中身ごと消える |

```bash
# 破壊的。実行前に必ず統括が内容を確認する
az webapp delete -g "$RG" -n "$API_APP"
az webapp delete -g "$RG" -n "$WEB_APP"
az identity delete -g "$RG" -n id-ballon-deploy
# DB の削除（管理者で接続して）: DROP DATABASE ballon; DROP ROLE ballon_api; DROP ROLE ballon_owner;
```

---

関連: `docs/github-setup.md` / `.github/workflows/deploy-api.yml` / `.github/workflows/deploy-web.yml` / 保管庫の `ARCHITECTURE.md` §6.3・§13 U11
