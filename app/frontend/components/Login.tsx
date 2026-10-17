"use client";

import { useEffect, useRef, useState } from "react";
import { GOOGLE_CLIENT_ID } from "@/lib/config";
import { useAuth } from "./AuthProvider";
import BalloonArt from "./Balloon";

export default function Login({ expired }: { expired: boolean }) {
  const { renderGoogleButton, devLogin, gisFailed } = useAuth();
  const btn = useRef<HTMLDivElement>(null);
  const [devSub, setDevSub] = useState("dev-user");

  useEffect(() => {
    if (btn.current) renderGoogleButton(btn.current);
  }, [renderGoogleButton]);

  return (
    <main className="wrap">
      <div className="panel tone" aria-labelledby="login-h">
        <div className="spacer" />
        <div className="center">
          <BalloonArt />
          <h1 id="login-h" style={{ font: "800 2rem/1.2 var(--font-display)", margin: "8px 0 0", color: "var(--gold-400)" }}>ふうせん</h1>
          <p style={{ font: "800 1.05rem/1.5 var(--font-display)", margin: "4px 0 0" }}>ふくらめ…っ！ 一日一押し</p>
        </div>
        <div className="spacer" />
        {expired && (
          <p className="note center" role="status">時間がたって、ログインが切れた…。もう一度ログインすれば、続きから…！</p>
        )}
        {GOOGLE_CLIENT_ID ? (
          <div className="login-btn" ref={btn} aria-label="Google でログイン" />
        ) : (
          <p className="note center" role="alert">ログインの設定がまだ入っていない…（NEXT_PUBLIC_GOOGLE_CLIENT_ID）</p>
        )}
        {gisFailed && (
          <p className="note center" role="alert">Google のログインを読み込めなかった…。通信を確かめて、ページを開き直して…！</p>
        )}
        {/* リテラルで書くのは、本番ビルドで開発ログインごと取り除くため */}
        {process.env.NEXT_PUBLIC_DEV_AUTH === "1" && (
          <form
            onSubmit={(e) => { e.preventDefault(); devLogin(devSub); }}
            style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}
          >
            <label className="note" htmlFor="dev-sub">開発用の名前</label>
            <input
              id="dev-sub" value={devSub} onChange={(e) => setDevSub(e.target.value)} maxLength={40}
              style={{ minHeight: 44, padding: "0 8px", background: "var(--ink-900)", color: "var(--text)", border: "2px solid var(--gold-400)", borderRadius: 6, font: "inherit", width: 140 }}
            />
            <button type="submit" className="btn ghost">開発ログイン</button>
          </form>
        )}
        <p className="note center">記録は自分だけのもの。どの端末でも続きから。</p>
      </div>
    </main>
  );
}
