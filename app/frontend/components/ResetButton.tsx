"use client";

// デモ用の全リセット。常時は出さない（タイトル長押し か ?demo=1）。押すと確認の札。
import { useState } from "react";
import { useGame } from "./GameProvider";

export default function ResetButton() {
  const { resetAll } = useGame();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    await resetAll();
    setBusy(false);
    setAsking(false);
  };
  return (
    <>
      <button type="button" className="reset-btn" onClick={() => setAsking(true)}>リセット</button>
      {asking && (
        <div className="confirm-card" role="alertdialog" aria-label="リセットの確認">
          <p>すべてを無に帰す…？ 記録も点も、Lv1 に戻る</p>
          <div className="row">
            <button type="button" className="btn ghost" onClick={() => setAsking(false)} disabled={busy}>やめる</button>
            <button type="button" className="btn" onClick={go} disabled={busy}>戻す…！</button>
          </div>
        </div>
      )}
    </>
  );
}
