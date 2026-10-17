"use client";

import { useSyncExternalStore } from "react";
import { isSfxOn, setSfxOn, subscribeSfx } from "@/lib/sfx";

/** レベルバーの右の ♪。状態は localStorage（初期 ON、動きを減らす設定のときは OFF） */
export default function SfxToggle() {
  const on = useSyncExternalStore(subscribeSfx, isSfxOn, () => false);
  return (
    <button type="button" className="sfx-toggle" aria-pressed={on} aria-label="効果音" onClick={() => setSfxOn(!on)}>
      <span aria-hidden="true">♪</span>
    </button>
  );
}
