// 効果音。Web Audio API で合成する（音声ファイル・外部読み込みは使わない）。
// - 切り替え（♪）の状態は localStorage。初期値は ON、prefers-reduced-motion のときは OFF
// - OFF のあいだは AudioContext を作らない。最初のタップで作って resume する（iOS Safari は無音バッファで解錠）
// - マスターは約 -12dB。同時発音に上限を置き、連打で重なっても割れないようにする

const KEY = "ballon.sfx";
const MASTER_GAIN = 0.25; // 約 -12dB
const MAX_VOICES = 96; // 弾け（ドン連打＋余韻＋歓声）を入れても足りる数

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let voices = 0;
let boomBus: GainNode | null = null;
let boomIn: AudioNode | null = null; // 弾け専用（歪み → +3dB のピーク許容 → master）
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
    const comp = ctx.createDynamicsCompressor(); // 重なっても割れないように。ドンが潰れないよう閾値は下げすぎない
    comp.threshold.value = -6; comp.knee.value = 6; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
    master.connect(comp); comp.connect(ctx.destination);
    // 弾けの歪み（軽い飽和）と、+3dB 程度のピーク許容
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2); }
    shaper.curve = curve;
    boomBus = ctx.createGain(); boomBus.gain.value = 1.41;
    shaper.connect(boomBus); boomBus.connect(master);
    boomIn = shaper;
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

let popTimes: number[] = [];

/** ドン: サブベース（55→30Hz）＋ノイズの破裂（4kHz→200Hz）を、歪みを通して鳴らす */
function boom(c: AudioContext, at: number): void {
  if (!boomIn) return;
  if (voices >= MAX_VOICES) return;
  voices++;
  const o = c.createOscillator(); const g = c.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(55, at); o.frequency.exponentialRampToValueAtTime(30, at + 0.4);
  g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(1.0, at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
  o.connect(g); g.connect(boomIn);
  o.onended = () => { voices--; o.disconnect(); g.disconnect(); };
  o.start(at); o.stop(at + 0.47);
  noise(c, at, 0.6, 0.9, 4000, 200, boomIn);
}

/** パチパチの余韻: 短いノイズを 0.3〜1.2 秒の間にランダムに n 回 */
function crackles(c: AudioContext, at: number, n: number): void {
  for (let i = 0; i < n; i++) noise(c, at + 0.3 + Math.random() * 0.9, 0.02 + Math.random() * 0.03, 0.12 + Math.random() * 0.15, 8000, 2000);
}

/** 歓声風: 声の帯域（300〜3kHz）のバンドパスノイズ 6〜8 本。LFO 4〜7Hz の揺れと違う音量カーブで 1.5〜2.5 秒。立ち上がりは爆発の直後 */
function cheer(c: AudioContext, at: number): void {
  if (!master || !noiseBuf) noise(c, at, 0.01, 0, 100, 100); // 雑音のバッファを先に作る
  const nb = noiseBuf;
  if (!nb || !master) return;
  const n = 6 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    if (voices >= MAX_VOICES) return;
    voices++;
    const dur = 1.5 + Math.random();
    const s = c.createBufferSource(); s.buffer = nb; s.loop = true;
    const bp = c.createBiquadFilter(); bp.type = "bandpass";
    bp.frequency.value = 300 + (i / Math.max(n - 1, 1)) * 2700 * (0.7 + Math.random() * 0.3); bp.Q.value = 1.2 + Math.random();
    const g = c.createGain(); // 音量カーブ: 爆発の直後に「ワーッ」と膨らんで引く
    const peak = 0.5 + Math.random() * 0.3;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.2 + Math.random() * 0.25);
    g.gain.setValueAtTime(peak, at + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    const lfo = c.createOscillator(); const depth = c.createGain(); // 揺れ
    lfo.frequency.value = 4 + Math.random() * 3; depth.gain.value = peak * 0.35;
    lfo.connect(depth); depth.connect(g.gain);
    s.connect(bp); bp.connect(g); g.connect(master);
    s.onended = () => { voices--; [s, bp, g, lfo, depth].forEach((x) => x.disconnect()); };
    s.start(at, Math.random()); lfo.start(at);
    s.stop(at + dur + 0.02); lfo.stop(at + dur + 0.02);
  }
}

