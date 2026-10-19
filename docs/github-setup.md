# GitHub 設定手順書（ふうせん / ballon-modern）

統括がコピペで実行する手順です。タキシードサムは **リポジトリの作成・push・Snyk トークンの登録・ブランチ保護を実行していません**（リリース規定 の push 前確認のため）。
基線の正本は保管庫の `00_組織/社内規定/セキュリティ規定.md` §6 と toolmaker 保管庫のスキル `github-repo-security`。

- 実行する場所: `~` 以下の toolmaker 保管庫のルート（「保管庫ルート」）。このリポジトリは保管庫の `apps/ballon-modern/` にある。`gh` は `nonooktk` でログイン済み
- 順序は守る。**SNYK_TOKEN の登録 → push → ブランチ保護**（逆にすると、最初の push が保護で止まる、または Snyk が 401 で赤くなる）

## 1. 最初の push の前に、対象ファイル一覧を確認する

```bash
cd <保管庫ルート>/apps/ballon-modern
git status --short                      # 何も出ない（コミット済み）こと
git show --stat --name-only HEAD        # コミットに入っているファイルの一覧
# 秘匿値が混ざっていないかの簡易確認（ヒットしないこと）
git grep -n -i -E 'password|secret|token|apikey|api_key|postgresql://[^ ]*:[^ ]*@' -- . ':!docs/*' ':!.github/*' ':!.env.example' || echo "ヒットなし"
git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example' || echo ".env は入っていない"
```

## 2. リポジトリを作る（空のまま。Public）

```bash
cd <保管庫ルート>/apps/ballon-modern
gh repo create nonooktk/ballon-modern --public \
  --description "ふうせん: 頑張らなくていいダイエット記録（Next.js・FastAPI・PostgreSQL）"
git remote add origin https://github.com/nonooktk/ballon-modern.git
git branch -M main
```

## 3. SNYK_TOKEN を登録する（push の前）

Dependabot の PR には Actions の secret が渡らないため、**2 つのストアの両方**に入れる。値は画面に出さない。

```bash
cd <保管庫ルート>
SNYK_TOKEN=$(grep '^SNYK_TOKEN=' .env | cut -d= -f2-)   # 保管庫の .env から読む（出力しない）
printf '%s' "$SNYK_TOKEN" | gh secret set SNYK_TOKEN --repo nonooktk/ballon-modern
printf '%s' "$SNYK_TOKEN" | gh secret set SNYK_TOKEN --repo nonooktk/ballon-modern --app dependabot
unset SNYK_TOKEN
gh secret list --repo nonooktk/ballon-modern
gh secret list --repo nonooktk/ballon-modern --app dependabot
```

> `.env` に `SNYK_TOKEN` が無い場合は、Snyk のアカウント設定から取得して統括が `.env` に追記する（エージェントは編集しない）。

## 4. 最初の push

```bash
cd <保管庫ルート>/apps/ballon-modern
git push -u origin main
```

push するとワークフロー `ci` と `security` が走る。ここで赤くなったら原因を見る（次の 5 に進まない）。

## 5. 基線を適用する（Dependabot alerts・自動修正・ブランチ保護）

Required checks は **ジョブ名と文字列一致**させる（`ci.yml` と `security.yml` のジョブ名）。

| ジョブ名（Required checks） | 場所 |
| --- | --- |
| `CI (backend)` | `.github/workflows/ci.yml` |
| `CI (frontend)` | `.github/workflows/ci.yml` |
| `Snyk (npm)` | `.github/workflows/security.yml` |
| `Snyk (pip)` | `.github/workflows/security.yml` |

```bash
cd <保管庫ルート>
S=<保管庫のスキル github-repo-security>/scripts/setup-github-security.sh

# まず dry-run（変更せず、実行予定を表示）
$S nonooktk/ballon-modern \
  --checks "CI (backend)" --checks "CI (frontend)" --checks "Snyk (npm)" --checks "Snyk (pip)" --dry-run

# 問題なければ本実行（①alerts ②自動修正 ③SNYK_TOKEN〈登録済みでも上書き〉 ④ルールセット security-baseline）
$S nonooktk/ballon-modern \
  --checks "CI (backend)" --checks "CI (frontend)" --checks "Snyk (npm)" --checks "Snyk (pip)"
```

