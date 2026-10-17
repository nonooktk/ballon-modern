// 演出（押した瞬間の小演出・確定の中演出・弾けの大演出）。モック mock/index.html の演出ロジックを移植。
// DOM は FxLayer / LevelBar が描いた要素を id で引いて動かす（canvas とクラスの付け外しは React の外）。
// 点やレベルの計算は持たない。レベルは API の応答（progress / level_up）をそのまま受け取る。

import { sfx } from "./sfx";

const COLORS = ["#c8102e", "#e8c766", "#c9ced6", "#8e5cd9", "#ff7a1a", "#ffffff"];
const COLOR_NAMES = ["赤", "金", "銀", "紫", "朱金", "虹"];
const BALL = ["#c9ced6", "#e8c766", "#c8102e", "#ffffff"];

/** ふうせんの色（レベルで巡る）。表示だけの対応。 */
export function balloonColor(level: number): string {
  return COLORS[(Math.max(level, 1) - 1) % 6];
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const byId = (id: string) => document.getElementById(id);
const restart = (el: Element | null, cls: string) => {
  if (!el) return;
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
};
const temp = (cls: string, ms: number, setup?: (el: HTMLElement) => void) => {
  const el = document.createElement("div");
  el.className = cls;
  setup?.(el);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
  return el;
};

// ===== 小演出（押した瞬間・遷移なし・連打で重なる・連打で強くなる） =====
// 5 秒以内に続けて押すと段階が上がる。レベルに関係なく初期から出す（D-6）。
const STREAK = [
  { n: 120, word: "よし…！" },
  { n: 170, word: "ざわ…" },
  { n: 230, word: "止まらない…っ！" },
  { n: 280, word: "圧倒的…！" },
];
const MAX_P = 900; // 粒の上限（連打しても落ちないように）

interface SmallP {
  x: number; y: number; vx: number; vy: number; r: number; c: string; k: "ball" | "spark"; t: number; life: number; rot: number;
}
let sp: SmallP[] = [];
let sraf = 0;
let lastTap = -Infinity; // 読み込み直後の最初の 1 回目を連打と数えない
let streak = 0;
let lastFlash = 0;

function smallCtx(): { cv: HTMLCanvasElement; cx: CanvasRenderingContext2D } | null {
  const cv = byId("fx-small") as HTMLCanvasElement | null;
  const cx = cv?.getContext("2d");
  return cv && cx ? { cv, cx } : null;
}
function smallBurst(x: number, y: number, n: number): void {
  const c = smallCtx();
  if (!c) return;
  const d = devicePixelRatio;
  if (c.cv.width !== innerWidth * d) {
    c.cv.width = innerWidth * d;
    c.cv.height = innerHeight * d;
  }
  n = Math.min(n, Math.max(0, MAX_P - sp.length));
  const reach = Math.hypot(innerWidth, innerHeight) * d;
  const cols = ["#c9ced6", "#e8c766", "#c8102e", "#ffffff", "#f3dc95"];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.28;
    const v = (6 + Math.random() * 18) * d * (reach / (900 * d));
    sp.push({
      x: x * d, y: y * d, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 4 * d,
      r: (2 + Math.random() * 3.5) * d, c: cols[i % 5], k: i % 3 ? "ball" : "spark",
      t: 0, life: 40 + Math.random() * 20, rot: Math.random() * 6,
    });
  }
  if (!sraf) sraf = requestAnimationFrame(stepSmall);
}
function stepSmall(): void {
  const c = smallCtx();
  if (!c) { sp = []; sraf = 0; return; }
  const d = devicePixelRatio;
  const { cx, cv } = c;
  cx.clearRect(0, 0, cv.width, cv.height);
  for (const p of sp) {
    p.t++; p.vy += 0.32 * d; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += 0.25;
    cx.globalAlpha = Math.max(0, 1 - p.t / p.life);
    cx.fillStyle = p.c;
    if (p.k === "ball") { cx.beginPath(); cx.arc(p.x, p.y, p.r, 0, 7); cx.fill(); }
    else {
      cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot);
      cx.fillRect(-p.r * 1.6, -d, p.r * 3.2, 2 * d); cx.fillRect(-d, -p.r * 1.6, 2 * d, p.r * 3.2);
      cx.restore();
    }
  }
  sp = sp.filter((p) => p.t < p.life);
  sraf = sp.length ? requestAnimationFrame(stepSmall) : 0;
}

