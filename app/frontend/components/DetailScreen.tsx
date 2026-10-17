"use client";

// 先のページ: 体重（前回値から ±0.1）／食事（量の 3 択）。確定で中演出。「あとで」で戻る。
import { useState } from "react";
import { findAction } from "@/lib/home";
import type { Portion } from "@/lib/types";
import { useGame } from "./GameProvider";

const PORTIONS: Array<[Portion, string]> = [["small", "少なめ"], ["normal", "ふつう"], ["large", "多め"]];
const W_DEFAULT = 60.0; // 前回値が無い初回の置き場

export default function DetailScreen({ actionId }: { actionId: string }) {
  const { home, goHome } = useGame();
  const a = findAction(home, actionId);
  if (!home || !a) { return null; }
  return a.detail === "weight"
    ? <WeightPage actionId={actionId} title={a.label} last={home.last_weight_kg} grants={a.confirm_state === "open"} onLater={goHome} />
    : <MealPage actionId={actionId} title={a.label} grants={a.confirm_state === "open"} onLater={goHome} />;
}

function head(title: string) {
  return title.replace(/…?！$/, "").replace(/を.*$/, "");
}

function WeightPage({ actionId, title, last, grants, onLater }: {
  actionId: string; title: string; last: number | null; grants: boolean; onLater: () => void;
}) {
  const { confirm } = useGame();
  // 0.1 刻みの整数（×10）で持つ。小数の足し算の誤差を出さない
  const [tenths, setTenths] = useState(Math.round((last ?? W_DEFAULT) * 10));
  const [busy, setBusy] = useState(false);
  const step = (d: number) => setTenths((t) => Math.min(3000, Math.max(200, t + d)));
  const kg = (tenths / 10).toFixed(1);
  const submit = async () => {
    setBusy(true);
    const ok = await confirm(actionId, { weight_kg: tenths / 10 });
    if (!ok) setBusy(false);
  };
  return (
    <div className="panel">
      <div className="appbar"><strong>体重…！</strong><button type="button" className="link" onClick={onLater}>あとで</button></div>
      <div className="weight" role="group" aria-labelledby="w-h">
        <p id="w-h" style={{ margin: "0 0 var(--space-2)", font: "800 1rem var(--font-display)" }}>
          いまの体重{" "}
          <span className="note" style={{ fontFamily: "var(--font-body)", fontWeight: 400 }}>
            {last !== null ? `前回 ${last.toFixed(1)} kg から` : "はじめての記録"}
          </span>
        </p>
        <div className="row">
          <button type="button" className="btn ghost step" aria-label="0.1 kg 減らす" onClick={() => step(-1)}>−</button>
          <output aria-live="polite">{kg} <small>kg</small></output>
          <button type="button" className="btn ghost step" aria-label="0.1 kg 増やす" onClick={() => step(1)}>＋</button>
        </div>
      </div>
      <div className="spacer" />
      <button type="button" className="btn main" onClick={submit} disabled={busy}>体重を記録する…っ！</button>
      <p className="note center">± で合わせるだけ。{grants ? "確定で +20 点。" : ""}</p>
      <span className="vh">{title}</span>
    </div>
  );
}

function MealPage({ actionId, title, grants, onLater }: {
  actionId: string; title: string; grants: boolean; onLater: () => void;
}) {
  const { confirm } = useGame();
  const [portion, setPortion] = useState<Portion>("normal");
  const [busy, setBusy] = useState(false);
  const name = head(title);
  const submit = async () => {
    setBusy(true);
    const ok = await confirm(actionId, { portion });
    if (!ok) setBusy(false);
  };
  return (
    <div className="panel">
      <div className="appbar"><strong>{name}…！</strong><button type="button" className="link" onClick={onLater}>あとで</button></div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ font: "800 1rem var(--font-display)", marginBottom: "var(--space-2)" }}>量は…？</legend>
        <div className="choices" role="group" aria-label="量">
          {PORTIONS.map(([v, t]) => (
            <button key={v} type="button" className="btn ghost" aria-pressed={portion === v} onClick={() => setPortion(v)}>{t}</button>
          ))}
        </div>
      </fieldset>
      <p className="note">どれを選んでも点は同じ。迷ったら、そのまま確定。</p>
      <div className="spacer" />
      <button type="button" className="btn main" onClick={submit} disabled={busy}>{name}を記録する…っ！</button>
      {!grants && <p className="note center">すでに点は付いている。内容だけ残る。</p>}
    </div>
  );
}