const hz = (base: number, semis: number) => base * Math.pow(2, semis / 12);

function tone(c: AudioContext, freq: number, at: number, dur: number, type: OscillatorType, vol: number, to?: AudioNode): void {
  if (voices >= MAX_VOICES || !master) return;
  voices++;
  const o = c.createOscillator(); const g = c.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g); g.connect(to ?? master);
  o.onended = () => { voices--; o.disconnect(); g.disconnect(); };
  o.start(at); o.stop(at + dur + 0.02);
}

function noise(c: AudioContext, at: number, dur: number, vol: number, f0: number, f1: number, to?: AudioNode): void {
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
  s.connect(f); f.connect(g); g.connect(to ?? master);
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
  /** 弾け: 溜め 80ms の無音 → ドン（Lv で 1/2/3 連）＋余韻＋レベル別のファンファーレ。Lv5 は歓声つき */
  pop(fromLevel: number): void {
    run((c, t) => {
      const tier = fromLevel >= 5 ? 5 : fromLevel >= 3 ? 3 : 1;
      const T0 = t + 0.08; // 溜め
      const booms = tier === 5 ? 3 : tier === 3 ? 2 : 1;
      for (let i = 0; i < booms; i++) boom(c, T0 + i * 0.15);
      crackles(c, T0 + 0.1, tier === 5 ? 20 : tier === 3 ? 15 : 10);
      const C5 = 523.25;
      const t0 = T0 + (booms - 1) * 0.15 + 0.12;
      if (tier === 1) { // 短い 3 音
        [0, 4, 7].forEach((s, i) => tone(c, hz(C5, s), t0 + i * 0.1, 0.25, "triangle", 0.5));
      } else if (tier === 3) { // アルペジオ
        [0, 4, 7, 12, 16, 19].forEach((s, i) => tone(c, hz(C5, s), t0 + i * 0.075, 0.28, "triangle", 0.45));
        tone(c, hz(C5, 24), t0 + 0.5, 0.5, "triangle", 0.45);
      } else { // 長いファンファーレ＋歓声＋金の雨の間のきらきら
        [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => tone(c, hz(C5, s), t0 + i * 0.09, 0.3, "square", 0.22));
        [-12, -8, -5, 0, 4, 7, 12].forEach((s) => tone(c, hz(C5, s), t0 + 0.7, 1.1, "triangle", 0.25));
        for (let i = 0; i < 14; i++) tone(c, hz(2093, [0, 4, 7, 12, 16][i % 5]), t0 + 0.9 + i * 0.12, 0.18, "sine", 0.14);
        cheer(c, T0 + 0.1);
      }
    });
  },
  /** リセット: 短い「しゅん」（しぼむ音）。祝わない */
  shun(): void {
    run((c, t) => {
      if (voices >= MAX_VOICES || !master) return;
      voices++;
      const o = c.createOscillator(); const g = c.createGain();
      o.type = "sine"; o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(180, t + 0.25);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g); g.connect(master);
      o.onended = () => { voices--; o.disconnect(); g.disconnect(); };
      o.start(t); o.stop(t + 0.3);
    });
  },
  /** 風船の連鎖で小さな風船が弾けたときの小さい「パン」。1 秒に 8 回まで */
  smallPop(): void {
    const now = performance.now();
    popTimes = popTimes.filter((x) => now - x < 1000);
    if (popTimes.length >= 8) return;
    popTimes.push(now);
    run((c, t) => {
      noise(c, t, 0.05, 0.5, 5000, 800);
      tone(c, 1800 + Math.random() * 600, t, 0.02, "square", 0.12);
    });
  },
};

// dev:mock のときだけ、確認用に出す（本番ビルドではこの枝ごと除かれる）
if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_MOCK === "1") {
  (window as unknown as { __sfx?: typeof sfx }).__sfx = sfx;
}