function floatPt(x: number, y: number, text: string): void { // 動きを止める設定のとき
  const el = document.createElement("span");
  el.className = "float-pt";
  el.textContent = text;
  el.style.left = x + "px";
  el.style.top = y - 20 + "px";
  el.style.animation = "none";
  el.style.transform = "translate(-50%,-50%)";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 800);
}

/** 押した瞬間の演出。戻り値は連打の段階の文言（読み上げ用にも使う）。 */
export function tapFx(button: HTMLElement, points: number): string {
  const now = performance.now();
  streak = now - lastTap <= 5000 ? streak + 1 : 0;
  lastTap = now;
  const s = STREAK[Math.min(streak, STREAK.length - 1)];
  const r = button.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const live = byId("small-live");
  if (live) live.textContent = `${s.word} ${points} 点`;
  sfx.tap(Math.min(streak, STREAK.length - 1)); // 効果音（OFF のときは何もしない）
  if (prefersReducedMotion()) { floatPt(x, y, `+${points} ${s.word}`); return s.word; }

  restart(button, "hit");
  [0, 110, 220].forEach((dl) =>
    setTimeout(() => temp("ring", 750, (el) => { el.style.left = x + "px"; el.style.top = y + "px"; }), dl));
  smallBurst(x, y, s.n);
  temp("taplines", 520, (el) => { el.style.setProperty("--cx", x + "px"); el.style.setProperty("--cy", y + "px"); });
  if (now - lastFlash > 400) { lastFlash = now; temp("tapflash", 200); } // 1 秒に 3 回以下
  document.querySelectorAll(".tapword").forEach((e) => e.remove()); // 文字だけは最新の 1 つにする
  const w = temp("tapword", 1000);
  const b = document.createElement("b");
  b.textContent = `+${points}`;
  const sub = document.createElement("span");
  sub.textContent = s.word;
  w.append(b, sub);
  restart(byId("app-wrap"), "tapshake");
  setTimeout(() => { restart(byId("lb-bar"), "shine"); restart(byId("lb-balloon"), "boing"); }, 350);
  return s.word;
}

// ===== 中・大の演出（オーバーレイ） =====
interface Tier {
  word: string; sub?: string; combo: string; reachText: string; reach: number; n: number;
  flash: boolean; bands: number; shake: boolean; rain: number; balloons?: number; chain?: number;
}
const T: Record<"mid" | "pop1" | "pop3" | "pop5", Tier> = {
  mid: { word: "よし…っ！", combo: "記録完了", reachText: "", reach: 0, n: 260, flash: false, bands: 2, shake: true, rain: 0 },
  pop1: { word: "弾けた…！", combo: "", reachText: "", reach: 0, n: 120, flash: false, bands: 0, shake: false, rain: 0, balloons: 20, chain: 1500 },
  pop3: { word: "弾けた…っ！", combo: "", reachText: "ざわ…ざわ…", reach: 800, n: 160, flash: false, bands: 1, shake: true, rain: 0, balloons: 40, chain: 2500 },
  pop5: { word: "圧倒的…！", sub: "圧倒的、ふくらみ…！", combo: "", reachText: "来る…来る…っ", reach: 1300, n: 200, flash: true, bands: 3, shake: true, rain: 360, balloons: 60, chain: 3500 },
};
/** 弾けの段階は、弾けたレベル（Lv1/3/5）で決まる。 */
function popTier(lv: number): "pop1" | "pop3" | "pop5" {
  return lv >= 5 ? "pop5" : lv >= 3 ? "pop3" : "pop1";
}

let timers: ReturnType<typeof setTimeout>[] = [];
let raf = 0;
const later = (f: () => void, ms: number) => { timers.push(setTimeout(f, ms)); };
const fxq = (s: string) => byId("fx")?.querySelector(s) as HTMLElement | null;

