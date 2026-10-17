import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Azure Web App への配備用（ARCHITECTURE.md §2）
  output: "standalone",
  // 未設定でも空文字で埋め込む。こうしておくと、本番ビルド（設定なし）では
  // モック（npm run dev:mock 用）と「開発ログイン」の枝がコードごと取り除かれる。
  env: {
    NEXT_PUBLIC_MOCK: process.env.NEXT_PUBLIC_MOCK ?? "",
    NEXT_PUBLIC_DEV_AUTH: process.env.NEXT_PUBLIC_DEV_AUTH ?? "",
  },
};

export default nextConfig;
