"use client";

import { balloonColor } from "@/lib/fx";
import type { Progress } from "@/lib/types";
import type { Held } from "./GameProvider";
import SfxToggle from "./SfxToggle";

/** 最上部に固定のレベルバー。値は API の progress のまま描く。 */
export default function LevelBar({ progress, held }: { progress: Progress | null; held: Held | null }) {
  let lv = progress?.level ?? 1;
  let pct = 0;
  let text: React.ReactNode = "読み込み中…";
  let now = 0;
  let max = 100;
  if (progress) {
    const ratio = progress.is_max ? 1 : progress.current_points / Math.max(progress.required_points, 1);
    pct = ratio * 100;
    now = progress.current_points;
    max = progress.required_points;
    text = progress.is_max ? (
      <><b>最大</b> ／ ふくらみきった…！</>
    ) : (
      <><b>{progress.current_points}</b> / {progress.required_points} 点 ／ あと {progress.remaining_points} 点で弾ける…！</>
    );
    if (held) { // 弾けるまで、満タンのまま旧レベルを見せる
      lv = held.lv;
      pct = 100;
      text = <><b>満タン…！</b> 弾ける…っ</>;
    }
  }
  const ratio = pct / 100;
  return (
    <div className="topbar">
      <div className="levelbar" role="group" aria-label="レベル">
        <svg className="lb-balloon" id="lb-balloon" viewBox="0 0 34 44" aria-hidden="true" style={{ transform: `scale(${0.7 + 0.5 * ratio})` }}>
          <ellipse cx="17" cy="16" rx="14" ry="15" fill={balloonColor(lv)} stroke="#000" strokeWidth="2" />
          <ellipse cx="12" cy="10" rx="3" ry="5" fill="#fff" opacity=".4" />
          <path d="M17 31 C14 36 20 39 17 44" stroke="#e8c766" fill="none" />
        </svg>
        <span className="lv" id="lb-lv">Lv {lv}</span>
        <div className="lb-main">
          <div className={held ? "bar full" : "bar"} role="progressbar" id="lb-bar" aria-label="次に弾けるまで"
            aria-valuemin={0} aria-valuemax={max} aria-valuenow={now}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="lb-text" id="lb-text">{text}</p>
        </div>
        <SfxToggle />
      </div>
    </div>
  );
}
