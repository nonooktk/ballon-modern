"use client";

import { useGame } from "./GameProvider";

/** 押した直後に出る札。「取り消す」は 10 分以内なら API が受ける（札は数秒で消える）。 */
export default function Toast() {
  const { toast, dismissToast } = useGame();
  return (
    <div aria-live="polite" role="status">
      {toast && (
        <div className={toast.kind === "error" ? "toast error" : "toast"} key={toast.id}>
          <p>{toast.text}</p>
          {toast.undo && (
            <button type="button" className="btn ghost" onClick={() => { const u = toast.undo; dismissToast(); u?.(); }}>取り消す</button>
          )}
        </div>
      )}
    </div>
  );
}
