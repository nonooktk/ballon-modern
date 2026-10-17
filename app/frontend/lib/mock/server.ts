// API の代わりをする画面内モック（npm run dev:mock 専用）。docs/openapi.yaml の形に合わせてある。
// 本番ビルドでは NEXT_PUBLIC_MOCK が無いので、api.ts の動的 import ごと取り込まれない。
// 点やレベルの計算はここ（API の代役）にだけあり、画面側のコードには置かない。
import type {
  ActionState, Band, ConfirmState, Home, Progress, Trend, TrendDay,
} from "../types";

interface ActionDef {
  id: string; label: string; icon: string; frequency: "daily_once" | "repeatable"; detail: "none" | "weight" | "meal";
}
const ACTIONS: ActionDef[] = [
  { id: "dinner", label: "夕食を食べた", icon: "🍱", frequency: "daily_once", detail: "meal" },
  { id: "nosnack", label: "夜食なしで寝る", icon: "🌙", frequency: "daily_once", detail: "none" },
  { id: "weight", label: "体重をはかった", icon: "⚖️", frequency: "daily_once", detail: "weight" },
  { id: "breakfast", label: "朝食を食べた", icon: "🍳", frequency: "daily_once", detail: "meal" },
  { id: "lunch", label: "昼食を食べた", icon: "🍙", frequency: "daily_once", detail: "meal" },
  { id: "veg", label: "野菜を先に", icon: "🥗", frequency: "daily_once", detail: "none" },
  { id: "water", label: "水を飲んだ", icon: "💧", frequency: "repeatable", detail: "none" },
  { id: "walk", label: "歩いた", icon: "👟", frequency: "repeatable", detail: "none" },
  { id: "stairs", label: "階段を使った", icon: "🪜", frequency: "repeatable", detail: "none" },
];
const MAJOR: Record<Band, string[]> = {
  morning: ["weight", "breakfast", "water"],
  noon: ["lunch", "walk", "stairs"],
  night: ["dinner", "nosnack", "weight"],
};
const NEXT_CANDIDATES = MAJOR; // 今日の一手: 大の並びの最初の、今日まだ記録していない行為

const FIXED_NEED = [50, 60, 80, 110, 140, 190];
function need(level: number): number {
  let n = FIXED_NEED[Math.min(level, 6) - 1];
  for (let l = 7; l <= level; l++) n = Math.round((n * 1.3) / 10) * 10;
  return n;
}
const MAX_LEVEL = 40;

interface Rec {
  id: string; actionId: string; date: string; cancelled: boolean;
  confirmPoints: number; activeSince: number; weight?: number;
}
interface UserState {
  total: number; records: Rec[]; ops: Map<string, unknown>; weights: Map<string, number>;
}
const users = new Map<string, UserState>();

const fmt = (d: Date) => d.toISOString().slice(0, 10);
function localNow(offsetMin: number): Date {
  return new Date(Date.now() + offsetMin * 60_000);
}
function bandOf(d: Date): Band {
  const h = d.getUTCHours();
  return h >= 4 && h < 10 ? "morning" : h >= 10 && h < 16 ? "noon" : "night";
}
function seed(): UserState {
  // 4 週ぶんの体重（ところどころ欠測）。65.6 から 64.7 へゆるやかに下がる流れ
  const weights = new Map<string, number>();
  const base = new Date();
  for (let i = 34; i >= 1; i--) {
    if (i % 4 === 0 || i % 7 === 3) continue;
    const d = new Date(base.getTime() - i * 86_400_000);
    weights.set(fmt(d), Math.round((64.7 + (i / 34) * 1.0 + (i % 3) * 0.2 - 0.2) * 10) / 10);
  }
  return { total: 30, records: [], ops: new Map(), weights };
}

