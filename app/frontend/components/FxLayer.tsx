"use client";

import { memo } from "react";

/**
 * 演出の置き場。中身のクラスと canvas は lib/fx.ts が直接動かすので、React は一度描いたら触らない。
 * aria-live の 2 つは、演出の文言を読み上げる（演出そのものは aria-hidden）。
 */
function FxLayer() {
  return (
    <>
      <canvas id="fx-small" aria-hidden="true" />
      <p className="vh" id="small-live" aria-live="polite" />
      <div className="fx" id="fx" aria-hidden="true">
        <canvas id="fx-c" />
        <div className="fxlines" />
        <div className="band" /><div className="band b2" /><div className="band b3" />
        <div className="flash" />
        <div className="stage">
          <p className="reach hide" />
          <p className="combo hide" />
          <p className="word hide" />
          <p className="sub hide" />
          <p className="drum hide">+000</p>
          <p className="total hide" />
        </div>
      </div>
      <p className="vh" id="fx-live" aria-live="assertive" />
    </>
  );
}
export default memo(FxLayer);