function resetFx(): void {
  const fx = byId("fx");
  const cv = byId("fx-c") as HTMLCanvasElement | null;
  if (!fx || !cv) return;
  timers.forEach(clearTimeout); timers = [];
  cancelAnimationFrame(raf);
  fx.className = "fx on";
  [".reach", ".combo", ".word", ".sub", ".drum", ".total"].forEach((s) => {
    const e = fxq(s);
    if (e) e.className = s.slice(1) + " hide";
  });
  fx.querySelectorAll(".band,.flash,.fxlines").forEach((e) => e.classList.remove("go", "go2", "go3"));
  cv.getContext("2d")?.clearRect(0, 0, cv.width, cv.height);
  byId("lb-balloon")?.classList.remove("swell", "burst", "regrow");
}

interface Part {
  x: number; y: number; vx: number; vy: number; r: number; c: string;
  k: "ball" | "shard" | "spark" | "coin" | "rubber"; rot: number; vr: number; life: number; age: number;
}
interface Balloon {
  x: number; y: number; tx: number; ty: number; r: number; c: string; born: number; pop: number; done: boolean; big: boolean;
}

// 風船の連鎖（画面全体で次々に弾ける）
const P_MAX = 1500; // 粒の上限
function chain(t: Tier, color: string, ox: number, oy: number, onFinal: () => void): void {
  const fx = byId("fx");
  const cv = byId("fx-c") as HTMLCanvasElement | null;
  const cx = cv?.getContext("2d");
  if (!fx || !cv || !cx) { onFinal(); return; }
  const d = devicePixelRatio;
  const W = (cv.width = innerWidth * d);
  const H = (cv.height = innerHeight * d);
  const pal = [color, color, "#e8c766", "#c8102e", "#ffffff"];
  let ps: Part[] = [];
  const bs: Balloon[] = [];
  const spray = (x: number, y: number, n: number, c: string, power: number) => {
    n = Math.min(n, P_MAX - ps.length);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28;
      const v = (3 + Math.random() * 12) * d * power;
      const k = i % 3 === 0 ? "rubber" : i % 3 === 1 ? "ball" : "spark";
      ps.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2 * d, r: (3 + Math.random() * 6) * d,
        c: k === "rubber" ? c : BALL[(Math.random() * 4) | 0], k, rot: Math.random() * 6,
        vr: (Math.random() - 0.5) * 0.5, life: 50 + Math.random() * 40, age: 0,
      });
    }
  };
  spray(ox * d, oy * d, t.n, color, 1.4); // レベルバーのふうせんの破裂
  const N = t.balloons ?? 0;
  const D = t.chain ?? 1500;
  for (let i = 0; i < N; i++) {
    const fromBottom = Math.random() < 0.55;
    const r = (30 + Math.random() * 30) * d;
    const tx = (0.06 + Math.random() * 0.88) * W;
    const ty = (0.08 + Math.random() * 0.84) * H;
    const born = (i / N) * D * 0.35;
    const pop = Math.min(D - 60, born + 600 + Math.random() * D * 0.35);
    bs.push({
      x: fromBottom ? tx : Math.random() < 0.5 ? -r : W + r, y: fromBottom ? H + r * 2 : ty, tx, ty, r,
      c: pal[(Math.random() * pal.length) | 0], born, pop, done: false, big: false,
    });
  }
  bs.push({ x: W / 2, y: H + 120 * d, tx: W / 2, ty: H * 0.45, r: 70 * d, c: color, born: D * 0.55, pop: D, done: false, big: true }); // 締めの大きな風船
  for (let i = 0; i < t.rain; i++) {
    ps.push({
      x: Math.random() * W, y: -Math.random() * H * 0.8, vx: (Math.random() - 0.5) * d, vy: (2 + Math.random() * 3) * d,
      r: (4 + Math.random() * 5) * d, c: i % 3 ? "#e8c766" : "#f3dc95", k: "coin", rot: Math.random() * 6, vr: 0.2, life: 9999, age: 0,
    });
  }
  const t0 = performance.now();
  const end = D + 1800;
  let lines = 0;
  const drawBalloon = (b: Balloon, s: number) => {
    const r = b.r * s;
    cx.globalAlpha = 1;
    cx.strokeStyle = "#e8c766"; cx.lineWidth = 1.5 * d; cx.beginPath();
    cx.moveTo(b.x, b.y + r * 1.2); cx.quadraticCurveTo(b.x - r * 0.3, b.y + r * 1.7, b.x + r * 0.1, b.y + r * 2.3); cx.stroke();
    cx.fillStyle = b.c; cx.strokeStyle = "#000"; cx.lineWidth = 2.5 * d;
    cx.beginPath(); cx.ellipse(b.x, b.y, r, r * 1.15, 0, 0, 7); cx.fill(); cx.stroke();
    cx.beginPath(); cx.moveTo(b.x - r * 0.15, b.y + r * 1.25); cx.lineTo(b.x + r * 0.15, b.y + r * 1.25); cx.lineTo(b.x, b.y + r * 1.1); cx.fill();
    cx.fillStyle = "rgba(255,255,255,.4)"; cx.beginPath(); cx.ellipse(b.x - r * 0.35, b.y - r * 0.4, r * 0.2, r * 0.32, -0.4, 0, 7); cx.fill();
  };
  const step = (now: number) => {
    const el = now - t0;
    cx.clearRect(0, 0, W, H);
    for (const b of bs) {
      if (b.done || el < b.born) continue;
      const k = Math.min(1, (el - b.born) / Math.max(1, b.pop - b.born));
      b.x += (b.tx - b.x) * 0.12; b.y += (b.ty - b.y) * 0.12;
      if (el >= b.pop) {
        b.done = true;
        spray(b.x, b.y, b.big ? 300 : 45, b.c, b.big ? 2.2 : 1.1);
        if (!b.big) sfx.smallPop();
        if (b.big) onFinal();
        else if (++lines % 6 === 0) {
          fx.style.setProperty("--ox", b.x / d + "px"); fx.style.setProperty("--oy", b.y / d + "px");
          restart(fxq(".fxlines"), "go");
        }
        continue;
      }
      drawBalloon(b, b.big ? 0.6 + 0.7 * k : 1 + 0.25 * k * k);
    }
    for (const p of ps) {
      p.age++;
      if (p.k === "coin") p.vy += 0.05 * d; else { p.vy += 0.28 * d; p.vx *= 0.985; }
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      cx.globalAlpha = p.k === "coin" ? Math.max(0, 1 - el / end) : Math.max(0, 1 - p.age / p.life);
      cx.fillStyle = p.c;
      if (p.k === "coin") { cx.beginPath(); cx.ellipse(p.x, p.y, p.r, p.r * Math.abs(Math.cos(p.rot)) + 0.5, 0, 0, 7); cx.fill(); }
      else if (p.k === "ball") { cx.beginPath(); cx.arc(p.x, p.y, p.r * 0.8, 0, 7); cx.fill(); }
      else if (p.k === "rubber") {
        cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot); cx.beginPath();
        cx.moveTo(-p.r * 1.2, -p.r * 0.3); cx.quadraticCurveTo(0, -p.r, p.r * 1.1, -p.r * 0.2); cx.lineTo(p.r * 0.5, p.r * 0.5);
        cx.quadraticCurveTo(-p.r * 0.2, p.r * 0.1, -p.r * 0.9, p.r * 0.6); cx.closePath(); cx.fill(); cx.restore();
      } else {
        cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot);
        cx.fillRect(-p.r, -d, p.r * 2, 2 * d); cx.fillRect(-d, -p.r, 2 * d, p.r * 2); cx.restore();
      }
    }
    ps = ps.filter((p) => p.age < p.life && p.y < H + 60 * d);
    if (el < end) raf = requestAnimationFrame(step); else cx.clearRect(0, 0, W, H);
  };
  step(t0);
}

