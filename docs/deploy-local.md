# 手元からのデプロイ手順（OIDC を使わない暫定版）

`az webapp deploy` で、手元でビルドした zip を送る。実行は統括の承認後だけ。OIDC（`docs/azure-setup.md` §4）に切り替えるまでの暫定手順。

- 前提: `az login` 済み、サブスクリプション `9b680e6d-e5a6-4381-aad5-a30afcbc8459`、RG `rg-001-gen12`。Web App 2 つ作成済み（API: `app-ballon-api-nonooktk`、画面: `app-ballon-web-nonooktk`）
- 作業ディレクトリ: リポジトリのルート。zip は `dist/`（git 管理外）に出る

> リポジトリの実体は `~/repos/ballon-modern`（iCloud 同期の外）。`apps/ballon-modern` はそこへのシンボリックリンク（2026-10-18 に iCloud 退避で .git が壊れたため移設）。担当者は `git worktree add ... ~/repos/ballon-modern-wt-<name>` で自分専用の作業ツリーを作り、同じ作業ツリーで複数人が git を動かさない。

## 1. アプリ設定を確認する（キー名だけ。値は出さない）

```bash
az webapp config appsettings list -g rg-001-gen12 -n app-ballon-api-nonooktk --query '[].name' -o tsv
az webapp config appsettings list -g rg-001-gen12 -n app-ballon-web-nonooktk --query '[].name' -o tsv
```

| Web App | 必要なキー |
| --- | --- |
| API | `DATABASE_URL`、`GOOGLE_CLIENT_ID`、`ALLOWED_ORIGINS`（画面の URL）、`WEBSITES_PORT=8000`、`SCM_DO_BUILD_DURING_DEPLOYMENT=true`（Oryx が `requirements.txt` から依存を入れる）。起動コマンドは `python -m uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1` |
| 画面 | `PORT=8080`、`HOSTNAME=0.0.0.0`（standalone の待ち受けに必要）、`SCM_DO_BUILD_DURING_DEPLOYMENT=false`（ビルド済みを置く）。起動コマンドは `node server.js` |

足りないキーがあるときは `docs/azure-setup.md` §3 のコマンド（`-o none` を付ける）で登録する。

## 2. API をビルドして配備する

```bash
ZIP_API=$(scripts/build-api.sh | tail -1)
scripts/deploy.sh api "$ZIP_API"      # 末尾で /health を確認する
```

## 3. API の /health を確かめる

`deploy.sh` が自動で確認する。手で見るなら:

```bash
curl -fsS https://app-ballon-api-nonooktk.azurewebsites.net/health
```

初回は Oryx のビルドで数分かかる。10 回（約 2.5 分）待っても通らないときは、ログを見る:

```bash
az webapp log tail -g rg-001-gen12 -n app-ballon-api-nonooktk
```

## 4. 画面をビルドして配備する

API の URL と Google のクライアント ID をビルド時に埋め込む（秘匿値ではない）。

```bash
export NEXT_PUBLIC_API_BASE_URL=https://app-ballon-api-nonooktk.azurewebsites.net
export NEXT_PUBLIC_GOOGLE_CLIENT_ID=<OAuth クライアント ID>
ZIP_WEB=$(scripts/build-web.sh | tail -1)
scripts/deploy.sh web "$ZIP_WEB"      # 末尾でトップの 200 を確認する
```

## 5. 画面を確認する

https://app-ballon-web-nonooktk.azurewebsites.net を開き、Google でログインしてホームが出ることを確かめる（スモークは書き込みを伴うので、テスト用アカウントで行う）。

## 6. 切り戻し

直前の zip を `dist/` に残してあるので、それを再デプロイする。

```bash
ls -t dist/api-*.zip      # 新しい順。2 つ目が一つ前
scripts/deploy.sh api dist/api-<前回の日時>-<sha>.zip
ls -t dist/web-*.zip
scripts/deploy.sh web dist/web-<前回の日時>-<sha>.zip
```

- 配備のたびに、直前の zip の名前を控える。`dist/` を消さない
- 前回の zip が無いときは、前回のコミットを checkout してビルドし直す（`git switch --detach <sha>` → ビルド → 配備 → `git switch -`）
- アプリ設定を間違えたときは `docs/azure-setup.md` §3 を正しい値で再実行する
- DB のマイグレーションは zip の切り戻しでは戻らない（`db/` の手順に従う）

## 注意

- `build-web.sh` は `app/frontend/node_modules` を `npm ci` で作り直す。ほかの作業で `npm test` などを動かしている間は実行しない（同時に動かすと `next: command not found` になった）