失敗したステップは、スクリプトの最後に統括向けのコピペコマンドが出る。

### 5.1 Public リポジトリの追加設定（秘匿値の混入を止める）

```bash
gh api -X PATCH repos/nonooktk/ballon-modern \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
```

### 5.2 ルールセットの追加項目と fork PR の承認（監査 F-10。統括承認後にコーディネーターが実行）

```bash
# security-baseline ルールセットに force push 禁止・ブランチ削除禁止を足す
ID=$(gh api repos/nonooktk/ballon-modern/rulesets --jq '.[]|select(.name=="security-baseline")|.id')
gh api repos/nonooktk/ballon-modern/rulesets/$ID > /tmp/rs.json
python3 - <<'PY'
import json
rs=json.load(open('/tmp/rs.json'))
types={r['type'] for r in rs['rules']}
for t in ('non_fast_forward','deletion'):
    if t not in types: rs['rules'].append({'type': t})
json.dump({k:rs[k] for k in ('name','target','enforcement','conditions','rules','bypass_actors') if k in rs}, open('/tmp/rs_new.json','w'))
PY
gh api -X PUT repos/nonooktk/ballon-modern/rulesets/$ID --input /tmp/rs_new.json --jq '[.rules[].type]'

# fork からの PR は外部の投稿者すべてで承認を要する
gh api -X PUT repos/nonooktk/ballon-modern/actions/permissions/fork-pr-workflows-policy -f run_workflows_from_fork_pull_requests=false 2>/dev/null || true
gh api -X PUT repos/nonooktk/ballon-modern/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors
```

## 6. 確認

```bash
gh api "repos/nonooktk/ballon-modern/rulesets?includes_parents=false" --jq '.[] | {id,name,enforcement}'
RID=$(gh api "repos/nonooktk/ballon-modern/rulesets?includes_parents=false" --jq '.[] | select(.name=="security-baseline") | .id')
gh api repos/nonooktk/ballon-modern/rulesets/$RID --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
gh api repos/nonooktk/ballon-modern/vulnerability-alerts -i 2>/dev/null | head -n1     # 204 なら有効
gh secret list --repo nonooktk/ballon-modern --app dependabot                           # SNYK_TOKEN があること
```

Dependabot の最初の PR が出たら、`gh pr checks <番号> --repo nonooktk/ballon-modern` で **Snyk が緑**のことを確かめる（401 なら Dependabot 側の secret を見直す）。以後の変更は PR 経由でだけ入る。

## 7. Actions のリポジトリ変数（デプロイ用。秘匿値ではない）

`docs/azure-setup.md` の §4・§5 が済んだあとに登録する。

```bash
R=nonooktk/ballon-modern
gh variable set AZURE_CLIENT_ID       --repo $R --body "<§4.1 の AZURE_CLIENT_ID>"
gh variable set AZURE_TENANT_ID       --repo $R --body "<§4.1 の AZURE_TENANT_ID>"
gh variable set AZURE_SUBSCRIPTION_ID --repo $R --body "9b680e6d-e5a6-4381-aad5-a30afcbc8459"
gh variable set NEXT_PUBLIC_API_BASE_URL     --repo $R --body "https://app-ballon-api-nonooktk.azurewebsites.net"
gh variable set NEXT_PUBLIC_GOOGLE_CLIENT_ID --repo $R --body "<§5 の OAuth クライアント ID>"
gh variable list --repo $R
```

## 8. デプロイの実行（統括の承認後だけ）

`deploy-api.yml`・`deploy-web.yml` は `workflow_dispatch` のみ。main の push では動かない。

```bash
gh workflow run deploy-api.yml --repo nonooktk/ballon-modern --ref main -f git_ref=main
gh run list --workflow deploy-api.yml --repo nonooktk/ballon-modern --limit 3
```

切り戻しは `git_ref` に前回の SHA を入れて同じコマンドを実行する。
