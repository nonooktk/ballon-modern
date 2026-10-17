# ふうせん（ballon-modern）

頑張らなくていいダイエット記録アプリ。Next.js（画面）・FastAPI（API）・PostgreSQL（DB）の三層。
設計と要件の正本はチームの保管庫（`02_プロジェクト/ballon-modern/`）にある。

## 構成

| ディレクトリ | 内容 |
| --- | --- |
| `app/backend/` | FastAPI（Python 3.12） |
| `app/frontend/` | Next.js（Node 22） |
| `db/` | マイグレーション（T2 で置く） |
| `docs/` | 手順書（Azure・GitHub 設定） |
| `infra/` | インフラ定義（現状は空） |
| `.github/workflows/` | CI（`ci.yml`）・セキュリティ（`security.yml`）・手動デプロイ（`deploy-*.yml`） |

## ローカルで動かす

```bash
# API
cd app/backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest
uvicorn main:app --reload --port 8000

# 画面（別ターミナル）
cd app/frontend
cp env.example .env.local
npm ci
npm run dev
```

環境変数のキー名は `.env.example`。値は入れてコミットしない。

## デプロイ

`docs/azure-setup.md`（Azure）と `docs/github-setup.md`（GitHub 設定）を参照。デプロイは手動（`workflow_dispatch`）のみ。