// 確定の中演出の粒
function burst(t: Tier, color: string, ox: number, oy: number): void {
  const cv = byId("fx-c") as HTMLCanvasElement | null;
  const cx = cv?.getContext("2d");
  if (!cv || !cx) return;
  const d = devicePixelRatio;
  const W = (cv.width = innerWidth * d);
  const H = (cv.height = innerHeight * d);
  const cols = [color, ...BALL];
  const ps: Part[] = Array.from({ length: t.n }, () => {
    const a = Math.random() * 6.28;
    const v = (5 + Math.random() * 15) * d;
    return {
      x: ox * d, y: oy * d, vx: Math.cos(a) * v, vy: Math.sin(a) * v + 3 * d, r: (3 + Math.random() * 6) * d,
      c: cols[(Math.random() * cols.length) | 0],
      k: Math.random() < 0.55 ? "ball" : Math.random() < 0.5 ? "shard" : "spark", rot: Math.random() * 6, vr: 0.2, life: 9999, age: 0,
    } as Part;
  });
  const t0 = performance.now();
  const dur = 2400;
  const step = (now: number) => {
    const el = now - t0;
    cx.clearRect(0, 0, W, H);
    ps.forEach((p) => {
      p.vy += 0.3 * d; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += 0.2;
      cx.globalAlpha = Math.max(0, 1 - el / dur);
      cx.fillStyle = p.c;
      if (p.k === "ball") {
        cx.beginPath(); cx.arc(p.x, p.y, p.r * 0.8, 0, 7); cx.fill();
        cx.fillStyle = "rgba(255,255,255,.7)"; cx.beginPath(); cx.arc(p.x - p.r * 0.25, p.y - p.r * 0.25, p.r * 0.25, 0, 7); cx.fill();
      } else if (p.k === "shard") {
        cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot); cx.beginPath();
        cx.moveTo(-p.r, 0); cx.lineTo(0, -p.r * 0.6); cx.lineTo(p.r, p.r * 0.4); cx.fill(); cx.restore();
      } else {
        cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot);
        cx.fillRect(-p.r, -d, p.r * 2, 2 * d); cx.fillRect(-d, -p.r, 2 * d, p.r * 2); cx.restore();
      }
    });
    if (el < dur) raf = requestAnimationFrame(step); else cx.clearRect(0, 0, W, H);
  };
  step(t0);
}

