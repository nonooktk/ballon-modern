# ふうせん 画面（app/frontend）

Next.js 16・React 19（App Router）。デザインの正本は `02_プロジェクト/ballon-modern/mock/index.html`。API との境界は `docs/openapi.yaml`。

## 動かし方

```bash
cd app/frontend
npm ci
cp env.example .env.local   # 値を入れる（.env.local はコミットされない）
npm run dev                 # 実 API に向ける（NEXT_PUBLIC_API_BASE_URL）
npm run dev:mock            # API なしで 1 周できる（画面内のモック API。開発ログインつき）
npm run lint && npm run build
npm test                    # API クライアント・直列送信・取り直しのユニットテスト
```

| 環境変数 | 用途 |
| --- | --- |
| `NEXT_PUBLIC_API_BASE_URL`（`NEXT_PUBLIC_API_BASE` でも可） | API の場所。ビルド時に埋め込まれる |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google Identity Services のクライアント ID（秘匿値ではない） |
| `NEXT_PUBLIC_DEV_AUTH=1` | 「開発ログイン」を出す。API 側は `DEV_AUTH_BYPASS` で `Bearer dev:<名前>` を受ける。**本番では設定しない** |
| `NEXT_PUBLIC_MOCK=1` | API の代わりに `lib/mock/server.ts` で動く。**本番では設定しない** |

本番ビルド（`NEXT_PUBLIC_MOCK` と `NEXT_PUBLIC_DEV_AUTH` が空）では、モックと開発ログインはコードごと取り除かれる（`next.config.ts` の `env` で空文字を埋め込むため）。

## 構成

- `lib/api.ts` … API クライアント（Bearer・時差ヘッダ・401 は新しいトークンを待って同じ `op_id` で再送・429 は 1 回だけ再送）
- `lib/serial.ts` … 同じ記録への操作を直列に送る
- `lib/fx.ts` … 演出（小演出・確定の中演出・弾けの大演出）。モックの演出ロジックを移植
- `components/` … 画面。`GameProvider` が状態と操作、`AuthProvider` が ID トークンの保持と取り直し
- 点・レベル・済・回数は API の応答のまま描く。画面側には計算を置かない
