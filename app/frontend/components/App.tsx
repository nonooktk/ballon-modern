"use client";

import { useEffect, useRef, useState } from "react";
import AuthProvider, { useAuth } from "./AuthProvider";
import DetailScreen from "./DetailScreen";
import FxLayer from "./FxLayer";
import GameProvider, { useGame } from "./GameProvider";
import HomeScreen from "./HomeScreen";
import LevelBar from "./LevelBar";
import Login from "./Login";
import Toast from "./Toast";
import TrendScreen from "./TrendScreen";
import Zawa from "./Zawa";

function Screens() {
  const { home, held, screen } = useGame();
  // リセットは常時は出さない: ?demo=1、またはタイトルを 1.5 秒長押し
  const [demo, setDemo] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("demo") === "1") void Promise.resolve().then(() => setDemo(true));
  }, []);
  const startHold = () => { timer.current = setTimeout(() => setDemo(true), 1500); };
  const endHold = () => { if (timer.current) clearTimeout(timer.current); };
  return (
    <>
      <LevelBar progress={home?.progress ?? null} held={held} showReset={demo} />
      <main className="wrap" id="app-wrap">
        <header style={{ marginBottom: 16 }}>
          <h1 onPointerDown={startHold} onPointerUp={endHold} onPointerLeave={endHold} onPointerCancel={endHold} style={{ font: "800 1.6rem/1.3 var(--font-display)", margin: "0 0 4px", color: "var(--gold-400)" }}>ふうせん</h1>
          <p style={{ font: "800 1rem/1.4 var(--font-display)", margin: 0 }}>ふくらめ…っ！ 一日一押し</p>
        </header>
        {screen.name === "home" && <HomeScreen />}
        {screen.name === "detail" && <DetailScreen actionId={screen.actionId} />}
        {screen.name === "trend" && <TrendScreen />}
      </main>
      <Toast />
    </>
  );
}

function Gate() {
  const { status, sub } = useAuth();
  if (status === "init") return <p className="vh" role="status">読み込み中</p>;
  const signedIn = status === "signedIn" || status === "expired";
  return (
    <>
      <Zawa />
      {/* 期限切れのあいだも画面の状態は残す（待たせた送信が、再ログイン後に同じ op_id で届く）。利用者が変わったら作り直す */}
      {signedIn && sub && (
        <GameProvider key={sub}>
          <div hidden={status !== "signedIn"}><Screens /></div>
        </GameProvider>
      )}
      {status !== "signedIn" && <Login expired={status === "expired"} />}
      <FxLayer />
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
