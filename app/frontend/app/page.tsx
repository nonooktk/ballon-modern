"use client";

import { useEffect, useState } from "react";

// 骨組みのみ。画面の実装は T4（ポリゴン）。
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export default function Home() {
  const [health, setHealth] = useState<string>("確認中…");

  useEffect(() => {
    fetch(`${API_BASE}/health`)
      .then((r) => r.json())
      .then((d: { status: string }) => setHealth(d.status))
      .catch(() => setHealth("API に届きません"));
  }, []);

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", padding: 16, lineHeight: 1.8 }}>
      <h1>ふうせん</h1>
      <p>骨組みです。API の状態: {health}</p>
    </main>
  );
}
