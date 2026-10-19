import type { NextConfig } from "next";

// API の URL（CSP の connect-src に使う。未設定なら localhost の API）
const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

// CSP はまず Report-Only で入れる（監査 F-1）。違反が出ないことを確かめてから本適用に切り替える。
// Google Identity Services の要件: script-src と frame-src に https://accounts.google.com、
// style-src にも同じ生成元（ボタンの描画に使う）。
const csp = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com 'unsafe-inline'",
  "frame-src https://accounts.google.com",
  `connect-src 'self' ${apiBase} https://accounts.google.com`,
  "img-src 'self' data: https://*.googleusercontent.com https://accounts.google.com",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy-Report-Only", value: csp },
];

const nextConfig: NextConfig = {
  // Azure Web App への配備用（ARCHITECTURE.md §2）
  output: "standalone",
  // X-Powered-By を出さない（監査 F-1）
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // 未設定でも空文字で埋め込む。こうしておくと、本番ビルド（設定なし）では
  // モック（npm run dev:mock 用）と「開発ログイン」の枝がコードごと取り除かれる。
  env: {
    NEXT_PUBLIC_MOCK: process.env.NEXT_PUBLIC_MOCK ?? "",
    NEXT_PUBLIC_DEV_AUTH: process.env.NEXT_PUBLIC_DEV_AUTH ?? "",
  },
};

export default nextConfig;
