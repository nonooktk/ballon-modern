// 環境変数は NEXT_PUBLIC_* をリテラルで参照する（ビルド時に埋め込まれるため）。
// CI・配備は NEXT_PUBLIC_API_BASE_URL、依頼書の表記は NEXT_PUBLIC_API_BASE。両方を受ける。
export const API_BASE: string = (
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE ||
  "http://localhost:8000"
).replace(/\/+$/, "");

export const GOOGLE_CLIENT_ID: string = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

// 開発ログイン（Bearer dev:<sub>）。本番ビルドでは未設定なので false のまま。
export const DEV_AUTH: boolean = process.env.NEXT_PUBLIC_DEV_AUTH === "1";

// API が無くても動かす確認用（npm run dev:mock）。本番ビルドでは false で、モック本体は取り込まれない。
export const MOCK: boolean = process.env.NEXT_PUBLIC_MOCK === "1";
