// 効果音。Web Audio API で合成する（音声ファイル・外部読み込みは使わない）。
// - 切り替え（♪）の状態は localStorage。初期値は ON、prefers-reduced-motion のときは OFF
// - OFF のあいだは AudioContext を作らない。最初のタップで作って resume する（iOS Safari は無音バッファで解錠）
// - マスターは約 -12dB。同時発音に上限を置き、連打で重なっても割れないようにする

const KEY = "ballon.sfx";
const MASTER_GAIN = 0.25; // 約 -12dB
const MAX_VOICES = 24;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let voices = 0;
let noiseBuf: AudioBuffer | null = null;
let enabled: boolean | null = null;
const listeners = new Set<() => void>();

function reduced(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function isSfxOn(): boolean {
  if (enabled === null) {
    let v: string | null = null;
    try { v = localStorage.getItem(KEY); } catch { /* 読めなくても動く */ }
    enabled = v === "1" ? true : v === "0" ? false : !reduced();
  }
  return enabled;
}

export function subscribeSfx(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** ♪ の切り替え。ON にするタップの中で AudioContext を作る。 */
export function setSfxOn(on: boolean): void {
  enabled = on;
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* 無視 */ }
  if (on) { ensureCtx(); sfx.confirmBlip(); } else if (ctx) { void ctx.suspend().catch(() => {}); }
  listeners.forEach((f) => f());
}

function ensureCtx(): AudioContext | null {
  if (!isSfxOn()) return null; // OFF のときは作らない
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    const comp = ctx.createDynamicsCompressor(); // 重なっても割れないように
    master.connect(comp); comp.connect(ctx.destination);
    // iOS 解錠: 無音バッファを 1 回鳴らす
    const b = ctx.createBuffer(1, 1, 22050);
    const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

/** テスト・確認用 */
export function sfxState(): AudioContextState | "none" {
  return ctx ? ctx.state : "none";
}

const hz = (base: number, semis: number) => base * Math.pow(2, semis / 12);

function tone(c: AudioContext, freq: number, at: number, dur: number, type: OscillatorType, vol: number): void {
  if (voices >= MAX_VOICES || !master) return;
  voices++;
  const o = c.createOscillator(); const g = c.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g); g.connect(master);
  o.onended = () => { voices--; o.disconnect(); g.disconnect(); };
  o.start(at); o.stop(at + dur + 0.02);
}

function noise(c: AudioContext, at: number, dur: number, vol: number, f0: number, f1: number): void {
  if (voices >= MAX_VOICES || !master) return;
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  voices++;
  const s = c.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  const f = c.createBiquadFilter(); f.type = "lowpass";
  f.frequency.setValueAtTime(f0, at); f.frequency.exponentialRampToValueAtTime(Math.max(f1, 40), at + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  s.connect(f); f.connect(g); g.connect(master);
  s.onended = () => { voices--; s.disconnect(); f.disconnect(); g.disconnect(); };
  s.start(at); s.stop(at + dur + 0.02);
}

const run = (f: (c: AudioContext, t: number) => void) => {
  const c = ensureCtx();
  if (c) f(c, c.currentTime + 0.01);
};

export const sfx = {
  /** 押した瞬間: 短いコイン音（きらっ）。連打の段（0〜3）で音程が上がる */
  tap(step: number): void {
    run((c, t) => {
      const up = Math.min(Math.max(step, 0), 3) * 2; // 1 段ごとに全音
      tone(c, hz(988, up), t, 0.09, "square", 0.35);
      tone(c, hz(1319, up), t + 0.06, 0.22, "square", 0.3);
      tone(c, hz(2637, up), t + 0.06, 0.12, "triangle", 0.12); // きらっの倍音
    });
  },
  /** 確定（中演出）: 2 音の「決まった」音 */
  confirm(): void {
    run((c, t) => {
      tone(c, 784, t, 0.18, "triangle", 0.5);
      tone(c, 1047, t + 0.13, 0.4, "triangle", 0.55);
      tone(c, 2093, t + 0.13, 0.25, "sine", 0.12);
    });
  },
  /** ♪ を ON にしたときの小さな確認音 */
  confirmBlip(): void {
    run((c, t) => tone(c, 1175, t, 0.1, "triangle", 0.3));
  },
  /** リーチの溜め（Lv3/5）: 低いドラムロール風のノイズ */
  reach(ms: number): void {
    run((c, t) => {
      const n = Math.max(4, Math.floor(ms / 70));
      for (let i = 0; i < n; i++) noise(c, t + (i * ms) / n / 1000, 0.06, 0.25 + 0.55 * (i / n), 500, 150);
    });
  },
  /** 弾け: 破裂（ノイズのバースト）＋レベル別のファンファーレ（fromLevel は弾けたレベル） */
  pop(fromLevel: number): void {
    run((c, t) => {
      noise(c, t, 0.35, 0.9, 6000, 300);
      tone(c, 120, t, 0.25, "sine", 0.8); // どん
      const C5 = 523.25;
      const tier = fromLevel >= 5 ? 5 : fromLevel >= 3 ? 3 : 1;
      const t0 = t + 0.12;
      if (tier === 1) { // 短い 3 音
        [0, 4, 7].forEach((s, i) => tone(c, hz(C5, s), t0 + i * 0.1, 0.25, "triangle", 0.5));
      } else if (tier === 3) { // アルペジオ
        [0, 4, 7, 12, 16, 19].forEach((s, i) => tone(c, hz(C5, s), t0 + i * 0.075, 0.28, "triangle", 0.45));
        tone(c, hz(C5, 24), t0 + 0.5, 0.5, "triangle", 0.45);
      } else { // 長めのファンファーレ＋金の雨の間のきらきら
        [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => tone(c, hz(C5, s), t0 + i * 0.09, 0.3, "square", 0.22));
        [0, 4, 7, 12].forEach((s) => tone(c, hz(C5, s - 12), t0 + 0.7, 1.1, "triangle", 0.3)); // 締めの和音
        [0, 4, 7, 12].forEach((s) => tone(c, hz(C5, s), t0 + 0.7, 1.1, "triangle", 0.3));
        for (let i = 0; i < 14; i++) tone(c, hz(2093, [0, 4, 7, 12, 16][i % 5]), t0 + 0.9 + i * 0.12, 0.18, "sine", 0.14);
      }
    });
  },
};