function drum(final: string, done: () => void): void {
  const el = fxq(".drum");
  if (!el) { done(); return; }
  el.classList.remove("hide");
  const t0 = performance.now();
  const roll = (now: number) => {
    if (now - t0 < 500) { el.textContent = "+" + String((Math.random() * 999) | 0).padStart(3, "0"); raf = requestAnimationFrame(roll); }
    else { el.textContent = final; done(); }
  };
  roll(t0);
}

function finish(ms: number): void {
  later(() => byId("fx")?.classList.add("fade"), ms);
  later(() => { resetFx(); const fx = byId("fx"); if (fx) fx.className = "fx"; }, ms + 550);
}

export interface PopOptions {
  /** 弾けたレベル（level_up.before）。段階と色が決まる */
  fromLevel: number;
  /** 弾けた瞬間にレベルバーの満タン固定を解く（React 側の状態を戻す） */
  release: () => void;
}

/** 動きを止める設定: レベルバーの横に 2 秒だけ静止で出す */
function reducedPop(fromLv: number, release: () => void): void {
  release();
  sfx.pop(fromLv);
  const lb = document.querySelector(".levelbar");
  if (!lb) return;
  const el = document.createElement("span");
  el.className = "lb-pop";
  el.textContent = `弾けた…！ Lv ${fromLv + 1} へ`;
  lb.appendChild(el);
  setTimeout(() => el.remove(), 2000);
  const live = byId("fx-live");
  if (live) live.textContent = `弾けた。Lv ${fromLv + 1} へ`;
}

// 途中で次の演出に割り込まれても、前の弾けの「満タン固定」が残らないよう、解除関数を覚えておく
let pendingRelease: (() => void) | null = null;