function progressOf(total: number): Progress {
  let level = 1;
  let rest = total;
  while (level < MAX_LEVEL && rest >= need(level)) {
    rest -= need(level);
    level++;
  }
  const isMax = level >= MAX_LEVEL;
  const req = need(level);
  return {
    level,
    current_points: isMax ? req : rest,
    required_points: req,
    remaining_points: isMax ? 0 : req - rest,
    total_points: total,
    is_max: isMax,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
const err = (status: number, error: string, message: string, headers?: Record<string, string>) =>
  json(status, { error, message }, headers);

function activeRec(u: UserState, actionId: string, date: string): Rec | undefined {
  return u.records.filter((r) => r.actionId === actionId && r.date === date && !r.cancelled).at(-1);
}
function confirmStateOf(def: ActionDef, r: Rec | undefined): ConfirmState {
  if (def.detail === "none" || !r) return "none";
  return r.confirmPoints > 0 ? "done" : "open";
}
function actionState(u: UserState, def: ActionDef, date: string): ActionState {
  const active = u.records.filter((r) => r.actionId === def.id && r.date === date && !r.cancelled);
  const last = active.at(-1);
  return {
    id: def.id, label: def.label, icon: def.icon, frequency: def.frequency, detail: def.detail,
    done: active.length > 0, count: active.length, record_id: last?.id ?? null,
    confirm_state: confirmStateOf(def, last),
  };
}

function trendOf(u: UserState, today: string): Trend {
  const avgAt = (end: Date): number | null => {
    const vals: number[] = [];
    for (let i = 0; i < 7; i++) {
      const v = u.weights.get(fmt(new Date(end.getTime() - i * 86_400_000)));
      if (v !== undefined) vals.push(v);
    }
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  };
  const end = new Date(`${today}T00:00:00Z`);
  const days: TrendDay[] = [];
  for (let i = 27; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000);
    days.push({ date: fmt(d), avg_kg: avgAt(d) });
  }
  const cur = days[27].avg_kg;
  const old = days[0].avg_kg;
  return {
    days, current_avg_kg: cur, four_weeks_ago_avg_kg: old,
    diff_kg: cur !== null && old !== null ? Math.round((cur - old) * 10) / 10 : null,
  };
}

declare global {
  interface Window {
    /** 動作確認用: true にすると、次の書き込みが 429 rate_limited（Retry-After: 1）になる */
    __mockRateLimitOnce?: boolean;
    /** 動作確認用: "empty" で推移を空にする */
    __mockTrend?: "empty";
  }
}

export async function mockFetch(url: string, init: RequestInit = {}): Promise<Response> {
  await new Promise((r) => setTimeout(r, 120)); // 通信の間
  const method = (init.method ?? "GET").toUpperCase();
  const path = new URL(url, "http://mock.local").pathname;
  const headers = new Headers(init.headers);
  const auth = headers.get("Authorization") ?? "";
  if (path === "/health") return json(200, { status: "ok" });
  if (!auth.startsWith("Bearer ") || auth.length < 12) return err(401, "unauthorized", "ログインが必要です。");
  const off = Number(headers.get("X-Client-Tz-Offset"));
  if (!Number.isInteger(off) || off < -720 || off > 840) return err(400, "invalid_offset", "時差の値が正しくありません。");

  const key = auth.slice(7);
  let u = users.get(key);
  if (!u) { u = seed(); users.set(key, u); }
  const now = localNow(off);
  const today = fmt(now);
  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

  if (method !== "GET" && typeof window !== "undefined" && window.__mockRateLimitOnce) {
    window.__mockRateLimitOnce = false;
    return err(429, "rate_limited", "少し待ってね。", { "Retry-After": "1" });
  }

  if (method === "GET" && path === "/home") {
    const band = bandOf(now);
    const ids = MAJOR[band];
    const states = ACTIONS.map((d) => actionState(u, d, today));
    const major = ids.map((id) => states.find((s) => s.id === id)!);
    const minor = states.filter((s) => !ids.includes(s.id));
    const next = NEXT_CANDIDATES[band].find((id) => !states.find((s) => s.id === id)!.done) ?? null;
    const lastW = [...u.weights.entries()].sort(([a], [b]) => (a < b ? 1 : -1))[0]?.[1] ?? null;
    const home: Home = {
      progress: progressOf(u.total), local_date: today, band, major, minor,
      next_action_id: next, last_weight_kg: lastW,
    };
    return json(200, home);
  }

  if (method === "GET" && path === "/trend") {
    if (typeof window !== "undefined" && window.__mockTrend === "empty") {
      const days = trendOf({ ...u, weights: new Map() }, today);
      return json(200, days);
    }
    return json(200, trendOf(u, today));
  }

  if (method === "POST" && path === "/records") {
    const opId = String(body.op_id ?? "");
    const def = ACTIONS.find((a) => a.id === body.action_id);
    if (!opId) return err(400, "bad_request", "op_id が必要です。");
    if (!def) return err(404, "not_found", "その行為は見つかりません。");
    const replay = u.ops.get(opId);
    if (replay) return json(200, { ...(replay as object), reason: "replayed", level_up: null });
    const before = progressOf(u.total).level;
    let rec = activeRec(u, def.id, today);
    let reason: "granted" | "revived" | "already_recorded" = "granted";
    let granted = 0;
    if (def.frequency === "daily_once" && rec) {
      reason = "already_recorded";
    } else {
      const cancelled = def.frequency === "daily_once"
        ? u.records.filter((r) => r.actionId === def.id && r.date === today && r.cancelled).at(-1)
        : undefined;
      if (cancelled) {
        cancelled.cancelled = false; cancelled.activeSince = Date.now(); rec = cancelled; reason = "revived";
      } else {
        if (def.frequency === "repeatable" && u.records.filter((r) => r.date === today && !r.cancelled).length >= 600)
          return err(429, "daily_cap", "きょうは ここまで。また あした…！");
        rec = { id: crypto.randomUUID(), actionId: def.id, date: today, cancelled: false, confirmPoints: 0, activeSince: Date.now() };
        u.records.push(rec);
        u.total += 10; granted = 10;
      }
    }
    const progress = progressOf(u.total);
    const result = {
      record_id: rec!.id, reason, granted_points: granted, confirm_state: confirmStateOf(def, rec),
      progress, level_up: progress.level > before ? { before, after: progress.level } : null,
    };
    u.ops.set(opId, result);
    return json(200, result);
  }

  if (method === "POST" && path === "/me/reset") {
    const opId = String(body.op_id ?? "");
    if (!opId) return err(400, "bad_request", "op_id が必要です。");
    const prev = u.ops.get(`reset:${opId}`);
    if (prev) return json(200, { ...(prev as object), deleted: 0 });
    const deleted = u.records.length;
    u.records = []; u.total = 0; u.weights = new Map(); u.ops.clear();
    const result = { ...progressOf(0), deleted };
    u.ops.set(`reset:${opId}`, result);
    return json(200, result);
  }

  const m = /^\/records\/([^/]+)\/(confirm|cancel)$/.exec(path);
  if (m) {
    const rec = u.records.find((r) => r.id === m[1]);
    if (!rec) return err(404, "not_found", "その記録は見つかりません。");
    const def = ACTIONS.find((a) => a.id === rec.actionId)!;
    if (m[2] === "cancel" && method === "POST") {
      if (!rec.cancelled && Date.now() - rec.activeSince > 10 * 60_000)
        return err(409, "cancel_expired", "取り消せる時間を過ぎました。");
      rec.cancelled = true;
      return json(200, { record_id: rec.id, cancelled: true, progress: progressOf(u.total) });
    }
    if (m[2] === "confirm" && method === "PUT") {
      if (rec.cancelled) return err(409, "record_cancelled", "この記録は取り消されています。");
      if (def.detail === "weight") {
        const w = body.weight_kg;
        if (typeof w !== "number" || w < 20 || w > 300 || Math.abs(w * 10 - Math.round(w * 10)) > 1e-6)
          return err(400, "bad_detail", "体重は 20.0〜300.0 の、小数 1 桁で入れてください。");
        rec.weight = w; u.weights.set(rec.date, w);
      } else if (def.detail === "meal") {
        if (!["small", "normal", "large"].includes(String(body.portion)))
          return err(400, "bad_detail", "量を選んでください。");
      } else return err(400, "bad_detail", "この行為に確定はありません。");
      const before = progressOf(u.total).level;
      let granted = 0;
      if (rec.confirmPoints === 0) { rec.confirmPoints = 20; u.total += 20; granted = 20; }
      const progress = progressOf(u.total);
      return json(200, {
        record_id: rec.id, granted_points: granted, confirm_state: "done", progress,
        level_up: progress.level > before ? { before, after: progress.level } : null,
      });
    }
  }
  return err(404, "not_found", "見つかりません。");
}
