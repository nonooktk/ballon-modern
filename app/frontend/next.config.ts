import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Azure Web App への配備用（ARCHITECTURE.md §2）
  output: "standalone",
};

export default nextConfig;