function play(kind: "mid" | "pop1" | "pop3" | "pop5", o: { fromLevel?: number; release?: () => void; points?: number; totalText?: string }): void {
  const t = T[kind];
  const isPop = kind !== "mid";
  const fromLv = o.fromLevel ?? 0;
  const release = o.release ?? (() => {});
  const fx = byId("fx");
  pendingRelease?.();
  pendingRelease = isPop ? release : null;
  if (!fx) { release(); return; }
  resetFx();
  const color = isPop ? balloonColor(fromLv) : "#e8c766";
  const lbEl = byId("lb-balloon");
  const lb = lbEl?.getBoundingClientRect();
  const ox = isPop && lb ? lb.left + lb.width / 2 : innerWidth / 2;
  const oy = isPop && lb ? lb.top + lb.height / 2 : innerHeight * 0.42;
  fx.style.setProperty("--ox", ox + "px"); fx.style.setProperty("--oy", oy + "px");
  const combo = isPop ? `Lv ${fromLv + 1} へ` : t.combo;
  const totalText = isPop ? `次は${COLOR_NAMES[fromLv % 6]}のふうせん…！` : (o.totalText ?? "");
  const set = (s: string, v: string) => { const e = fxq(s); if (e) e.textContent = v; };
  set(".combo", combo); set(".word", t.word); set(".sub", t.sub ?? ""); set(".reach", t.reachText); set(".total", totalText);
  const live = byId("fx-live");
  if (live) live.textContent = `${combo} ${t.word} ${t.sub ?? ""} ${totalText}`;
  fx.classList.add("t-" + kind);
  const swell = isPop ? Math.max(450, t.reach) : 0;
  if (isPop && lbEl) { lbEl.style.setProperty("--sw", swell + "ms"); lbEl.classList.add("swell"); }
  if (t.reach && isPop) sfx.reach(t.reach);
  if (t.reach) { fx.classList.add("card"); fxq(".reach")?.classList.remove("hide"); fxq(".reach")?.classList.add("go"); }
  later(() => { // 破裂・開放
    fxq(".reach")?.classList.add("hide");
    fx.classList.remove("card");
    if (isPop && lbEl) {
      lbEl.classList.remove("swell"); lbEl.classList.add("burst");
      later(() => {
        lbEl.classList.remove("burst");
        release();
        pendingRelease = null;
        void lbEl.getBoundingClientRect();
        lbEl.classList.add("regrow");
        restart(byId("lb-lv"), "jump");
      }, 260);
    }
    const showText = () => {
      fx.classList.remove("card"); void fx.offsetWidth; fx.classList.add("card");
      if (t.flash && isPop) fxq(".flash")?.classList.add("go"); // 締めで 1 回だけ
      if (combo) fxq(".combo")?.classList.remove("hide");
      const w = fxq(".word");
      w?.classList.remove("hide"); w?.classList.add("go");
      if (t.sub) fxq(".sub")?.classList.remove("hide");
      if (isPop) later(() => fxq(".total")?.classList.remove("hide"), 300);
      else later(() => drum(`+${o.points ?? 20}`, () => fxq(".total")?.classList.remove("hide")), 200);
    };
    if (!isPop && t.flash) fxq(".flash")?.classList.add("go");
    if (t.reach || t.rain) fxq(".fxlines")?.classList.add("go");
    if (t.bands >= 1) fxq(".band")?.classList.add("go");
    if (t.bands >= 2) fxq(".b2")?.classList.add("go2");
    if (t.bands >= 3) fxq(".b3")?.classList.add("go3");
    if (t.shake) restart(byId("app-wrap"), "tapshake");
    if (isPop) { sfx.pop(fromLv); chain(t, color, ox, oy, () => { showText(); finish(1500); }); }
    else { sfx.confirm(); burst(t, color, ox, oy); showText(); finish(1500); }
  }, swell);
}

/** 弾け（level_up を受けたとき）。 */
export function playPop(o: PopOptions): void {
  if (prefersReducedMotion()) { reducedPop(o.fromLevel, o.release); return; }
  play(popTier(o.fromLevel), { fromLevel: o.fromLevel, release: o.release });
}

/** 確定の中演出。続けて弾けがあるときは popAfter を渡す。 */
export function playConfirm(o: { points: number; totalText: string; popAfter?: PopOptions }): void {
  if (prefersReducedMotion()) {
    const live = byId("fx-live");
    if (live) live.textContent = `記録完了。${o.points} 点`;
    sfx.confirm();
    if (o.popAfter) reducedPop(o.popAfter.fromLevel, o.popAfter.release);
    return;
  }
  play("mid", { points: o.points, totalText: o.totalText });
  if (o.popAfter) { const p = o.popAfter; setTimeout(() => play(popTier(p.fromLevel), { fromLevel: p.fromLevel, release: p.release }), 1300); }
}

/** リセットの小さい演出: レベルバーの風船がしぼむ。爆発や祝いは出さない。音は短い「しゅん」 */
export function deflateFx(): void {
  sfx.shun();
  if (prefersReducedMotion()) return;
  restart(byId("lb-balloon"), "deflate");
}
