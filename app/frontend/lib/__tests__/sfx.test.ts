import { beforeEach, describe, expect, it, vi } from "vitest";

// 毎回まっさらな状態で読み込む（モジュール内の状態を持ち越さない）
async function load(opts: { stored?: string; reduced?: boolean }) {
  vi.resetModules();
  const made: unknown[] = [];
  class FakeCtx {
    state = "running"; currentTime = 0; sampleRate = 8000; destination = {};
    constructor() { made.push(this); }
    createGain() { return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createDynamicsCompressor() { return { connect() {} }; }
    createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
    createBufferSource() { return { connect() {}, start() {}, stop() {}, disconnect() {} }; }
    createOscillator() { return { type: "", frequency: { value: 0 }, connect() {}, disconnect() {}, start() {}, stop() {} }; }
    createBiquadFilter() { return { frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    resume() { return Promise.resolve(); } suspend() { return Promise.resolve(); }
  }
  const store: Record<string, string> = opts.stored ? { "ballon.sfx": opts.stored } : {};
  vi.stubGlobal("window", { AudioContext: FakeCtx });
  vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
  vi.stubGlobal("matchMedia", () => ({ matches: !!opts.reduced }));
  return { mod: await import("../sfx"), made, store };
}
beforeEach(() => vi.unstubAllGlobals());

describe("効果音の ON/OFF", () => {
  it("初期値は ON", async () => {
    const { mod } = await load({});
    expect(mod.isSfxOn()).toBe(true);
  });
  it("動きを減らす設定のときは初期 OFF（保存値があればそちら）", async () => {
    expect((await load({ reduced: true })).mod.isSfxOn()).toBe(false);
    expect((await load({ reduced: true, stored: "1" })).mod.isSfxOn()).toBe(true);
  });
  it("OFF のあいだは AudioContext を作らない", async () => {
    const { mod, made } = await load({ stored: "0" });
    mod.sfx.tap(0); mod.sfx.pop(5); mod.sfx.confirm();
    expect(made).toHaveLength(0);
  });
  it("ON なら鳴らす時に作る。切り替えは保存される", async () => {
    const { mod, made, store } = await load({});
    mod.sfx.tap(2);
    expect(made).toHaveLength(1);
    mod.setSfxOn(false);
    expect(store["ballon.sfx"]).toBe("0");
  });
});
